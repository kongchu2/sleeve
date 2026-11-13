import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';

// Set before the database module loads, so the tests never open the real log.
process.env.DB_PATH = ':memory:';
const { db, kvSet } = await import('../server/db.ts');
const { currentNow, noteViewer, startPoller } = await import('../server/poller.ts');

// The poller is driven by the clock, so the clock is mocked and Spotify is a fake `fetch`.
// Each test starts an hour after the last: the poller module remembers when viewers were last seen.
let epoch = Date.UTC(2026, 0, 1);

const NOW_PATH = '/me/player/currently-playing';
const RECENT_PATH = '/me/player/recently-played';

const track = (c: string, durationMs = 300_000) => ({
  id: c.repeat(22), type: 'track', name: 'Song ' + c, duration_ms: durationMs,
  artists: [{ name: 'Artist' }], album: { id: 'album-' + c, name: 'Album', images: [] },
});
type Player = { is_playing: boolean; progress_ms: number; item: ReturnType<typeof track> } | null;

let player: Player;
let recent: { played_at: string; track: ReturnType<typeof track> }[];
let limited: boolean;
let calls: { path: string; at: number }[];

/** Seconds into the test at which a path was requested. */
const times = (path: string) => calls.filter((c) => c.path === path).map((c) => c.at / 1000);

/** Let the poller's pending promises (fake fetches, database writes) run. */
const settle = async () => {
  for (let i = 0; i < 20; i++) await new Promise((r) => setImmediate(r));
};

/** Move the clock forward a second at a time, with a page asking every 5 seconds if `viewer` is given. */
async function advance(ms: number, viewer?: 'now' | 'other') {
  for (let t = 0; t < ms; t += 1000) {
    if (viewer && t % 5000 === 0) noteViewer(viewer === 'now');
    mock.timers.tick(1000);
    await settle();
  }
}

beforeEach(() => {
  epoch += 3_600_000;
  mock.timers.enable({ apis: ['setInterval', 'setTimeout', 'Date'], now: epoch });
  db.exec('DELETE FROM kv; DELETE FROM plays');
  kvSet('tokens', { access_token: 'token', refresh_token: 'refresh', expires_at: epoch + 86_400_000 });
  player = null;
  recent = [];
  limited = false;
  calls = [];
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    const path = new URL(String(input)).pathname.replace('/v1', '');
    calls.push({ path, at: Date.now() - epoch });
    if (limited) return new Response(null, { status: 429, headers: { 'retry-after': '100' } });
    if (path === NOW_PATH) return player ? Response.json(player) : new Response(null, { status: 204 });
    if (path === RECENT_PATH) return Response.json({ items: recent });
    throw new Error('unexpected request: ' + String(input));
  });
  for (const level of ['log', 'warn', 'error'] as const) mock.method(console, level, () => {});
});

afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

test('with nobody watching, only the history is pulled, every 15 minutes', async () => {
  player = { is_playing: true, progress_ms: 0, item: track('a') };
  startPoller();
  await advance(16 * 60_000);
  assert.deepEqual(times(NOW_PATH), []);
  assert.deepEqual(times(RECENT_PATH), [1, 901]);
});

test('not signed in: nothing is requested', async () => {
  db.exec("DELETE FROM kv WHERE key = 'tokens'");
  startPoller();
  await advance(30_000, 'now');
  assert.deepEqual(calls, []);
});

test('a page on another view: now-playing every 15s while music plays', async () => {
  player = { is_playing: true, progress_ms: 10_000, item: track('a') };
  startPoller();
  await advance(50_000, 'other');
  assert.deepEqual(times(NOW_PATH), [1, 16, 31, 46]);
});

test('a page on another view: every 30s while nothing plays', async () => {
  startPoller();
  await advance(65_000, 'other');
  assert.deepEqual(times(NOW_PATH), [1, 31, 61]);
});

test('the Now Playing view: every 6s while music plays, 12s otherwise', async () => {
  player = { is_playing: true, progress_ms: 10_000, item: track('a') };
  startPoller();
  await advance(19_000, 'now');
  assert.deepEqual(times(NOW_PATH), [1, 7, 13, 19]);

  calls = [];
  player = { is_playing: false, progress_ms: 10_000, item: track('a') };
  await advance(30_000, 'now');
  // The poll at 19s saw music, so the next one still comes 6s later; from there on it is every 12s.
  assert.deepEqual(times(NOW_PATH), [25, 37, 49]);
});

test('the Now Playing view sets the pace when both kinds of page are open', async () => {
  player = { is_playing: true, progress_ms: 10_000, item: track('a') };
  startPoller();
  for (let i = 0; i < 4; i++) {
    noteViewer(false);
    await advance(5_000, 'now');
  }
  assert.deepEqual(times(NOW_PATH), [1, 7, 13, 19]);
});

test('the poll that catches the next track is timed for the end of this one', async () => {
  player = { is_playing: true, progress_ms: 297_000, item: track('a') };
  startPoller();
  await advance(1_000, 'now');
  player = { is_playing: true, progress_ms: 500, item: track('b') };
  await advance(10_000, 'now');
  // 3s of the track left, plus a second for it to turn over: asked at 5s rather than 7s.
  assert.deepEqual(times(NOW_PATH), [1, 5, 11]);
});

test('a track change pulls the history 5s later, and once more if Spotify has not listed it yet', async () => {
  player = { is_playing: true, progress_ms: 297_000, item: track('a') };
  startPoller();
  await advance(1_000, 'now');
  player = { is_playing: true, progress_ms: 500, item: track('b') };
  await advance(120_000, 'now');
  // 1: on arrival. 10: 5s after the change was seen at 5. 35: the one retry. Then back to every 15 minutes.
  assert.deepEqual(times(RECENT_PATH), [1, 10, 35]);
});

test('no retry when the pull after a track change found the play', async () => {
  player = { is_playing: true, progress_ms: 297_000, item: track('a') };
  startPoller();
  await advance(1_000, 'now');
  player = { is_playing: true, progress_ms: 500, item: track('b') };
  recent = [{ played_at: new Date(epoch + 4_000).toISOString(), track: track('a') }];
  await advance(120_000, 'now');
  assert.deepEqual(times(RECENT_PATH), [1, 10]);
  const plays = db.prepare('SELECT track_id, album_id FROM plays').all();
  assert.deepEqual(plays.map((p) => ({ ...p })), [{ track_id: 'a'.repeat(22), album_id: 'album-a' }]);
});

test('polling stops 20s after the last page went away, and resumes at once when one returns', async () => {
  player = { is_playing: true, progress_ms: 10_000, item: track('a') };
  startPoller();
  await advance(10_000, 'now'); // the last request from the page is at 5s
  await advance(60_000);
  assert.deepEqual(times(NOW_PATH), [1, 7, 13, 19]);

  calls = [];
  await advance(2_000, 'now');
  assert.deepEqual(times(NOW_PATH), [71]);
  // The history was last pulled over a minute ago, so the returning viewer gets it brought up to date.
  assert.deepEqual(times(RECENT_PATH), [71]);
});

test('once rate limited, nothing is requested until Retry-After has passed', async () => {
  limited = true;
  startPoller();
  await advance(100_000, 'now');
  assert.equal(calls.length, 1);

  limited = false;
  await advance(3_000, 'now');
  assert.ok(times(NOW_PATH).some((t) => t > 100), 'polling resumes after the ban');
});

const snapshot = (value: { isPlaying: boolean; progressMs: number } | null, age = 0) =>
  kvSet('now', {
    at: Date.now() - age,
    value: value && { ...value, track: { id: 'a'.repeat(22), name: 'Song', artists: 'Artist', album: 'Album', imageL: null, imageM: null, imageS: null, durationMs: 200_000 } },
  });

test('currentNow advances the position of a playing track to the present', async () => {
  snapshot({ isPlaying: true, progressMs: 10_000 });
  mock.timers.tick(4_000);
  assert.equal((await currentNow())?.progressMs, 14_000);
});

test('currentNow never runs past the end of the track', async () => {
  snapshot({ isPlaying: true, progressMs: 190_000 });
  mock.timers.tick(30_000);
  assert.equal((await currentNow())?.progressMs, 200_000);
});

test('currentNow leaves a paused track where it stopped', async () => {
  snapshot({ isPlaying: false, progressMs: 10_000 });
  mock.timers.tick(30_000);
  assert.equal((await currentNow())?.progressMs, 10_000);
});

test('currentNow is null when the poller saw nothing playing', async () => {
  snapshot(null);
  assert.equal(await currentNow(), null);
});

test('currentNow is undefined (unknown) when the snapshot is stale and none arrives', async () => {
  snapshot({ isPlaying: true, progressMs: 10_000 }, 45_000);
  const answer = currentNow();
  for (let i = 0; i < 12; i++) {
    mock.timers.tick(250);
    await settle();
  }
  assert.equal(await answer, undefined);
});

test('currentNow waits a moment for the poller to take its first look', async () => {
  const answer = currentNow();
  mock.timers.tick(250);
  await settle();
  snapshot({ isPlaying: false, progressMs: 10_000 });
  mock.timers.tick(250);
  await settle();
  assert.equal((await answer)?.progressMs, 10_000);
});

test('a podcast episode is shown as now playing but never written to the history', async () => {
  const episode = {
    id: 'e'.repeat(22), type: 'episode', name: 'Episode 1', duration_ms: 3_600_000, images: [],
    show: { name: 'Show', publisher: 'Publisher', images: [{ url: 'show.jpg', width: 640 }] },
  };
  player = { is_playing: true, progress_ms: 60_000, item: episode as never };
  startPoller();
  await advance(30_000, 'now');
  const now = await currentNow();
  assert.equal(now?.track.kind, 'episode');
  assert.equal(now?.track.artists, 'Show');
  assert.equal(now?.track.imageL, 'show.jpg');
  player = { is_playing: true, progress_ms: 0, item: track('b') };
  await advance(60_000, 'now'); // the change of item pulls the history
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM plays').get() as { n: number }).n, 0);
});
