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
].join(' ');

type Tokens = { access_token: string; refresh_token: string; expires_at: number };
type SpotifyImage = { url: string; width: number | null };
export type SpotifyTrack = {
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

// Spotify answers 429 with a Retry-After that can run to hours, and calling again meanwhile only risks a
// longer ban. Once limited, every request is answered locally with the same 429 until that time has passed.
let blockedUntil = 0;

/** Seconds until Spotify accepts requests again; 0 when not rate limited. */
export const rateLimitedFor = () => Math.max(0, Math.ceil((blockedUntil - Date.now()) / 1000));

async function api(path: string, init: RequestInit = {}): Promise<Response> {
  if (rateLimitedFor() > 0) return new Response(null, { status: 429, headers: { 'retry-after': String(rateLimitedFor()) } });
  const call = async (token: string) =>
    fetch('https://api.spotify.com/v1' + path, { ...init, headers: { ...init.headers, Authorization: 'Bearer ' + token } });
  let res = await call(await accessToken());
  if (res.status === 401) res = await call(await accessToken(true));
  if (res.status === 429) {
    const wait = Number(res.headers.get('retry-after')) || 5;
    blockedUntil = Date.now() + wait * 1000;
    console.warn(`[spotify] rate limited: no requests for ${wait}s`);
  }
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

export function toTrackInfo(t: SpotifyTrack): TrackInfo | null {
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

/** Like `api`, but waits out rate limiting (429 + Retry-After) instead of failing. */
async function apiPatient(path: string): Promise<Response> {
  for (let attempt = 0; ; attempt++) {
    const res = await api(path);
    if (res.status !== 429 || attempt >= 8) return res;
    if (Number(res.headers.get('retry-after')) > 120) return res; // a long ban: give up rather than sit in a loop
    const wait = Math.min(Number(res.headers.get('retry-after')) || 2, 120);
    await new Promise((r) => setTimeout(r, (wait + 1) * 1000));
  }
}

// The batch endpoint is not available to every app; remembered after the first refusal.
let batchTracksSupported = true;

/**
 * Look up tracks by id. Unknown or removed tracks map to null.
 * `onProgress` is called with the number of ids resolved so far.
 */
export async function fetchTracks(ids: string[], onProgress?: (done: number) => void): Promise<Map<string, SpotifyTrack | null>> {
  const out = new Map<string, SpotifyTrack | null>();
  for (let i = 0; i < ids.length; i += 50) {
    const chunk = ids.slice(i, i + 50);
    if (batchTracksSupported) {
      const batch = await apiPatient('/tracks?ids=' + chunk.join(','));
      if (batch.ok) {
        const { tracks } = (await batch.json()) as { tracks: (SpotifyTrack | null)[] };
        chunk.forEach((id, k) => out.set(id, tracks[k] ?? null));
        onProgress?.(out.size);
        continue;
      }
      if (batch.status === 401 || batch.status >= 500) throw new Error(`track lookup failed: ${batch.status}`);
      batchTracksSupported = false;
    }
    for (const id of chunk) {
      const one = await apiPatient('/tracks/' + id);
      if (one.ok) out.set(id, (await one.json()) as SpotifyTrack);
      else if (one.status === 404 || one.status === 400) out.set(id, null);
      else throw new Error(`track lookup failed: ${one.status}`);
      onProgress?.(out.size);
    }
  }
  return out;
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
  for (const [id, t] of await fetchTracks(ids)) {
    update.run(t?.track_number ?? 0, t?.disc_number ?? 0, t?.album.total_tracks ?? 0, id);
  }
  return ids.length;
}

type NowState = { isPlaying: boolean; progressMs: number; track: TrackInfo };

// Every open page polls for the current track, so one answer from Spotify is shared between them for a few
// seconds (longer while nothing is playing) instead of each poll becoming its own request.
const NOW_TTL_PLAYING = 5_000;
const NOW_TTL_IDLE = 12_000;
let nowCache: { at: number; value: NowState | null } | null = null;
let nowInflight: Promise<void> | null = null;

/** What is playing, at most a few seconds old; the position is advanced to the present. */
export async function nowPlaying(): Promise<NowState | null> {
  const ttl = nowCache?.value?.isPlaying ? NOW_TTL_PLAYING : NOW_TTL_IDLE;
  if (!nowCache || Date.now() - nowCache.at >= ttl) {
    nowInflight ??= fetchNowPlaying()
      .then((value) => { nowCache = { at: Date.now(), value }; })
      .finally(() => { nowInflight = null; });
    await nowInflight;
  }
  const { at, value } = nowCache!;
  if (!value?.isPlaying) return value;
  return { ...value, progressMs: Math.min(value.progressMs + (Date.now() - at), value.track.durationMs) };
}

async function fetchNowPlaying(): Promise<NowState | null> {
  const res = await api('/me/player/currently-playing');
  if (res.status === 204) return null;
  if (!res.ok) throw new Error(`currently-playing failed: ${res.status}`);
  const json = (await res.json()) as { is_playing: boolean; progress_ms: number | null; item: SpotifyTrack | null };
  if (!json.item || (json.item.type && json.item.type !== 'track')) return null;
  const track = toTrackInfo(json.item);
  if (!track) return null;
  return { isPlaying: json.is_playing, progressMs: json.progress_ms ?? 0, track };
}
