import { execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { db } from './db.ts';

/**
 * The listening archive: a separate git repository holding every play as JSON Lines,
 * one file per UTC month (plays/2026-11.jsonl). The database is the working copy;
 * the archive is the durable, human-readable record and can rebuild the database.
 */
const DIR = process.env.DATA_REPO_DIR ?? '';
const COLUMNS = [
  'played_at', 'track_id', 'track_name', 'artists', 'album_id', 'album_name',
  'image_l', 'image_m', 'image_s', 'duration_ms', 'track_number', 'disc_number', 'album_total_tracks',
] as const;

export const archiveEnabled = () => Boolean(DIR) && existsSync(join(DIR, '.git'));

const git = (...args: string[]) => execFileSync('git', args, { cwd: DIR, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** Bring in anything the archive has that the database lacks (e.g. on a fresh machine). */
export function importArchive(): number {
  try {
    git('pull', '--ff-only');
  } catch {
    /* empty remote or offline: carry on with the local copy */
  }
  const dir = join(DIR, 'plays');
  if (!existsSync(dir)) return 0;
  const insert = db.prepare(
    `INSERT OR IGNORE INTO plays (${COLUMNS.join(', ')}) VALUES (${COLUMNS.map(() => '?').join(', ')})`,
  );
  let added = 0;
  for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
    for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
      if (!line.trim()) continue;
      const row = JSON.parse(line) as Record<string, string | number | null>;
      added += Number(insert.run(...COLUMNS.map((c) => row[c] ?? null)).changes);
    }
  }
  return added;
}

/** Rewrite the monthly files from the database, then commit and push if anything changed. */
export function pushArchive(): boolean {
  const rows = db.prepare(`SELECT ${COLUMNS.join(', ')} FROM plays ORDER BY played_at`).all() as Record<string, string | number | null>[];
  const months = new Map<string, string[]>();
  for (const row of rows) {
    const month = new Date(Number(row.played_at)).toISOString().slice(0, 7);
    if (!months.has(month)) months.set(month, []);
    months.get(month)!.push(JSON.stringify(row));
  }
  mkdirSync(join(DIR, 'plays'), { recursive: true });
  for (const [month, lines] of months) writeFileSync(join(DIR, 'plays', month + '.jsonl'), lines.join('\n') + '\n');

  git('add', '-A');
  if (!git('status', '--porcelain')) return false;
  const last = rows.length ? new Date(Number(rows[rows.length - 1].played_at)).toISOString() : 'empty';
  git('commit', '-q', '-m', `Listening data through ${last} (${rows.length} plays)`);
  git('push', '-q', '-u', 'origin', 'HEAD');
  return true;
}
