/**
 * Browser origins allowed to call this server directly.
 *
 * Kept out of `index.ts` so it can be imported — and tested — without booting
 * Mastra and every gateway that comes with it.
 *
 * Only browsers are affected. Server-to-server callers (Exponential's API
 * routes, the iOS app, webhooks) never send an `Origin` header and are not
 * subject to CORS at all, so nothing existing rides on this list.
 *
 * Both apex and www appear because `exponential.im` 301s to `www`: a page served
 * from the redirect target reports `https://www.exponential.im` as its origin,
 * and so does the Tauri shell's webview, which loads that same remote URL.
 */
export const CORS_ALLOWED_ORIGINS = [
  'https://exponential.im',
  'https://www.exponential.im',
  // `next dev` — the only way to exercise the browser path while building it.
  'http://localhost:3000',
] as const;
