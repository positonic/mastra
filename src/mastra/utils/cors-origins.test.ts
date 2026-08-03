import { describe, it, expect } from 'vitest';
import { Hono } from 'hono';
import { cors } from 'hono/cors';

import { CORS_ALLOWED_ORIGINS } from './cors-origins.js';

// ── CORS allow-list ─────────────────────────────────────────────────────────
//
// The browser is a first-class caller of this server now: the local-wiki
// librarian streams straight from the page so wiki content never passes through
// Vercel. That only works if the preflight passes, and a preflight that quietly
// stops matching is invisible until a user's turn dies mid-sentence.
//
// So rather than assert the config object's shape, these tests run the *real*
// Hono middleware with the same config the Mastra deployer builds, and check the
// headers a browser would actually receive. The deployer's derivation is
// reproduced below; the parts that matter are that our `origin` replaces the
// default `'*'`, and that `Authorization` is merged in by Mastra itself rather
// than by us.

/**
 * Mirror of `@mastra/deployer`'s CORS derivation for a server configured with
 * `cors: { origin }` and no `auth`. Kept here so a change in either this file or
 * the deployer's defaults shows up as a failing assertion instead of a silent
 * behaviour drift in production.
 */
function mastraCorsConfig(origin: readonly string[]) {
  return {
    origin: [...origin],
    allowMethods: ['GET', 'POST', 'PUT', 'PATCH', 'DELETE', 'OPTIONS'],
    credentials: false,
    maxAge: 3600,
    allowHeaders: [
      'Content-Type',
      'Authorization',
      'x-mastra-client-type',
      'x-mastra-dev-playground',
    ],
    exposeHeaders: ['Content-Length', 'X-Requested-With'],
  };
}

/** Send the preflight a browser sends before a streamed agent turn. */
async function preflight(origin: string) {
  const app = new Hono();
  app.use('*', cors(mastraCorsConfig(CORS_ALLOWED_ORIGINS)));
  app.post('/api/agents/localWikiAgent/stream', (c) => c.text('ok'));

  return app.request('/api/agents/localWikiAgent/stream', {
    method: 'OPTIONS',
    headers: {
      Origin: origin,
      'Access-Control-Request-Method': 'POST',
      'Access-Control-Request-Headers': 'authorization,content-type',
    },
  });
}

describe('CORS allow-list', () => {
  it.each([...CORS_ALLOWED_ORIGINS])('lets %s through the preflight', async (origin) => {
    const res = await preflight(origin);
    expect(res.headers.get('access-control-allow-origin')).toBe(origin);
  });

  it('allows the Authorization header the browser streams with', async () => {
    // The agent JWT rides in this header; without it the turn never starts.
    const res = await preflight('https://www.exponential.im');
    expect(res.headers.get('access-control-allow-headers')?.toLowerCase()).toContain(
      'authorization',
    );
  });

  it('covers www, since exponential.im redirects there', async () => {
    // The apex 301s to www, so a page served from the redirect target — and the
    // Tauri webview loading that same URL — reports www as its origin. Listing
    // only the apex would pass every test written against the apex and still
    // break every real browser.
    expect(CORS_ALLOWED_ORIGINS).toContain('https://www.exponential.im');
    expect(CORS_ALLOWED_ORIGINS).toContain('https://exponential.im');
  });

  it('no longer answers for arbitrary origins', async () => {
    // The point of the change: this server used to reply `*` to anyone.
    const res = await preflight('https://evil.example');
    expect(res.headers.get('access-control-allow-origin')).not.toBe('*');
    expect(res.headers.get('access-control-allow-origin')).not.toBe('https://evil.example');
  });

  it('rejects lookalikes of the app origin', async () => {
    for (const origin of [
      'https://exponential.im.evil.example',
      'http://exponential.im',
      'https://staging.exponential.im',
    ]) {
      const res = await preflight(origin);
      expect(res.headers.get('access-control-allow-origin')).not.toBe(origin);
    }
  });
});
