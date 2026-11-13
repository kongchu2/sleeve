import { collect } from './collector.ts';
import { kvGet, kvSet } from './db.ts';
import * as spotify from './spotify.ts';

/**
 * The one place that talks to the Spotify Web API on a schedule. It runs in a single process (the worker,
 * or the web server when it collects itself) and leaves its findings in the database; the web server only
 * reads them. So the request rate is set here, by what is going on, and never by how many pages are open
 * or how often they ask.
 *
 *   nobody watching        no now-playing requests; history is pulled every SAFETY_SYNC_MS
 *   a page open            now-playing every 15s while music plays, 30s otherwise
 *   the Now Playing view   now-playing every 6s while music plays, 12s otherwise
 *
 * A track's end is known in advance from its length, so the poll that catches the next track is timed
 * for that moment instead of being found by polling faster. History is pulled when the track changes
 * (the previous one has just ended) and when someone starts watching.
 */
export type NowState = spotify.NowState;
type Snapshot = { at: number; value: NowState | null };
/** When a page on the Now Playing view, and one on any other view, last asked. Several pages can be open at once. */
type Viewers = { nowAt: number; otherAt: number };

/** Spotify lists the last 50 plays and a play takes 30s to count, so nothing is lost below 25 minutes. */
const SAFETY_SYNC_MS = 15 * 60_000;
const NOW_VIEW_MS = { playing: 6_000, idle: 12_000 };
const OTHER_VIEW_MS = { playing: 15_000, idle: 30_000 };
/** A page counts as watching for this long after its last request (pages ask every few seconds). */
const VIEWER_TTL_MS = 20_000;
/** Older than the slowest poll: the poller is not keeping this up to date (nobody was watching, or it is down). */
const STALE_MS = 45_000;

const seen: Viewers = { nowAt: 0, otherAt: 0 };
let lastViewerWrite = 0;

/** Called by the web server for every now-playing request, so the poller knows someone is looking. */
export function noteViewer(nowView: boolean): void {
  const at = Date.now();
  const key = nowView ? 'nowAt' : 'otherAt';
  const arrived = at - seen[key] >= VIEWER_TTL_MS;
  seen[key] = at;
  if (!arrived && at - lastViewerWrite < 5_000) return;
  lastViewerWrite = at;
  kvSet('viewers', seen);
}

function freshSnapshot(): Snapshot | null {
  const snap = kvGet<Snapshot>('now');
  return snap && Date.now() - snap.at < STALE_MS ? snap : null;
}

/**
 * What is playing, as last seen by the poller, with the position advanced to the present.
 * `undefined` when the poller has nothing recent to offer (it is failing or not running): unknown, which
 * is not the same as nothing playing.
 */
export async function currentNow(): Promise<NowState | null | undefined> {
  let snap = freshSnapshot();
  // The first request after a quiet spell arrives before the poller has looked: give it a moment.
  for (let i = 0; !snap && i < 12; i++) {
    await new Promise((r) => setTimeout(r, 250));
    snap = freshSnapshot();
  }
  if (!snap) return undefined;
  if (!snap.value) return null;
  const { at, value } = snap;
  if (!value.isPlaying) return value;
  return { ...value, progressMs: Math.min(value.progressMs + (Date.now() - at), value.track.durationMs) };
}

export function startPoller(): void {
  let nextNow = 0;
  let nextSync = 0;
  let retrySync = false;
  let lastSync = 0;
  let lastTrack: string | null | undefined;
  /** Episodes never appear in recently-played, so the end of one is no reason to pull the history. */
  let lastWasEpisode = false;
  let watched = false;
  let busy = false;

  setInterval(async () => {
    if (busy || !spotify.isAuthed() || spotify.rateLimitedFor() > 0) return;
    busy = true;
    try {
      const viewers = kvGet<Viewers>('viewers') ?? { nowAt: 0, otherAt: 0 };
      const nowView = Date.now() - viewers.nowAt < VIEWER_TTL_MS;
      const watching = nowView || Date.now() - viewers.otherAt < VIEWER_TTL_MS;
      if (watching && !watched) {
        // Someone just arrived: show them the present, and bring the history up to date.
        nextNow = 0;
        lastTrack = undefined;
        if (Date.now() - lastSync > 60_000) nextSync = 0;
      }
      watched = watching;

      if (watching && Date.now() >= nextNow) {
        const sent = Date.now();
        const answer = await spotify.fetchNowPlaying();
        const at = Date.now();
        // Spotify measured the position somewhere between sending and receiving: count from the midpoint.
        // Capped, since a slow answer (a token refresh, a stall) says little about when it was measured.
        const value =
          answer?.isPlaying
            ? { ...answer, progressMs: Math.min(answer.progressMs + Math.min((at - sent) / 2, 1_000), answer.track.durationMs) }
            : answer;
        kvSet('now', { at, value } satisfies Snapshot);
        const id = value?.track.id ?? null;
        if (lastTrack !== undefined && id !== lastTrack && !lastWasEpisode) {
          // The previous track has just ended; Spotify can take a moment to list it, hence one retry.
          nextSync = Math.min(nextSync, at + 5_000);
          retrySync = true;
        }
        lastTrack = id;
        lastWasEpisode = value?.track.kind === 'episode';
        const pace = nowView ? NOW_VIEW_MS : OTHER_VIEW_MS;
        let wait = value?.isPlaying ? pace.playing : pace.idle;
        if (value?.isPlaying) wait = Math.min(wait, Math.max(1_000, value.track.durationMs - value.progressMs + 1_000));
        nextNow = at + wait;
      }

      if (Date.now() >= nextSync) {
        const added = await collect();
        lastSync = Date.now();
        nextSync = lastSync + (added === 0 && retrySync ? 25_000 : SAFETY_SYNC_MS);
        retrySync = false;
      }
    } catch (err) {
      console.error('[poll]', err instanceof Error ? err.message : err);
      nextNow = Date.now() + 15_000;
    } finally {
      busy = false;
    }
  }, 1_000);
}
