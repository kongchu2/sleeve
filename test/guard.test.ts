import assert from 'node:assert/strict';
import { test } from 'node:test';
import { Hono } from 'hono';
import { allowedHostsFromEnv, isAllowedHost, requestGuard } from '../server/guard.ts';

const allowed = allowedHostsFromEnv({ APP_URL: 'https://sleeve.example.ts.net/', ALLOWED_HOSTS: 'Music.Home, other.lan' });

function app() {
  const a = new Hono();
  a.use(requestGuard(allowed));
  a.get('/api/plays', (c) => c.json([]));
  a.post('/auth/logout', (c) => c.json({ ok: true }));
  a.get('/auth/callback', (c) => c.text('ok'));
  a.get('/', (c) => c.text('page'));
  return a;
}

const status = async (method: string, path: string, headers: Record<string, string>) =>
  (await app().request(`http://127.0.0.1:8787${path}`, { method, headers })).status;

test('hosts: loopback names, any IP, and the configured names are allowed', () => {
  for (const host of ['127.0.0.1:8787', 'localhost:5180', '[::1]:8787', '100.101.102.103', 'sleeve.example.ts.net', 'music.home:8787', 'OTHER.LAN'])
    assert.ok(isAllowedHost(host, allowed), host);
  for (const host of ['evil.example', 'localhost.evil.example', '127.0.0.1.nip.io:8787'])
    assert.ok(!isAllowedHost(host, allowed), host);
});

test('a page on a rebound domain gets nothing, not even the page itself', async () => {
  assert.equal(await status('GET', '/api/plays', { host: 'rebind.evil.example:8787', 'sec-fetch-site': 'same-origin' }), 403);
  assert.equal(await status('GET', '/', { host: 'rebind.evil.example:8787' }), 403);
});

test("sleeve's own pages and non-browser clients get through", async () => {
  assert.equal(await status('GET', '/api/plays', { host: '127.0.0.1:8787', 'sec-fetch-site': 'same-origin' }), 200);
  assert.equal(await status('POST', '/auth/logout', { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:8787', 'sec-fetch-site': 'same-origin' }), 200);
  // The Vite dev server proxies with the browser's Host and Origin.
  assert.equal(await status('POST', '/auth/logout', { host: '127.0.0.1:5180', origin: 'http://127.0.0.1:5180' }), 200);
  assert.equal(await status('POST', '/auth/logout', { host: '127.0.0.1:8787' }), 200); // curl
});

test('other sites cannot sign you out or read the API', async () => {
  assert.equal(await status('POST', '/auth/logout', { host: '127.0.0.1:8787', origin: 'https://evil.example', 'sec-fetch-site': 'cross-site' }), 403);
  // Older browsers without Sec-Fetch-*: the Origin gives it away.
  assert.equal(await status('POST', '/auth/logout', { host: '127.0.0.1:8787', origin: 'https://evil.example' }), 403);
  assert.equal(await status('POST', '/auth/logout', { host: '127.0.0.1:8787', origin: 'null' }), 403);
  // Another app on localhost is same-site but not same-origin.
  assert.equal(await status('POST', '/auth/logout', { host: '127.0.0.1:8787', origin: 'http://127.0.0.1:3000', 'sec-fetch-site': 'same-site' }), 403);
  assert.equal(await status('GET', '/api/plays', { host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site' }), 403);
});

test("Spotify's redirect back and opening the page from a link still work", async () => {
  assert.equal(await status('GET', '/auth/callback', { host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site' }), 200);
  assert.equal(await status('GET', '/', { host: '127.0.0.1:8787', 'sec-fetch-site': 'cross-site' }), 200);
});
