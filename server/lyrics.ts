import { db } from './db.ts';

export type Lyrics = {
  synced: { t: number; text: string }[] | null;
  plain: string | null;
  instrumental: boolean;
};

type LrclibItem = {
  duration: number;
  instrumental: boolean;
  plainLyrics: string | null;
  syncedLyrics: string | null;
};

const BASE = 'https://lrclib.net/api';
const HEADERS = { 'User-Agent': 'sleeve/0.1 (personal project)' };
const MISS_TTL = 24 * 60 * 60 * 1000;
const NONE: Lyrics = { synced: null, plain: null, instrumental: false };

// Optional lyrics-sidecar (Spotify's own lyrics via librespot); see lyrics-sidecar/.
const SPOTIFY_LYRICS_URL = process.env.SPOTIFY_LYRICS_URL;

type SpotifyLyricsLine = { startTimeMs?: string; words?: string };
type SpotifyColorLyrics = { lyrics?: { syncType?: string; lines?: SpotifyLyricsLine[] } };

function toSpotifyLyrics(json: SpotifyColorLyrics): Lyrics | null {
  const lines = json.lyrics?.lines;
  if (!lines?.length) return null;
  const texts = lines.map((l) => (l.words ?? '').trim());
  const synced =
    json.lyrics?.syncType === 'LINE_SYNCED'
      ? lines
          .map((l, i) => ({ t: Number(l.startTimeMs) || 0, text: texts[i] }))
          .filter((l) => l.text && l.text !== '♪')
      : null;
  const body = texts.filter((t) => t && t !== '♪');
  if (!body.length) return null;
  return { synced: synced?.length ? synced : null, plain: body.join('\n'), instrumental: false };
}

/** Spotify's own lyrics for a track, or null when the sidecar is off, has none, or is unreachable. */
async function spotifyLyrics(trackId: string): Promise<Lyrics | null> {
  if (!SPOTIFY_LYRICS_URL) return null;
  try {
    const res = await fetch(`${SPOTIFY_LYRICS_URL}/lyrics?id=${encodeURIComponent(trackId)}`, {
      signal: AbortSignal.timeout(8000),
    });
    if (res.status === 404) return NONE; // Spotify answered: no lyrics for this track.
    if (!res.ok) return null; // sidecar down or erroring: leave it to LRCLIB, do not cache.
    return toSpotifyLyrics((await res.json()) as SpotifyColorLyrics);
  } catch {
    return null;
  }
}

function parseLrc(lrc: string): { t: number; text: string }[] {
  const out: { t: number; text: string }[] = [];
  for (const raw of lrc.split('\n')) {
    const m = raw.match(/^\[(\d+):(\d+(?:\.\d+)?)\]\s*(.*)$/);
    if (!m) continue;
    const text = m[3].trim();
    if (!text) continue;
    out.push({ t: Math.round((Number(m[1]) * 60 + Number(m[2])) * 1000), text });
  }
  return out;
}

function toLyrics(item: LrclibItem): Lyrics {
  const synced = item.syncedLyrics ? parseLrc(item.syncedLyrics) : [];
  return {
    synced: synced.length ? synced : null,
    plain: item.plainLyrics || null,
    instrumental: Boolean(item.instrumental),
  };
}

async function fetchLyrics(name: string, artist: string, album: string, durationMs: number): Promise<Lyrics> {
  const seconds = Math.round(durationMs / 1000);
  const exact = await fetch(
    `${BASE}/get?` + new URLSearchParams({ track_name: name, artist_name: artist, album_name: album, duration: String(seconds) }),
    { headers: HEADERS },
  );
  if (exact.ok) return toLyrics((await exact.json()) as LrclibItem);

  // Album titles and durations often differ slightly between services: fall back to search.
  const search = await fetch(`${BASE}/search?` + new URLSearchParams({ track_name: name, artist_name: artist }), {
    headers: HEADERS,
  });
  if (!search.ok) return NONE;
  const items = ((await search.json()) as LrclibItem[]).filter((i) => Math.abs(i.duration - seconds) <= 4);
  if (!items.length) return NONE;
  items.sort(
    (a, b) =>
      Number(Boolean(b.syncedLyrics)) - Number(Boolean(a.syncedLyrics)) ||
      Math.abs(a.duration - seconds) - Math.abs(b.duration - seconds),
  );
  return toLyrics(items[0]);
}

export async function getLyrics(
  trackId: string,
  name: string,
  artists: string,
  album: string,
  durationMs: number,
  /** False for podcast episodes: they are shown, never stored. */
  store = true,
): Promise<Lyrics> {
  if (store) {
    const row = db.prepare('SELECT body, fetched_at FROM lyrics WHERE track_id = ?').get(trackId) as
      | { body: string; fetched_at: number }
      | undefined;
    if (row) {
      const cached = JSON.parse(row.body) as Lyrics;
      const found = cached.synced || cached.plain || cached.instrumental;
      if (found || Date.now() - row.fetched_at < MISS_TTL) return cached;
    }
  }
  // Spotify's own lyrics first (usually line-synced), then LRCLIB.
  const spotify = await spotifyLyrics(trackId);
  const lyrics =
    spotify && (spotify.synced || spotify.plain)
      ? spotify
      : await fetchLyrics(name, artists.split(', ')[0], album, durationMs);
  if (store) {
    db.prepare(
      'INSERT INTO lyrics (track_id, body, fetched_at) VALUES (?, ?, ?) ON CONFLICT(track_id) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at',
    ).run(trackId, JSON.stringify(lyrics), Date.now());
  }
  return lyrics;
}
