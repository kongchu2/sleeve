import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';
import { getNow } from '../src/api.ts';

const answer = (isPlaying: boolean) => ({
  isPlaying,
  progressMs: 10_000,
  track: { kind: 'track', id: 'a'.repeat(22), name: 'Song', artists: 'Artist', album: 'Album', imageL: null, imageM: null, imageS: null, durationMs: 200_000 },
});

/** A server that takes `serverMs` to answer, over a connection that adds `wireMs` there and back. */
function serve(body: unknown, serverMs: number, wireMs: number, timing = true) {
  mock.method(globalThis, 'fetch', async () => {
    mock.timers.tick(serverMs + wireMs);
    return Response.json(body, { headers: timing ? { 'Server-Timing': `now;dur=${serverMs}` } : {} });
  });
}

beforeEach(() => mock.timers.enable({ apis: ['Date'], now: 1_000_000 }));
afterEach(() => {
  mock.timers.reset();
  mock.restoreAll();
});

test("getNow adds the way back (half the wire time), not the server's own wait", async () => {
  serve(answer(true), 2_500, 100);
  assert.equal((await getNow(true))?.progressMs, 10_050);
});

test('getNow without Server-Timing falls back to half the round trip, capped at 1s', async () => {
  serve(answer(true), 2_500, 100, false);
  assert.equal((await getNow(true))?.progressMs, 11_000);
});

test('getNow leaves a paused position alone', async () => {
  serve(answer(false), 0, 400);
  assert.equal((await getNow(true))?.progressMs, 10_000);
});
