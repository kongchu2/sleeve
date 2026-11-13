import { db } from './db.ts';

/**
 * Imports plays from Spotify's "Extended streaming history" export.
 *
 * The export has no artwork or album ids, and years of history hold tens of thousands of tracks: looking
 * them all up through the Web API takes days at a pace Spotify tolerates, and any faster earns a
 * rate-limit ban that also stops live collection. So nothing here calls the Web API. Plays go in straight
 * away with what the export says about them, under an album id of `export:<artist> — <album>`, and
 * `coverImported` then finds their artwork through Spotify's public oEmbed endpoint, which needs no token.
 */
export type ImportEntry = { ts: number; id: string; ms: number; name: string; artist: string; album: string };

/** Spotify itself only counts a stream after 30 seconds. */
const MIN_PLAYED_MS = 30_000;
/** A play this close to an existing one of the same track is the same play (collected live, or imported before). */
const SAME_PLAY_WINDOW_MS = 25_000;
/** Pause between oEmbed requests. */
const COVER_PACE_MS = 1_000;

const IMPORTED = "album_id LIKE 'export:%'";

// Tracks Spotify no longer has: there is no cover to find, so they are not asked about again.
db.exec('CREATE TABLE IF NOT EXISTS cover_gone (track_id TEXT PRIMARY KEY)');
const COVERLESS = `${IMPORTED} AND image_m IS NULL AND track_id NOT IN (SELECT track_id FROM cover_gone)`;

function isEntry(e: unknown): e is ImportEntry {
  const x = e as ImportEntry;
  return !!x && Number.isFinite(x.ts) && typeof x.id === 'string' && /^[A-Za-z0-9]{22}$/.test(x.id) && Number.isFinite(x.ms);
}

/** How many imported tracks are still waiting for their artwork. */
export const coverlessTracks = (): number =>
  (db.prepare(`SELECT COUNT(DISTINCT track_id) AS n FROM plays WHERE ${COVERLESS}`).get() as { n: number }).n;

/** Bring rows written by earlier versions of the importer to the current shape. Safe to run on every start. */
export function settleImported(): void {
  // Once waited for a Web API lookup that no longer exists.
  db.exec("UPDATE plays SET album_id = 'export:' || substr(album_id, 9) WHERE album_id LIKE 'pending:%'");
  // Keyed by album name alone, which merged different artists' albums of the same name.
  db.exec("UPDATE plays SET album_id = 'export:' || artists || ' — ' || album_name WHERE album_id = 'export:' || album_name");
}

type KnownRow = {
  track_name: string; artists: string; album_id: string; album_name: string;
  image_l: string | null; image_m: string | null; image_s: string | null;
  duration_ms: number; track_number: number | null; disc_number: number | null; album_total_tracks: number | null;
};

/**
 * Insert a batch of export entries. Plays already in the log are skipped, so importing a file twice is
 * harmless; an imported play met again has its listened time refreshed from the export.
 */
export function importEntries(entries: unknown[]): { added: number; skipped: number } {
  const batch = entries.filter(isEntry).filter((e) => e.ms >= MIN_PLAYED_MS).sort((a, b) => a.ts - b.ts);
  const samePlay = db.prepare('SELECT 1 FROM plays WHERE track_id = ? AND played_at BETWEEN ? AND ? LIMIT 1');
  const refresh = db.prepare(`UPDATE plays SET duration_ms = ? WHERE track_id = ? AND played_at BETWEEN ? AND ? AND ${IMPORTED}`);
  const taken = db.prepare('SELECT 1 FROM plays WHERE played_at = ?');
  // A track already in the log is copied from there, preferring a play collected live (it has the real album).
  const knownTrack = db.prepare(
    `SELECT track_name, artists, album_id, album_name, image_l, image_m, image_s, duration_ms, track_number, disc_number, album_total_tracks
     FROM plays WHERE track_id = ? ORDER BY ${IMPORTED}, image_m IS NULL LIMIT 1`,
  );
  const add = db.prepare(
    `INSERT INTO plays (played_at, track_id, track_name, artists, album_id, album_name, image_l, image_m, image_s,
                        duration_ms, track_number, disc_number, album_total_tracks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  let skipped = 0;
  // IMMEDIATE: the worker writes to the same database, and a transaction that starts by reading cannot
  // wait its turn to write later; it fails instead.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const e of batch) {
      const from = e.ts - SAME_PLAY_WINDOW_MS;
      const to = e.ts + SAME_PLAY_WINDOW_MS;
      if (samePlay.get(e.id, from, to)) {
        refresh.run(e.ms, e.id, from, to);
        skipped += 1;
        continue;
      }
      // played_at is the primary key: nudge past another track that ended in the same instant.
      let at = e.ts;
      while (taken.get(at)) at += 1;
      const k = knownTrack.get(e.id) as KnownRow | undefined;
      if (k) {
        // A live play knows the track's real length; another imported play only knows how long *it* was listened to.
        const ms = k.album_id.startsWith('export:') ? e.ms : k.duration_ms;
        add.run(at, e.id, k.track_name, k.artists, k.album_id, k.album_name, k.image_l, k.image_m, k.image_s,
          ms, k.track_number ?? 0, k.disc_number ?? 0, k.album_total_tracks ?? 0);
      } else {
        const artist = e.artist || 'Unknown artist';
        add.run(at, e.id, e.name || 'Unknown track', artist, e.album ? `export:${artist} — ${e.album}` : 'export:' + e.id, e.album || 'Unknown album',
          null, null, null, e.ms, 0, 0, 0);
      }
      added += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return { added, skipped };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

/** Spotify's image ids start with a size code; the same picture exists under each of them. */
function coverSizes(url: string): { l: string; m: string; s: string } {
  const m = url.match(/^(.*\/image\/ab67616d0000)[0-9a-f]{4}([0-9a-f]{24})$/);
  return m ? { l: `${m[1]}b273${m[2]}`, m: `${m[1]}1e02${m[2]}`, s: `${m[1]}4851${m[2]}` } : { l: url, m: url, s: url };
}

/**
 * Give imported plays their artwork from the public oEmbed endpoint, most played first. One answer
 * covers every coverless play of that album. Never returns.
 */
export async function coverImported(): Promise<never> {
  const queue = db.prepare(`SELECT track_id, album_name, artists FROM plays WHERE ${COVERLESS} GROUP BY track_id ORDER BY COUNT(*) DESC`);
  const still = db.prepare(`SELECT 1 FROM plays WHERE track_id = ? AND ${COVERLESS} LIMIT 1`);
  const set = db.prepare(
    `UPDATE plays SET image_l = ?, image_m = ?, image_s = ?
     WHERE ${IMPORTED} AND image_m IS NULL AND (track_id = ? OR (album_name = ? AND artists = ?))`,
  );
  const gone = db.prepare('INSERT OR IGNORE INTO cover_gone (track_id) VALUES (?)');
  let troubles = 0;
  for (;;) {
    // One pass over what is coverless now; an earlier answer in the pass may already have covered a later track.
    const rows = queue.all() as { track_id: string; album_name: string; artists: string }[];
    let found = 0;
    for (const row of rows) {
      if (!still.get(row.track_id)) continue;
      try {
        const res = await fetch('https://open.spotify.com/oembed?url=spotify:track:' + row.track_id);
        const url = res.ok ? ((await res.json()) as { thumbnail_url?: string }).thumbnail_url : undefined;
        if (url) {
          const { l, m, s } = coverSizes(url);
          set.run(l, m, s, row.track_id, row.album_name, row.artists);
          found += 1;
          troubles = 0;
          if (found % 500 === 0) console.log(`[import] ${found} covers found this pass`);
        } else if (res.ok || res.status === 404) {
          // Answered, but without a picture: Spotify does this for ids it has since retired.
          gone.run(row.track_id);
          troubles = 0;
        } else {
          // Anything else says nothing about this track (throttling, an outage, a block): leave it for the
          // next pass, and stop asking for a while once it keeps happening.
          troubles += 1;
          if (troubles >= 3) {
            const wait = Math.min(Math.max(Number(res.headers.get('retry-after')) || 300, 60), 3600);
            console.warn(`[import] cover lookups keep failing (${res.status}): pausing ${wait}s`);
            await sleep(wait * 1000);
          }
        }
      } catch (err) {
        console.error('[import] cover lookup:', err instanceof Error ? err.message : err);
        await sleep(60_000);
      }
      await sleep(COVER_PACE_MS);
    }
    if (found) console.log(`[import] cover pass done: ${found} found, ${coverlessTracks()} tracks left`);
    await sleep(found ? 5_000 : 10 * 60_000);
  }
}
