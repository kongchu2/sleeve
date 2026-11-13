export type Play = {
  played_at: number;
  track_id: string;
  track_name: string;
  artists: string;
  album_id: string;
  album_name: string;
  image_m: string | null;
  image_s: string | null;
  duration_ms: number;
};

export type Track = {
  /** Podcast episodes appear only as now playing, never in the history. */
  kind: 'track' | 'episode';
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

export type ImportEntry = { ts: number; id: string; ms: number; name: string; artist: string; album: string };

/** `coverlessTracks`: imported tracks whose artwork is still being looked up in the background. */
export type ImportStatus = { coverlessTracks: number };

export type ImportResult = { added: number; skipped: number };

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

export const getImportStatus = () => get<ImportStatus>('/api/import');

export async function postImport(entries: ImportEntry[]): Promise<ImportResult> {
  const res = await fetch('/api/import', { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify({ entries }) });
  if (!res.ok) throw new Error(`import upload failed: ${res.status}`);
  return (await res.json()) as ImportResult;
}

export const getStatus = () => get<Status>('/api/status');

export const getPlays = (from: number, to: number) => get<Play[]>(`/api/plays?from=${from}&to=${to}`);

/** `nowView`: the caller is the Now Playing view, which the server keeps more up to date. */
export async function getNow(nowView: boolean): Promise<Now | null> {
  const sent = Date.now();
  const now = await get<Omit<Now, 'receivedAt'> | null>('/api/now' + (nowView ? '?view=now' : ''));
  const receivedAt = Date.now();
  if (!now) return null;
  // The server advanced the position to when it answered, about half the round trip ago.
  const lag = now.isPlaying ? Math.min((receivedAt - sent) / 2, 1_000) : 0;
  return { ...now, progressMs: Math.min(now.progressMs + lag, now.track.durationMs), receivedAt };
}

export const getLyrics = (t: Track) =>
  get<Lyrics>(
    '/api/lyrics?' +
      new URLSearchParams({ id: t.id, name: t.name, artists: t.artists, album: t.album, duration: String(t.durationMs), kind: t.kind }),
  );
