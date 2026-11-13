import assert from 'node:assert/strict';
import { beforeEach, test } from 'node:test';

// Set before the database module loads, so the tests never open the real log.
process.env.DB_PATH = ':memory:';
const { db } = await import('../server/db.ts');
const { coverlessTracks, importEntries, settleImported } = await import('../server/importer.ts');

const id = (c: string) => c.repeat(22);
const A = id('a');
const B = id('b');
const T0 = Date.UTC(2024, 2, 10, 12);

const entry = (over: Partial<{ ts: number; id: string; ms: number; name: string; artist: string; album: string }> = {}) => ({
  ts: T0, id: A, ms: 180_000, name: 'Song', artist: 'Artist', album: 'Album', ...over,
});

type Row = {
  played_at: number; track_id: string; track_name: string; artists: string; album_id: string; album_name: string;
  image_m: string | null; duration_ms: number;
};
const rows = () => db.prepare('SELECT * FROM plays ORDER BY played_at').all() as Row[];

/** A play as live collection stores it: real album id, artwork, the track's full length. */
function livePlay(at: number, track = A) {
  db.prepare(
    `INSERT INTO plays (played_at, track_id, track_name, artists, album_id, album_name, image_l, image_m, image_s,
                        duration_ms, track_number, disc_number, album_total_tracks)
     VALUES (?, ?, 'Live song', 'Live artist', 'album123', 'Live album', 'l.jpg', 'm.jpg', 's.jpg', 240000, 3, 1, 10)`,
  ).run(at, track);
}

beforeEach(() => {
  db.exec('DELETE FROM plays; DELETE FROM cover_gone; DELETE FROM archive_dirty');
});

test('a new play goes in with what the export says, under an export album id', () => {
  assert.deepEqual(importEntries([entry()]), { added: 1, skipped: 0 });
  const [row] = rows();
  assert.equal(row.played_at, T0);
  assert.equal(row.track_name, 'Song');
  assert.equal(row.album_id, 'export:Artist — Album');
  assert.equal(row.album_name, 'Album');
  assert.equal(row.image_m, null);
  assert.equal(row.duration_ms, 180_000);
});

test('albums of the same name by different artists stay apart', () => {
  importEntries([entry(), entry({ ts: T0 + 600_000, id: B, artist: 'Someone else' })]);
  assert.deepEqual(rows().map((r) => r.album_id), ['export:Artist — Album', 'export:Someone else — Album']);
});

test('missing names fall back, and an album without a name is keyed by the track', () => {
  importEntries([entry({ name: '', artist: '', album: '' })]);
  const [row] = rows();
  assert.equal(row.track_name, 'Unknown track');
  assert.equal(row.artists, 'Unknown artist');
  assert.equal(row.album_name, 'Unknown album');
  assert.equal(row.album_id, 'export:' + A);
});

test('streams under 30 seconds and malformed entries are dropped, not counted', () => {
  const result = importEntries([
    entry({ ms: 29_999 }),
    entry({ id: 'too-short' }),
    { ts: 'yesterday', id: A, ms: 60_000 },
    null,
    'nonsense',
  ]);
  assert.deepEqual(result, { added: 0, skipped: 0 });
  assert.equal(rows().length, 0);
});

test('importing the same file twice adds nothing the second time', () => {
  const file = [entry(), entry({ ts: T0 + 600_000, id: B })];
  assert.deepEqual(importEntries(file), { added: 2, skipped: 0 });
  assert.deepEqual(importEntries(file), { added: 0, skipped: 2 });
  assert.equal(rows().length, 2);
});

test('a play within 25 seconds of the same track is the same play', () => {
  importEntries([entry()]);
  assert.deepEqual(importEntries([entry({ ts: T0 + 25_000 })]), { added: 0, skipped: 1 });
  assert.deepEqual(importEntries([entry({ ts: T0 + 25_001 })]), { added: 1, skipped: 0 });
});

test('an imported play met again has its listened time refreshed', () => {
  importEntries([entry({ ms: 60_000 })]);
  importEntries([entry({ ms: 200_000 })]);
  assert.equal(rows()[0].duration_ms, 200_000);
});

test('a play collected live is left as it is', () => {
  livePlay(T0);
  assert.deepEqual(importEntries([entry({ ts: T0 + 5_000, ms: 60_000 })]), { added: 0, skipped: 1 });
  const [row] = rows();
  assert.equal(row.duration_ms, 240_000);
  assert.equal(row.album_id, 'album123');
});

test('a track already collected live lends its album, artwork and length', () => {
  livePlay(T0);
  importEntries([entry({ ts: T0 - 86_400_000, ms: 60_000 })]);
  const [imported] = rows();
  assert.equal(imported.played_at, T0 - 86_400_000);
  assert.equal(imported.album_id, 'album123');
  assert.equal(imported.track_name, 'Live song');
  assert.equal(imported.image_m, 'm.jpg');
  assert.equal(imported.duration_ms, 240_000);
});

test('a track known only from the export keeps each play\'s own listened time', () => {
  importEntries([entry({ ms: 60_000 })]);
  importEntries([entry({ ts: T0 + 3_600_000, ms: 90_000 })]);
  assert.deepEqual(rows().map((r) => r.duration_ms), [60_000, 90_000]);
});

test('two tracks ending in the same instant both get in', () => {
  assert.deepEqual(importEntries([entry(), entry({ id: B })]), { added: 2, skipped: 0 });
  assert.deepEqual(rows().map((r) => r.played_at), [T0, T0 + 1]);
});

test('coverlessTracks counts imported tracks without artwork, once each', () => {
  livePlay(T0 - 1_000_000, id('c'));
  importEntries([entry(), entry({ ts: T0 + 600_000 }), entry({ ts: T0 + 1_200_000, id: B })]);
  assert.equal(coverlessTracks(), 2);

  db.prepare("UPDATE plays SET image_m = 'm.jpg' WHERE track_id = ?").run(A);
  assert.equal(coverlessTracks(), 1);

  // Spotify no longer has this one: it stops being waited for.
  db.prepare('INSERT INTO cover_gone (track_id) VALUES (?)').run(B);
  assert.equal(coverlessTracks(), 0);
});

test('settleImported brings rows from earlier versions to the current shape', () => {
  importEntries([entry(), entry({ ts: T0 + 600_000, id: B })]);
  db.prepare("UPDATE plays SET album_id = 'pending:Album' WHERE track_id = ?").run(A);
  db.prepare("UPDATE plays SET album_id = 'export:Album' WHERE track_id = ?").run(B);
  settleImported();
  assert.deepEqual(rows().map((r) => r.album_id), ['export:Artist — Album', 'export:Artist — Album']);
  // Running it again changes nothing.
  settleImported();
  assert.deepEqual(rows().map((r) => r.album_id), ['export:Artist — Album', 'export:Artist — Album']);
});

test('every change to a play flags its UTC month for the archive', () => {
  const dirty = () => (db.prepare('SELECT month FROM archive_dirty ORDER BY month').all() as { month: string }[]).map((r) => r.month);

  importEntries([entry(), entry({ ts: Date.UTC(2023, 11, 31, 23, 59), id: B })]);
  assert.deepEqual(dirty(), ['2023-12', '2024-03']);

  db.exec('DELETE FROM archive_dirty');
  importEntries([entry()]); // already there, same listened time
  db.prepare("UPDATE plays SET image_m = 'm.jpg' WHERE track_id = ?").run(B);
  assert.deepEqual(dirty().includes('2023-12'), true);

  db.exec('DELETE FROM archive_dirty');
  db.prepare('DELETE FROM plays WHERE track_id = ?').run(A);
  assert.deepEqual(dirty(), ['2024-03']);
});
