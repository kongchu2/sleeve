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
const HEADERS = { 'User-Agent': 'listening-calendar/0.1 (personal project)' };
const MISS_TTL = 24 * 60 * 60 * 1000;
const NONE: Lyrics = { synced: null, plain: null, instrumental: false };

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
): Promise<Lyrics> {
  const row = db.prepare('SELECT body, fetched_at FROM lyrics WHERE track_id = ?').get(trackId) as
    | { body: string; fetched_at: number }
    | undefined;
  if (row) {
    const cached = JSON.parse(row.body) as Lyrics;
    const found = cached.synced || cached.plain || cached.instrumental;
    if (found || Date.now() - row.fetched_at < MISS_TTL) return cached;
  }
  const lyrics = await fetchLyrics(name, artists.split(', ')[0], album, durationMs);
  db.prepare(
    'INSERT INTO lyrics (track_id, body, fetched_at) VALUES (?, ?, ?) ON CONFLICT(track_id) DO UPDATE SET body = excluded.body, fetched_at = excluded.fetched_at',
  ).run(trackId, JSON.stringify(lyrics), Date.now());
  return lyrics;
}
