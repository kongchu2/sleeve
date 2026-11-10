import { DatabaseSync } from 'node:sqlite';
import { mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

const path = process.env.DB_PATH ?? 'data/listening.db';
mkdirSync(dirname(path), { recursive: true });

export const db = new DatabaseSync(path);

db.exec(`
  PRAGMA journal_mode = WAL;
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
