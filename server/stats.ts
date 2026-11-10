import { db } from './db.ts';

/** SQL expression for a play's local calendar day; bind the viewer's UTC offset in seconds. */
const DAY = "strftime('%Y-%m-%d', played_at / 1000 + ?, 'unixepoch')";
const MIN_FULL_ALBUM_TRACKS = 4;

type PlayRow = {
  played_at: number;
  track_id: string;
  album_id: string;
  album_name: string;
  artists: string;
  image_m: string | null;
  image_s: string | null;
  duration_ms: number;
  album_total_tracks: number | null;
};

const ROW_COLUMNS = 'played_at, track_id, album_id, album_name, artists, image_m, image_s, duration_ms, album_total_tracks';

/** [start, end) of a local calendar day in epoch ms. `tz` is the viewer's UTC offset in minutes. */
function dayRange(year: number, month: number, day: number, tz: number): [number, number] {
  const start = Date.UTC(year, month - 1, day) - tz * 60_000;
  return [start, start + 86_400_000];
}

/**
 * Runs where every track of an album was played without another album in between
 * (any order, repeats allowed). Same rule as the calendar badge in src/Calendar.tsx.
 * `rows` must be ordered by played_at.
 */
export function fullAlbumRuns(rows: PlayRow[]): PlayRow[] {
  const runs: PlayRow[] = [];
  let start = 0;
  for (let i = 1; i <= rows.length; i++) {
    if (i < rows.length && rows[i].album_id === rows[start].album_id) continue;
    const total = rows[start].album_total_tracks ?? 0;
    if (total >= MIN_FULL_ALBUM_TRACKS && new Set(rows.slice(start, i).map((r) => r.track_id)).size >= total) runs.push(rows[start]);
    start = i;
  }
  return runs;
}

export function fullAlbums() {
  const rows = db.prepare(`SELECT ${ROW_COLUMNS} FROM plays ORDER BY played_at`).all() as PlayRow[];
  const albums = new Map<string, { id: string; name: string; artists: string; image: string | null; tracks: number; times: number[] }>();
  for (const run of fullAlbumRuns(rows)) {
    const entry = albums.get(run.album_id) ?? {
      id: run.album_id, name: run.album_name, artists: run.artists, image: run.image_m, tracks: run.album_total_tracks ?? 0, times: [],
    };
    entry.times.push(run.played_at);
    albums.set(run.album_id, entry);
  }
  return [...albums.values()].sort((a, b) => b.times[b.times.length - 1] - a.times[a.times.length - 1]);
}

type TopAlbum = { album_id: string; album_name: string; artists: string; image_s: string | null; n: number };

function topAlbumBetween(from: number, to: number): TopAlbum | undefined {
  return db
    .prepare(
      `SELECT album_id, album_name, max(artists) AS artists, max(image_s) AS image_s, count(*) AS n
       FROM plays WHERE played_at >= ? AND played_at < ? GROUP BY album_id ORDER BY n DESC LIMIT 1`,
    )
    .get(from, to) as TopAlbum | undefined;
}

/**
 * Small facts about one day: how many days in a row its top album has been played,
 * and what was on top on the same date in earlier years.
 */
export function dayNotes(day: string, tz: number) {
  const [y, m, d] = day.split('-').map(Number);
  const [from, to] = dayRange(y, m, d, tz);
  const top = topAlbumBetween(from, to);

  let streak: { album: string; days: number } | null = null;
  if (top) {
    const days = (
      db.prepare(`SELECT DISTINCT ${DAY} AS day FROM plays WHERE album_id = ? AND played_at < ? ORDER BY day DESC LIMIT 400`)
        .all(tz * 60, top.album_id, to) as { day: string }[]
    ).map((r) => r.day);
    let count = 0;
    for (let cursor = Date.UTC(y, m - 1, d); days[count] === new Date(cursor).toISOString().slice(0, 10); cursor -= 86_400_000) count += 1;
    if (count >= 2) streak = { album: top.album_name, days: count };
  }

  const onThisDay: { year: number; day: string; album: string; artists: string; image_s: string | null; plays: number }[] = [];
  for (let back = 1; back <= 15; back++) {
    const date = new Date(Date.UTC(y - back, m - 1, d));
    if (date.getUTCMonth() !== m - 1) continue; // Feb 29 in a non-leap year
    const [f, t] = dayRange(y - back, m, d, tz);
    const past = topAlbumBetween(f, t);
    if (past) onThisDay.push({ year: y - back, day: date.toISOString().slice(0, 10), album: past.album_name, artists: past.artists, image_s: past.image_s, plays: past.n });
  }
  return { streak, onThisDay };
}

/** Everything the month recap shows, for an arbitrary range. */
export function recap(from: number, to: number, tz: number) {
  const rows = db.prepare(`SELECT ${ROW_COLUMNS} FROM plays WHERE played_at >= ? AND played_at < ? ORDER BY played_at`).all(from, to) as PlayRow[];
  const albums = new Map<string, { id: string; name: string; artists: string; image_m: string | null; image_s: string | null; plays: number }>();
  const artists = new Map<string, number>();
  const days = new Set<string>();
  const hours: number[] = Array(24).fill(0);
  let ms = 0;
  for (const r of rows) {
    const local = new Date(r.played_at + tz * 60_000);
    days.add(local.toISOString().slice(0, 10));
    hours[local.getUTCHours()] += 1;
    ms += r.duration_ms;
    const album = albums.get(r.album_id) ?? { id: r.album_id, name: r.album_name, artists: r.artists, image_m: r.image_m, image_s: r.image_s, plays: 0 };
    album.plays += 1;
    albums.set(r.album_id, album);
    const artist = r.artists.split(', ')[0];
    artists.set(artist, (artists.get(artist) ?? 0) + 1);
  }
  const fulls = fullAlbumRuns(rows);
  return {
    plays: rows.length,
    minutes: Math.round(ms / 60_000),
    days: days.size,
    albums: albums.size,
    fullAlbums: fulls.length,
    topAlbums: [...albums.values()].sort((a, b) => b.plays - a.plays).slice(0, 5),
    topArtists: [...artists].sort((a, b) => b[1] - a[1]).slice(0, 3).map(([name, plays]) => ({ name, plays })),
    hours,
    peakHour: rows.length ? hours.indexOf(Math.max(...hours)) : null,
  };
}
