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
