import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { collect } from './collector.ts';
import { db } from './db.ts';
import { enqueueImport, importStatus } from './importer.ts';
import { getLyrics } from './lyrics.ts';
import * as spotify from './spotify.ts';
import { dayNotes, fullAlbums, recap, wallCovers } from './stats.ts';

const PORT = Number(process.env.PORT ?? 8787);
// Loopback by default: the API can control playback, so only widen this behind something that restricts access.
const HOST = process.env.HOST ?? '127.0.0.1';
const APP_URL = process.env.APP_URL ?? '/';
const SYNC_INTERVAL = 2 * 60 * 1000;

const app = new Hono();

app.onError((err, c) => {
  console.error(err);
  return c.json({ error: err.message }, 500);
});

app.get('/auth/login', (c) => {
  if (!spotify.isConfigured()) return c.text('SPOTIFY_CLIENT_ID / SPOTIFY_CLIENT_SECRET are not set.', 500);
  return c.redirect(spotify.loginUrl());
});

app.get('/auth/callback', async (c) => {
  const code = c.req.query('code');
  const state = c.req.query('state');
  if (!code || !state) return c.text('Spotify authorization was cancelled: ' + (c.req.query('error') ?? 'unknown'), 400);
  await spotify.exchangeCode(code, state);
  await collect();
  return c.redirect(APP_URL);
});

app.post('/auth/logout', (c) => {
  spotify.logout();
  return c.json({ ok: true });
});

app.get('/api/status', (c) => c.json({ configured: spotify.isConfigured(), authed: spotify.isAuthed() }));

app.use('/api/*', async (c, next) => {
  if (!spotify.isAuthed()) return c.json({ error: 'not connected' }, 401);
  await next();
});

app.get('/api/plays', (c) => {
  const from = Number(c.req.query('from'));
  const to = Number(c.req.query('to'));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return c.json({ error: 'from/to required' }, 400);
  const rows = db.prepare('SELECT * FROM plays WHERE played_at >= ? AND played_at < ? ORDER BY played_at').all(from, to);
  return c.json(rows);
});

/** Per-day summary for a range: the most played album of each day. `tz` is the viewer's UTC offset in minutes. */
app.get('/api/days', (c) => {
  const from = Number(c.req.query('from'));
  const to = Number(c.req.query('to'));
  const offset = (Number(c.req.query('tz')) || 0) * 60;
  if (!Number.isFinite(from) || !Number.isFinite(to)) return c.json({ error: 'from/to required' }, 400);
  const rows = db
    .prepare(
      `SELECT strftime('%Y-%m-%d', played_at / 1000 + ?, 'unixepoch') AS day, album_id, album_name,
              max(image_m) AS image_m, max(image_s) AS image_s, count(*) AS n
       FROM plays WHERE played_at >= ? AND played_at < ?
       GROUP BY day, album_id ORDER BY day, n DESC`,
    )
    .all(offset, from, to) as { day: string; album_id: string; album_name: string; image_m: string | null; image_s: string | null; n: number }[];
  const days: { day: string; album: string; image_m: string | null; image_s: string | null; plays: number; albums: number }[] = [];
  for (const r of rows) {
    const last = days[days.length - 1];
    if (last?.day === r.day) {
      last.plays += r.n;
      last.albums += 1;
    } else days.push({ day: r.day, album: r.album_name, image_m: r.image_m, image_s: r.image_s, plays: r.n, albums: 1 });
  }
  return c.json(days);
});

app.get('/api/full-albums', (c) => c.json(fullAlbums()));

app.get('/api/day-notes', (c) => {
  const day = c.req.query('day') ?? '';
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) return c.json({ error: 'day required (YYYY-MM-DD)' }, 400);
  return c.json(dayNotes(day, Number(c.req.query('tz')) || 0));
});

app.get('/api/wall', (c) => {
  const limit = Math.min(600, Math.max(1, Number(c.req.query('limit')) || 200));
  return c.json(wallCovers(limit));
});

app.get('/api/recap', (c) => {
  const from = Number(c.req.query('from'));
  const to = Number(c.req.query('to'));
  if (!Number.isFinite(from) || !Number.isFinite(to)) return c.json({ error: 'from/to required' }, 400);
  return c.json(recap(from, to, Number(c.req.query('tz')) || 0));
});

app.get('/api/import', (c) => c.json(importStatus()));

app.post('/api/import', async (c) => {
  const body = (await c.req.json().catch(() => null)) as { entries?: unknown[] } | null;
  if (!body || !Array.isArray(body.entries)) return c.json({ error: 'entries required' }, 400);
  return c.json({ accepted: enqueueImport(body.entries) });
});

app.get('/api/now', async (c) => c.json(await spotify.nowPlaying()));

app.get('/api/lyrics', async (c) => {
  const q = c.req.query();
  if (!q.id || !q.name || !q.artists) return c.json({ error: 'id/name/artists required' }, 400);
  return c.json(await getLyrics(q.id, q.name, q.artists, q.album ?? '', Number(q.duration) || 0));
});

app.post('/api/player/:action', async (c) => {
  const status = await spotify.control(c.req.param('action'), Number(c.req.query('ms')));
  return c.json({ ok: status >= 200 && status < 300, status });
});

if (existsSync('dist/index.html')) {
  // Hashed assets never change; everything else (the page itself) must be revalidated so updates show up on reload.
  app.use('*', async (c, next) => {
    await next();
    c.header('Cache-Control', c.req.path.startsWith('/assets/') ? 'public, max-age=31536000, immutable' : 'no-cache');
  });
  app.use('*', serveStatic({ root: './dist' }));
  app.get('*', serveStatic({ path: './dist/index.html' }));
}

serve({ fetch: app.fetch, port: PORT, hostname: HOST }, () => {
  console.log(`listening-calendar server on http://${HOST}:${PORT}`);
  if (!spotify.isConfigured()) console.log('Spotify credentials missing: copy .env.example to .env and fill it in.');
  // COLLECT=0 leaves collection to the separate worker (server/worker.ts).
  if (process.env.COLLECT !== '0') {
    void collect();
    setInterval(collect, SYNC_INTERVAL);
  }
});
