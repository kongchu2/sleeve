import { execFile, execFileSync } from 'node:child_process';
import { existsSync, mkdirSync, readdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { promisify } from 'node:util';
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
const run = promisify(execFile);
const gitAsync = async (...args: string[]) => (await run('git', args, { cwd: DIR, encoding: 'utf8' })).stdout.trim();

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
  // One transaction: committing row by row takes minutes on a fresh machine.
  db.exec('BEGIN IMMEDIATE');
  try {
    for (const file of readdirSync(dir).filter((f) => f.endsWith('.jsonl')).sort()) {
      for (const line of readFileSync(join(dir, file), 'utf8').split('\n')) {
        if (!line.trim()) continue;
        const row = JSON.parse(line) as Record<string, string | number | null>;
        added += Number(insert.run(...COLUMNS.map((c) => row[c] ?? null)).changes);
      }
    }
    db.exec('COMMIT');
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
  return added;
}

/** Is there a month whose file is behind the database? */
export const archivePending = () => db.prepare('SELECT 1 FROM archive_dirty LIMIT 1').get() !== undefined;

const markDirty = (months: string[]) => {
  const mark = db.prepare('INSERT OR IGNORE INTO archive_dirty VALUES (?)');
  for (const month of months) mark.run(month);
};

/** The months with changes, which are from here on considered written: a play changed after this is flagged again. */
function takeDirty(): string[] {
  db.exec('BEGIN IMMEDIATE');
  try {
    const months = (db.prepare('SELECT month FROM archive_dirty ORDER BY month').all() as { month: string }[]).map((r) => r.month);
    db.exec('DELETE FROM archive_dirty');
    db.exec('COMMIT');
    return months;
  } catch (err) {
    db.exec('ROLLBACK');
    throw err;
  }
}

/** Every UTC month from the first play to the last. */
function allMonths(): string[] {
  const { lo, hi } = db.prepare('SELECT min(played_at) AS lo, max(played_at) AS hi FROM plays').get() as { lo: number | null; hi: number | null };
  if (lo === null || hi === null) return [];
  const months: string[] = [];
  const first = new Date(lo);
  for (let d = new Date(Date.UTC(first.getUTCFullYear(), first.getUTCMonth(), 1)); d.getTime() <= hi; d.setUTCMonth(d.getUTCMonth() + 1)) {
    months.push(d.toISOString().slice(0, 7));
  }
  return months;
}

/**
 * Rewrite the monthly files that are behind the database, then commit and push if anything changed.
 * Only the months flagged in `archive_dirty` are touched, one at a time: normally that is the current
 * month alone. `full` rewrites every month regardless, to bring an archive of unknown state in line.
 * git runs without blocking, so the poller in the same process keeps its schedule during a push.
 */
export async function pushArchive(full = false): Promise<boolean> {
  const dirty = takeDirty();
  const months = full ? [...new Set([...allMonths(), ...dirty])].sort() : dirty;
  try {
    const select = db.prepare(`SELECT ${COLUMNS.join(', ')} FROM plays WHERE played_at >= ? AND played_at < ? ORDER BY played_at`);
    mkdirSync(join(DIR, 'plays'), { recursive: true });
    for (const month of months) {
      const [y, m] = month.split('-').map(Number);
      const rows = select.all(Date.UTC(y, m - 1, 1), Date.UTC(y, m, 1));
      const file = join(DIR, 'plays', month + '.jsonl');
      if (rows.length) writeFileSync(file, rows.map((row) => JSON.stringify(row)).join('\n') + '\n');
      else rmSync(file, { force: true });
    }

    await gitAsync('add', '-A');
    if (!(await gitAsync('status', '--porcelain'))) return false;
    const { n, last } = db.prepare('SELECT count(*) AS n, max(played_at) AS last FROM plays').get() as { n: number; last: number | null };
    await gitAsync('commit', '-q', '-m', `Listening data through ${last === null ? 'empty' : new Date(last).toISOString()} (${n} plays)`);
    await gitAsync('push', '-q', '-u', 'origin', 'HEAD');
    return true;
  } catch (err) {
    markDirty(months); // not published: try these again
    throw err;
  }
}
