import assert from 'node:assert/strict';
import { afterEach, beforeEach, mock, test } from 'node:test';

// Set before the modules load: an in-memory database, and LRCLIB as the only source (no sidecar).
process.env.DB_PATH = ':memory:';
delete process.env.SPOTIFY_LYRICS_URL;
const { db } = await import('../server/db.ts');
const { getLyrics } = await import('../server/lyrics.ts');

let requests: string[];

beforeEach(() => {
  db.exec('DELETE FROM lyrics');
  requests = [];
  mock.method(globalThis, 'fetch', async (input: string | URL | Request) => {
    requests.push(String(input));
    return Response.json({ duration: 200, instrumental: false, plainLyrics: 'la la', syncedLyrics: '[00:01.00] la la' });
  });
});

afterEach(() => mock.restoreAll());

const stored = () => (db.prepare('SELECT COUNT(*) AS n FROM lyrics').get() as { n: number }).n;

test('track lyrics are cached: the second lookup makes no request', async () => {
  const lyrics = await getLyrics('a'.repeat(22), 'Song', 'Artist', 'Album', 200_000);
  assert.deepEqual(lyrics, { synced: [{ t: 1000, text: 'la la' }], plain: 'la la', instrumental: false });
  await getLyrics('a'.repeat(22), 'Song', 'Artist', 'Album', 200_000);
  assert.equal(requests.length, 1);
  assert.equal(stored(), 1);
});

test('episode lyrics are looked up and shown, but never stored', async () => {
  const lyrics = await getLyrics('e'.repeat(22), 'Episode', 'Show', 'Publisher', 200_000, false);
  assert.equal(lyrics.plain, 'la la');
  assert.equal(stored(), 0);
});
