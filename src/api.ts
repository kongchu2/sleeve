export type Play = {
  played_at: number;
  track_id: string;
  track_name: string;
  artists: string;
  album_id: string;
  album_name: string;
  image_l: string | null;
  image_m: string | null;
  image_s: string | null;
  duration_ms: number;
  track_number: number | null;
  disc_number: number | null;
  album_total_tracks: number | null;
};

export type Track = {
  id: string;
  name: string;
  artists: string;
  album: string;
  imageL: string | null;
  imageM: string | null;
  imageS: string | null;
  durationMs: number;
};

export type Now = { isPlaying: boolean; progressMs: number; track: Track; receivedAt: number };

export type Lyrics = {
  synced: { t: number; text: string }[] | null;
  plain: string | null;
  instrumental: boolean;
};

export type Status = { configured: boolean; authed: boolean };

async function get<T>(url: string): Promise<T> {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`${url} → ${res.status}`);
  return (await res.json()) as T;
}

export type DaySummary = { day: string; album: string; image_m: string | null; image_s: string | null; plays: number; albums: number };

export type FullAlbum = { id: string; name: string; artists: string; image: string | null; tracks: number; times: number[] };

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

/** Day summaries for a range, grouped by the viewer's local date. */
export const getDays = (from: number, to: number) =>
  get<DaySummary[]>(`/api/days?from=${from}&to=${to}&tz=${-new Date(from).getTimezoneOffset()}`);

export type DayNotes = {
  streak: { album: string; days: number } | null;
  onThisDay: { year: number; day: string; album: string; artists: string; image_s: string | null; plays: number }[];
};

export type Recap = {
  plays: number;
  minutes: number;
  days: number;
  albums: number;
  fullAlbums: number;
  topAlbums: { id: string; name: string; artists: string; image_m: string | null; image_s: string | null; plays: number }[];
  topArtists: { name: string; plays: number }[];
  hours: number[];
  peakHour: number | null;
};

const tzOffset = (at: number) => -new Date(at).getTimezoneOffset();

/** Streak and "on this day" facts for a local date (YYYY-MM-DD). */
export const getDayNotes = (day: string) => get<DayNotes>(`/api/day-notes?day=${day}&tz=${tzOffset(Date.parse(day + 'T12:00:00'))}`);

export const getRecap = (from: number, to: number) => get<Recap>(`/api/recap?from=${from}&to=${to}&tz=${tzOffset(from)}`);

/** Distinct covers for the standby wall, most played first (see server/stats.ts `wallCovers`). */
export const getWall = (limit: number) => get<{ months: number; covers: string[] }>(`/api/wall?limit=${limit}`);

export const getFullAlbums = () => get<FullAlbum[]>('/api/full-albums');

export const getImportStatus = () => get<ImportStatus>('/api/import');

export async function postImport(entries: ImportEntry[]): Promise<void> {
  const res = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }) });
  if (!res.ok) throw new Error(`import upload failed: ${res.status}`);
}

export const getStatus = () => get<Status>('/api/status');

export const getPlays = (from: number, to: number) => get<Play[]>(`/api/plays?from=${from}&to=${to}`);

export async function getNow(): Promise<Now | null> {
  const now = await get<Omit<Now, 'receivedAt'> | null>('/api/now');
  return now ? { ...now, receivedAt: Date.now() } : null;
}

export const getLyrics = (t: Track) =>
  get<Lyrics>(
    '/api/lyrics?' +
      new URLSearchParams({ id: t.id, name: t.name, artists: t.artists, album: t.album, duration: String(t.durationMs) }),
  );

export async function control(action: 'play' | 'pause' | 'next' | 'previous' | 'seek', ms?: number) {
  const res = await fetch(`/api/player/${action}` + (ms === undefined ? '' : `?ms=${Math.round(ms)}`), { method: 'POST' });
  return (await res.json()) as { ok: boolean; status: number };
}
