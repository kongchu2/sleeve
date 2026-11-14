import { DatabaseSync } from 'node:sqlite';
import { chmodSync, closeSync, mkdirSync, openSync } from 'node:fs';
import { dirname } from 'node:path';

const path = process.env.DB_PATH ?? 'data/listening.db';
if (path !== ':memory:') {
  mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
  // The kv table holds the Spotify refresh token, so keep the file to its owner. SQLite gives the -wal and
  // -shm files the same mode as the database, which is why this happens before it is opened.
  closeSync(openSync(path, 'a', 0o600));
  try {
    chmodSync(path, 0o600);
  } catch (err) {
    console.warn(`Could not make ${path} private to its owner:`, err);
  }
}

export const db = new DatabaseSync(path);

db.exec(`
  PRAGMA journal_mode = WAL;
  PRAGMA synchronous = NORMAL; -- safe with WAL, and the poller writes every few seconds
  PRAGMA busy_timeout = 5000; -- the web server and the worker both write
  CREATE TABLE IF NOT EXISTS plays (
    played_at   INTEGER PRIMARY KEY,
    track_id    TEXT NOT NULL,
    track_name  TEXT NOT NULL,
    artists     TEXT NOT NULL,
    album_id    TEXT NOT NULL,
    album_name  TEXT NOT NULL,
    image_l     TEXT,
    image_m     TEXT,
    image_s     TEXT,
    duration_ms INTEGER NOT NULL
  );
  CREATE TABLE IF NOT EXISTS kv (
    key   TEXT PRIMARY KEY,
    value TEXT NOT NULL
  );
  CREATE TABLE IF NOT EXISTS lyrics (
    track_id   TEXT PRIMARY KEY,
    body       TEXT NOT NULL,
    fetched_at INTEGER NOT NULL
  );
`);

// Columns added after the first release; older databases get them on startup.
const playColumns = new Set((db.prepare('PRAGMA table_info(plays)').all() as { name: string }[]).map((c) => c.name));
for (const column of ['track_number', 'disc_number', 'album_total_tracks']) {
  if (!playColumns.has(column)) db.exec(`ALTER TABLE plays ADD COLUMN ${column} INTEGER`);
}

db.exec('CREATE INDEX IF NOT EXISTS plays_track ON plays (track_id, played_at)');
// Streaks ask for every day one album was played.
db.exec('CREATE INDEX IF NOT EXISTS plays_album ON plays (album_id, played_at)');
// Plays still waiting for artwork (see server/importer.ts): few, and none once the lookups are done.
db.exec('CREATE INDEX IF NOT EXISTS plays_coverless ON plays (track_id, album_id) WHERE image_m IS NULL');

// Which UTC months have plays the archive has not been given yet (see server/archive.ts). Kept by
// triggers because plays are written from two processes and several places.
const MONTH_OF = (row: string) => `strftime('%Y-%m', ${row}.played_at / 1000, 'unixepoch')`;
db.exec(`
  CREATE TABLE IF NOT EXISTS archive_dirty (month TEXT PRIMARY KEY);
  CREATE TRIGGER IF NOT EXISTS plays_archive_insert AFTER INSERT ON plays
    BEGIN INSERT OR IGNORE INTO archive_dirty VALUES (${MONTH_OF('NEW')}); END;
  CREATE TRIGGER IF NOT EXISTS plays_archive_update AFTER UPDATE ON plays
    BEGIN INSERT OR IGNORE INTO archive_dirty VALUES (${MONTH_OF('NEW')}), (${MONTH_OF('OLD')}); END;
  CREATE TRIGGER IF NOT EXISTS plays_archive_delete AFTER DELETE ON plays
    BEGIN INSERT OR IGNORE INTO archive_dirty VALUES (${MONTH_OF('OLD')}); END;
`);

export function kvGet<T>(key: string): T | null {
  const row = db.prepare('SELECT value FROM kv WHERE key = ?').get(key) as { value: string } | undefined;
  return row ? (JSON.parse(row.value) as T) : null;
}

export function kvSet(key: string, value: unknown): void {
  db.prepare('INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value').run(
    key,
    JSON.stringify(value),
  );
}

export function kvDelete(key: string): void {
  db.prepare('DELETE FROM kv WHERE key = ?').run(key);
}
