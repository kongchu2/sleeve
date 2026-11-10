import { randomBytes } from 'node:crypto';
import { db, kvDelete, kvGet, kvSet } from './db.ts';

const PORT = process.env.PORT ?? '8787';
const CLIENT_ID = process.env.SPOTIFY_CLIENT_ID ?? '';
const CLIENT_SECRET = process.env.SPOTIFY_CLIENT_SECRET ?? '';
const REDIRECT_URI = process.env.SPOTIFY_REDIRECT_URI ?? `http://127.0.0.1:${PORT}/auth/callback`;
const SCOPES = [
  'user-read-recently-played',
  'user-read-currently-playing',
  'user-read-playback-state',
  'user-modify-playback-state',
].join(' ');

type Tokens = { access_token: string; refresh_token: string; expires_at: number };
type SpotifyImage = { url: string; width: number | null };
type SpotifyTrack = {
  id: string | null;
  type?: string;
  name: string;
  duration_ms: number;
  track_number?: number;
  disc_number?: number;
  artists: { name: string }[];
  album: { id: string | null; name: string; images: SpotifyImage[]; total_tracks?: number };
};

export type TrackInfo = {
  id: string;
  name: string;
  artists: string;
  album: string;
  imageL: string | null;
  imageM: string | null;
  imageS: string | null;
  durationMs: number;
};

export const isConfigured = () => Boolean(CLIENT_ID && CLIENT_SECRET);
export const isAuthed = () => kvGet<Tokens>('tokens') !== null;

const pendingStates = new Set<string>();

export function loginUrl(): string {
  const state = randomBytes(16).toString('hex');
  pendingStates.add(state);
  const q = new URLSearchParams({
    response_type: 'code',
    client_id: CLIENT_ID,
    scope: SCOPES,
    redirect_uri: REDIRECT_URI,
    state,
  });
  return 'https://accounts.spotify.com/authorize?' + q;
}

async function tokenRequest(body: Record<string, string>): Promise<Tokens> {
  const res = await fetch('https://accounts.spotify.com/api/token', {
    method: 'POST',
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Authorization: 'Basic ' + Buffer.from(CLIENT_ID + ':' + CLIENT_SECRET).toString('base64'),
    },
    body: new URLSearchParams(body),
  });
  if (!res.ok) throw new Error(`Spotify token request failed: ${res.status} ${await res.text()}`);
  const json = (await res.json()) as { access_token: string; refresh_token?: string; expires_in: number };
  const tokens: Tokens = {
    access_token: json.access_token,
    refresh_token: json.refresh_token ?? body.refresh_token,
    expires_at: Date.now() + json.expires_in * 1000,
  };
  kvSet('tokens', tokens);
  return tokens;
}

export async function exchangeCode(code: string, state: string): Promise<void> {
  if (!pendingStates.delete(state)) throw new Error('Unknown OAuth state');
  await tokenRequest({ grant_type: 'authorization_code', code, redirect_uri: REDIRECT_URI });
}

export function logout(): void {
  kvDelete('tokens');
}

async function accessToken(force = false): Promise<string> {
  const tokens = kvGet<Tokens>('tokens');
  if (!tokens) throw new Error('Not connected to Spotify');
  if (!force && tokens.expires_at - Date.now() > 60_000) return tokens.access_token;
  return (await tokenRequest({ grant_type: 'refresh_token', refresh_token: tokens.refresh_token })).access_token;
}

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  const call = async (token: string) =>
    fetch('https://api.spotify.com/v1' + path, { ...init, headers: { ...init.headers, Authorization: 'Bearer ' + token } });
  let res = await call(await accessToken());
  if (res.status === 401) res = await call(await accessToken(true));
  return res;
}

function pickImages(images: SpotifyImage[]) {
  // Spotify returns images largest first (typically 640 / 300 / 64).
  const sorted = [...images].sort((a, b) => (b.width ?? 0) - (a.width ?? 0));
  return {
    imageL: sorted[0]?.url ?? null,
    imageM: sorted[Math.min(1, sorted.length - 1)]?.url ?? null,
    imageS: sorted[sorted.length - 1]?.url ?? null,
  };
}

function toTrackInfo(t: SpotifyTrack): TrackInfo | null {
  if (!t.id) return null; // local files have no id
  return {
    id: t.id,
    name: t.name,
    artists: t.artists.map((a) => a.name).join(', '),
    album: t.album.name,
    durationMs: t.duration_ms,
    ...pickImages(t.album.images),
  };
}

/** Pull the latest plays into the database. Spotify only exposes the last 50. */
export async function syncRecent(): Promise<number> {
  const res = await api('/me/player/recently-played?limit=50');
  if (!res.ok) throw new Error(`recently-played failed: ${res.status}`);
  const json = (await res.json()) as { items: { played_at: string; track: SpotifyTrack }[] };
  const insert = db.prepare(
    `INSERT OR IGNORE INTO plays
     (played_at, track_id, track_name, artists, album_id, album_name, image_l, image_m, image_s, duration_ms,
      track_number, disc_number, album_total_tracks)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  let added = 0;
  for (const item of json.items) {
    const t = toTrackInfo(item.track);
    if (!t) continue;
    const r = insert.run(
      Date.parse(item.played_at),
      t.id,
      t.name,
      t.artists,
      item.track.album.id ?? t.album,
      t.album,
      t.imageL,
      t.imageM,
      t.imageS,
      t.durationMs,
      item.track.track_number ?? null,
      item.track.disc_number ?? null,
      item.track.album.total_tracks ?? null,
    );
    added += Number(r.changes);
  }
  return added;
}

/**
 * Fill in track number / album size for plays stored before those columns existed.
 * Tracks Spotify no longer knows are marked with 0 so they are not retried forever.
 */
export async function backfillTrackMeta(): Promise<number> {
  const ids = (db.prepare('SELECT DISTINCT track_id FROM plays WHERE album_total_tracks IS NULL').all() as { track_id: string }[]).map(
    (r) => r.track_id,
  );
  if (!ids.length) return 0;
  const update = db.prepare('UPDATE plays SET track_number = ?, disc_number = ?, album_total_tracks = ? WHERE track_id = ?');
  const store = (id: string, t: SpotifyTrack | null) =>
    update.run(t?.track_number ?? 0, t?.disc_number ?? 0, t?.album.total_tracks ?? 0, id);

  let filled = 0;
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    const batch = await api('/tracks?ids=' + chunk.join(','));
    if (batch.ok) {
      const { tracks } = (await batch.json()) as { tracks: (SpotifyTrack | null)[] };
      chunk.forEach((id, k) => store(id, tracks[k] ?? null));
      filled += chunk.length;
      continue;
    }
    // The batch endpoint is not available to every app: fall back to one request per track.
    for (const id of chunk) {
      const one = await api('/tracks/' + id);
      if (one.ok) store(id, (await one.json()) as SpotifyTrack);
      else if (one.status === 404) store(id, null);
      else throw new Error(`track lookup failed: ${one.status}`);
      filled += 1;
    }
  }
  return filled;
}

export async function nowPlaying(): Promise<{ isPlaying: boolean; progressMs: number; track: TrackInfo } | null> {
  const res = await api('/me/player/currently-playing');
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`currently-playing failed: ${res.status}`);
  const json = (await res.json()) as { is_playing: boolean; progress_ms: number | null; item: SpotifyTrack | null };
  if (!json.item || (json.item.type && json.item.type !== 'track')) return null;
  const track = toTrackInfo(json.item);
  if (!track) return null;
  return { isPlaying: json.is_playing, progressMs: json.progress_ms ?? 0, track };
}

const CONTROLS: Record<string, { method: string; path: string }> = {
  play: { method: 'PUT', path: '/me/player/play' },
  pause: { method: 'PUT', path: '/me/player/pause' },
  next: { method: 'POST', path: '/me/player/next' },
  previous: { method: 'POST', path: '/me/player/previous' },
};

/** Playback control. Spotify answers 403 for non-Premium accounts. */
export async function control(action: string, positionMs?: number): Promise<number> {
  if (action === 'seek') {
    const ms = Math.max(0, Math.round(positionMs ?? 0));
    return (await api('/me/player/seek?position_ms=' + ms, { method: 'PUT' })).status;
  }
  const c = CONTROLS[action];
  if (!c) return 400;
  return (await api(c.path, { method: c.method })).status;
}
