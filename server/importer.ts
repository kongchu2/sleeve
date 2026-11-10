import { db } from './db.ts';
import { fetchTracks, toTrackInfo, type SpotifyTrack } from './spotify.ts';

/**
 * Imports plays from Spotify's "Extended streaming history" export.
 * The export has no artwork, album ids or durations, so every track is looked up
 * through the Web API first; that can take a while for years of history, so it
 * runs as a background job whose progress the web app polls.
 */
export type ImportEntry = { ts: number; id: string; ms: number; name: string; artist: string; album: string };

export type ImportStatus = {
  state: 'idle' | 'running' | 'done' | 'error';
  received: number;
  processed: number;
  tracksTotal: number;
  tracksDone: number;
  added: number;
  skipped: number;
  error: string | null;
};

/** Spotify itself only counts a stream after 30 seconds. */
const MIN_PLAYED_MS = 30_000;
/** A play this close to an existing one of the same track is the same play (collected live, or imported before). */
const SAME_PLAY_WINDOW_MS = 25_000;

const status: ImportStatus = { state: 'idle', received: 0, processed: 0, tracksTotal: 0, tracksDone: 0, added: 0, skipped: 0, error: null };
const queue: ImportEntry[] = [];
const known = new Map<string, SpotifyTrack | null>();

export const importStatus = (): ImportStatus => ({ ...status });

function isEntry(e: unknown): e is ImportEntry {
  const x = e as ImportEntry;
  return !!x && Number.isFinite(x.ts) && typeof x.id === 'string' && /^[A-Za-z0-9]{22}$/.test(x.id) && Number.isFinite(x.ms);
}

/** Add entries to the job; starts it if it is not already running. Returns how many were accepted. */
export function enqueueImport(entries: unknown[]): number {
  const valid = entries.filter(isEntry).filter((e) => e.ms >= MIN_PLAYED_MS);
  if (status.state !== 'running') {
    Object.assign(status, { state: 'running', received: 0, processed: 0, tracksTotal: 0, tracksDone: 0, added: 0, skipped: 0, error: null });
    queue.length = 0;
    void run();
  }
  queue.push(...valid);
  status.received += valid.length;
  return valid.length;
}

async function run() {
  // Let the caller finish queueing the first batch.
  await new Promise((r) => setTimeout(r, 0));
  try {
    while (queue.length) {
      const batch = queue.splice(0, queue.length);
      const unknown = [...new Set(batch.map((e) => e.id))].filter((id) => !known.has(id));
      status.tracksTotal += unknown.length;
      const base = status.tracksDone;
      for (const [id, track] of await fetchTracks(unknown, (done) => { status.tracksDone = base + done; })) known.set(id, track);
      status.tracksDone = base + unknown.length;
      insert(batch);
    }
    status.state = 'done';
  } catch (err) {
    status.state = 'error';
    status.error = err instanceof Error ? err.message : String(err);
    console.error('[import]', status.error);
  }
}

function insert(batch: ImportEntry[]) {
  const samePlay = db.prepare('SELECT 1 FROM plays WHERE track_id = ? AND played_at BETWEEN ? AND ? LIMIT 1');
  const taken = db.prepare('SELECT 1 FROM plays WHERE played_at = ?');
  const add = db.prepare(
    `INSERT INTO plays (played_at, track_id, track_name, artists, album_id, album_name, image_l, image_m, image_s,
                        duration_ms, track_number, disc_number, album_total_tracks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  db.exec('BEGIN');
  try {
    for (const e of batch.sort((a, b) => a.ts - b.ts)) {
      status.processed += 1;
      if (samePlay.get(e.id, e.ts - SAME_PLAY_WINDOW_MS, e.ts + SAME_PLAY_WINDOW_MS)) {
        status.skipped += 1;
        continue;
      }
      // played_at is the primary key: nudge past another track that ended in the same instant.
      let at = e.ts;
      while (taken.get(at)) at += 1;
      const track = known.get(e.id) ?? null;
      const info = track && toTrackInfo(track);
      if (track && info) {
        add.run(at, e.id, info.name, info.artists, track.album.id ?? info.album, info.album, info.imageL, info.imageM, info.imageS,
          info.durationMs, track.track_number ?? 0, track.disc_number ?? 0, track.album.total_tracks ?? 0);
      } else {
        // Spotify no longer has this track: keep what the export says about it.
        add.run(at, e.id, e.name || 'Unknown track', e.artist || 'Unknown artist', 'export:' + (e.album || e.id), e.album || 'Unknown album',
          null, null, null, e.ms, 0, 0, 0);
      }
      status.added += 1;
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}
