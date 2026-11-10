import { existsSync } from 'node:fs';
import { Hono } from 'hono';
import { serve } from '@hono/node-server';
import { serveStatic } from '@hono/node-server/serve-static';
import { collect } from './collector.ts';
import { db } from './db.ts';
import { getLyrics } from './lyrics.ts';
import * as spotify from './spotify.ts';

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
