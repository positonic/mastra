import SuperJSON from 'superjson';
import { captureAuthFailure } from './sentry.js';
import { verifyAndExtractUserId } from './gateway-shared.js';

const TODO_APP_BASE_URL = process.env.TODO_APP_BASE_URL || 'http://localhost:3000';
const WHATSAPP_GATEWAY_SECRET = process.env.WHATSAPP_GATEWAY_SECRET;
const GATEWAY_SECRET = process.env.GATEWAY_SECRET ?? WHATSAPP_GATEWAY_SECRET;

export type TokenKind = 'whatsapp-gateway' | 'telegram-gateway';

export interface AuthenticatedFetchOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  authToken: string;
  sessionId?: string;
  userId?: string;
  /**
   * Which refresh endpoint to call on 401. WhatsApp uses sessionId-based
   * refresh (per-session DB record). Telegram uses userId-based refresh
   * (no sessionId required). Defaults to 'whatsapp-gateway' for backwards
   * compatibility — pre-existing callers all passed sessionId.
   */
  tokenKind?: TokenKind;
}

export interface AuthenticatedFetchResult<T> {
  data: T;
  refreshedToken?: string;
}

/**
 * Attempt to refresh an auth token via the WhatsApp gateway refresh endpoint.
 * Returns the new token or null if refresh fails.
 */
async function refreshWhatsappToken(sessionId: string, expectedUserId?: string): Promise<string | null> {
  if (!WHATSAPP_GATEWAY_SECRET) {
    console.warn('[authenticated-fetch] Cannot refresh token: WHATSAPP_GATEWAY_SECRET not configured');
    return null;
  }

  if (!sessionId) {
    console.warn('[authenticated-fetch] Cannot refresh token: No sessionId provided');
    return null;
  }

  try {
    console.log(`[authenticated-fetch] Attempting WhatsApp token refresh for session ${sessionId}`);

    const response = await fetch(`${TODO_APP_BASE_URL}/api/whatsapp-gateway/refresh-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Secret': WHATSAPP_GATEWAY_SECRET,
      },
      body: JSON.stringify({ sessionId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[authenticated-fetch] WhatsApp token refresh failed: ${response.status} - ${errorText}`);
      return null;
    }

    const data = (await response.json()) as { token: string; expiresAt: string };

    if (expectedUserId) {
      try {
        const refreshedUserId = verifyAndExtractUserId(data.token, { audience: 'whatsapp-gateway' });
        if (refreshedUserId !== expectedUserId) {
          console.error(`[authenticated-fetch] SECURITY: Token refresh returned userId ${refreshedUserId} but expected ${expectedUserId}. Rejecting.`);
          return null;
        }
      } catch (verifyError) {
        console.error('[authenticated-fetch] SECURITY: Failed to verify refreshed token:', verifyError);
        return null;
      }
    }

    console.log(`[authenticated-fetch] WhatsApp token refreshed successfully, expires at ${data.expiresAt}`);
    return data.token;
  } catch (error) {
    console.error('[authenticated-fetch] WhatsApp token refresh error:', error);
    return null;
  }
}

/**
 * Attempt to refresh a Telegram gateway auth token.
 * Telegram refresh takes only userId — there's no per-session DB record,
 * so it works even when a stored token (e.g. in telegram-mappings.json)
 * has expired and we have no sessionId to pass.
 */
async function refreshTelegramToken(userId: string): Promise<string | null> {
  if (!GATEWAY_SECRET) {
    console.warn('[authenticated-fetch] Cannot refresh telegram token: GATEWAY_SECRET not configured');
    return null;
  }

  if (!userId) {
    console.warn('[authenticated-fetch] Cannot refresh telegram token: No userId provided');
    return null;
  }

  try {
    console.log(`[authenticated-fetch] Attempting Telegram token refresh for user ${userId}`);

    const response = await fetch(`${TODO_APP_BASE_URL}/api/telegram-gateway/refresh-token`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Gateway-Secret': GATEWAY_SECRET,
      },
      body: JSON.stringify({ userId }),
    });

    if (!response.ok) {
      const errorText = await response.text();
      console.error(`[authenticated-fetch] Telegram token refresh failed: ${response.status} - ${errorText}`);
      return null;
    }

    const data = (await response.json()) as { token: string; expiresAt: string };

    try {
      const refreshedUserId = verifyAndExtractUserId(data.token, { audience: 'telegram-gateway' });
      if (refreshedUserId !== userId) {
        console.error(`[authenticated-fetch] SECURITY: Telegram refresh returned userId ${refreshedUserId} but expected ${userId}. Rejecting.`);
        return null;
      }
    } catch (verifyError) {
      console.error('[authenticated-fetch] SECURITY: Failed to verify refreshed Telegram token:', verifyError);
      return null;
    }

    console.log(`[authenticated-fetch] Telegram token refreshed successfully, expires at ${data.expiresAt}`);
    return data.token;
  } catch (error) {
    console.error('[authenticated-fetch] Telegram token refresh error:', error);
    return null;
  }
}

/**
 * Make an authenticated API call with automatic token refresh on 401.
 *
 * @param options - Fetch options including auth token
 * @returns The response data and optionally a refreshed token
 * @throws Error if request fails after retry
 */
export async function authenticatedFetch<T>(
  options: AuthenticatedFetchOptions
): Promise<AuthenticatedFetchResult<T>> {
  const { url, method = 'GET', body, authToken, sessionId, userId, tokenKind = 'whatsapp-gateway' } = options;

  const makeRequest = async (token: string): Promise<Response> => {
    const headers: Record<string, string> = {
      Authorization: `Bearer ${token}`,
    };

    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }

    return fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });
  };

  // First attempt
  let response = await makeRequest(authToken);

  // Refresh routing: telegram needs only userId, whatsapp needs sessionId.
  // Pre-existing whatsapp callers (gateway-shared encryptedAuthToken flows)
  // continue to work because tokenKind defaults to 'whatsapp-gateway'.
  const canRefresh =
    response.status === 401 &&
    (
      (tokenKind === 'whatsapp-gateway' && Boolean(sessionId)) ||
      (tokenKind === 'telegram-gateway' && Boolean(userId))
    );

  if (canRefresh) {
    console.log(`[authenticated-fetch] Got 401 from ${url}, attempting ${tokenKind} token refresh...`);

    const newToken =
      tokenKind === 'telegram-gateway'
        ? await refreshTelegramToken(userId!)
        : await refreshWhatsappToken(sessionId!, userId);

    if (newToken) {
      console.log(`[authenticated-fetch] Retrying request with refreshed token...`);
      response = await makeRequest(newToken);

      if (response.ok) {
        const data = (await response.json()) as T;
        return { data, refreshedToken: newToken };
      }

      const retryErrorText = await response.text().catch(() => 'Could not read response body');
      console.error(`[authenticated-fetch] Retry failed with status ${response.status}: ${retryErrorText}`);
    }

    // Refresh failed or retry failed - capture to Sentry
    captureAuthFailure(new Error(`Authentication failed for ${url}`), {
      userId,
      sessionId,
      endpoint: url,
      statusCode: response.status,
    });

    throw new Error(`Authentication failed: ${response.status} ${response.statusText}`);
  }

  // Handle other error statuses
  if (!response.ok) {
    const errorText = await response.text();
    throw new Error(`Request failed: ${response.status} ${response.statusText} - ${errorText}`);
  }

  const data = (await response.json()) as T;
  return { data };
}

/**
 * superjson `meta.values` annotation tree (see superjson's plainer.ts):
 * a node is either `{escapedPathKey: subtree}` or `[annotation, children?]`,
 * where a leaf annotation is e.g. "undefined" / "Date" / "set".
 */
type SuperjsonTree = [unknown, Record<string, SuperjsonTree>?] | { [key: string]: SuperjsonTree };

/**
 * Keep only the "undefined" annotations of a superjson `meta.values` tree,
 * dropping everything else (Date/bigint/set/map/class revivals). Returns
 * undefined when nothing survives. Path keys are copied verbatim — they are
 * escaped path strings that only superjson itself should parse.
 */
function filterUndefinedAnnotations(tree: SuperjsonTree): SuperjsonTree | undefined {
  if (Array.isArray(tree)) {
    const [annotation, children] = tree;
    const keptChildren = children ? filterChildAnnotations(children) : undefined;
    if (annotation === 'undefined') {
      return keptChildren ? ['undefined', keptChildren] : ['undefined'];
    }
    return keptChildren;
  }
  return filterChildAnnotations(tree);
}

function filterChildAnnotations(
  children: Record<string, SuperjsonTree>,
): Record<string, SuperjsonTree> | undefined {
  const kept: Record<string, SuperjsonTree> = {};
  for (const [key, subtree] of Object.entries(children)) {
    const filtered = filterUndefinedAnnotations(subtree);
    if (filtered) kept[key] = filtered;
  }
  return Object.keys(kept).length > 0 ? kept : undefined;
}

/**
 * Unwrap a tRPC response payload, honoring the superjson envelope.
 *
 * The backend serializes with superjson, which encodes `undefined` values as
 * `null` in `json` plus an "undefined" annotation in `meta.values`. The old
 * unwrap dropped `meta`, so optional fields the server left unset (e.g. a
 * ticket preview with no points/priority) arrived as `null` and failed the
 * tools' zod output schemas (`z.number().optional()` rejects null).
 *
 * We deliberately apply ONLY the "undefined" annotations: reviving Dates &co.
 * would hand Date instances to output schemas that (correctly, for LLM-facing
 * results) declare those fields as ISO strings.
 */
export function unwrapSuperjson<T>(rawData: unknown): T {
  if (rawData && typeof rawData === 'object' && 'json' in rawData) {
    const { json, meta } = rawData as {
      json: unknown;
      meta?: { values?: SuperjsonTree; v?: number };
    };
    const values = meta?.values ? filterUndefinedAnnotations(meta.values) : undefined;
    if (values) {
      return SuperJSON.deserialize({
        json,
        meta: { values, v: meta?.v },
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
      } as any) as T;
    }
    return json as T;
  }
  return rawData as T;
}

/**
 * Convenience wrapper for tRPC POST endpoints (the most common pattern in tools).
 * Handles the tRPC response structure automatically.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function authenticatedTrpcCall<T = any>(
  endpoint: string,
  input: unknown,
  options: {
    authToken: string;
    sessionId?: string;
    userId?: string;
    tokenKind?: TokenKind;
  }
): Promise<AuthenticatedFetchResult<T>> {
  const url = `${TODO_APP_BASE_URL}/api/trpc/${endpoint}`;

  const result = await authenticatedFetch<{ result?: { data?: T }; json?: T }>({
    url,
    method: 'POST',
    body: {
      json: input,
      meta: {},
    },
    ...options,
  });

  // tRPC responses can have different structures
  const rawData = result.data.result?.data || result.data.json || result.data;

  return {
    data: unwrapSuperjson<T>(rawData),
    refreshedToken: result.refreshedToken,
  };
}

/**
 * Convenience wrapper for tRPC GET endpoints.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export async function authenticatedTrpcQuery<T = any>(
  endpoint: string,
  options: {
    authToken: string;
    sessionId?: string;
    userId?: string;
    tokenKind?: TokenKind;
  }
): Promise<AuthenticatedFetchResult<T>> {
  const url = `${TODO_APP_BASE_URL}/api/trpc/${endpoint}`;

  const result = await authenticatedFetch<{ result?: { data?: T }; json?: T }>({
    url,
    method: 'GET',
    ...options,
  });

  // tRPC responses can have different structures
  const rawData = result.data.result?.data || result.data.json || result.data;

  return {
    data: unwrapSuperjson<T>(rawData),
    refreshedToken: result.refreshedToken,
  };
}
