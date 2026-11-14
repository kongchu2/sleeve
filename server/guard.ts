import { isIP } from 'node:net';
import type { MiddlewareHandler } from 'hono';

/**
 * Binding to loopback keeps other machines out, but not other websites open in the same browser:
 * - DNS rebinding: a page on a domain that resolves to 127.0.0.1 is "same-origin" with this server, so it
 *   can read the API. The Host header still carries that domain, so only expected hosts are let through.
 * - Cross-site requests: any page can send a no-cors POST (sign out, import fake plays) or load /api URLs.
 *   Browsers say where a request came from (Sec-Fetch-Site, Origin), so those are refused.
 * Clients that send neither header (curl, scripts) are not browsers and are let through.
 */

const LOOPBACK_NAMES = ['localhost'];

/** Host names (not IPs: those can't be rebound) the server answers to, from the env and its own URLs. */
export function allowedHostsFromEnv(env: NodeJS.ProcessEnv = process.env): Set<string> {
  const hosts = new Set(LOOPBACK_NAMES);
  for (const url of [env.APP_URL, env.SPOTIFY_REDIRECT_URI]) {
    const host = hostnameOf(url);
    if (host) hosts.add(host);
  }
  for (const host of (env.ALLOWED_HOSTS ?? '').split(',')) {
    if (host.trim()) hosts.add(host.trim().toLowerCase());
  }
  return hosts;
}

function hostnameOf(url: string | undefined): string | undefined {
  if (!url) return undefined;
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return undefined; // a relative APP_URL such as '/'
  }
}

/** The host name of a Host header value, without port or IPv6 brackets. */
function hostHeaderName(host: string): string | undefined {
  try {
    return new URL(`http://${host}`).hostname.toLowerCase().replace(/^\[(.*)\]$/, '$1');
  } catch {
    return undefined;
  }
}

export function isAllowedHost(host: string | undefined, allowed: Set<string>): boolean {
  if (!host) return true; // HTTP/1.0 without Host: not a browser
  const name = hostHeaderName(host);
  if (!name) return false;
  return isIP(name) !== 0 || allowed.has(name);
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/** Whether the request was made by a page on another origin (or one that hides its origin). */
export function isCrossSite(headers: Headers): boolean {
  const site = headers.get('sec-fetch-site');
  if (site) return site !== 'same-origin' && site !== 'none';
  const origin = headers.get('origin');
  if (!origin) return false;
  const host = headers.get('host');
  try {
    return !host || new URL(origin).host.toLowerCase() !== host.toLowerCase();
  } catch {
    return true; // "null" from sandboxed frames and file:// pages
  }
}

/** Each refused host is logged once, and only the first few: anyone can send any Host header. */
const MAX_WARNED_HOSTS = 20;
const warnedHosts = new Set<string>();

export function requestGuard(allowedHosts: Set<string> = allowedHostsFromEnv()): MiddlewareHandler {
  return async (c, next) => {
    const host = c.req.header('host');
    if (!isAllowedHost(host, allowedHosts)) {
      const name = host ?? '';
      if (!warnedHosts.has(name) && warnedHosts.size < MAX_WARNED_HOSTS) {
        warnedHosts.add(name);
        console.warn(`Refused a request for host "${name}". If that is how you reach sleeve, add it to ALLOWED_HOSTS.`);
      }
      return c.text('Host not allowed. Set ALLOWED_HOSTS to the host name you use to reach sleeve.', 403);
    }
    // Everything that changes state, and all of /api (it exposes your history), only from sleeve's own pages.
    // Other GETs stay open: /auth/callback is a cross-site navigation back from Spotify.
    const guarded = !SAFE_METHODS.has(c.req.method) || c.req.path.startsWith('/api/');
    if (guarded && isCrossSite(c.req.raw.headers)) return c.json({ error: 'cross-site request refused' }, 403);
    await next();
  };
}
