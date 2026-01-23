import { captureAuthFailure } from './sentry.js';

const TODO_APP_BASE_URL = process.env.TODO_APP_BASE_URL || 'http://localhost:3000';
const WHATSAPP_GATEWAY_SECRET = process.env.WHATSAPP_GATEWAY_SECRET;

export interface AuthenticatedFetchOptions {
  url: string;
  method?: 'GET' | 'POST' | 'PUT' | 'DELETE';
  body?: unknown;
  authToken: string;
  sessionId?: string;
  userId?: string;
}

export interface AuthenticatedFetchResult<T> {
  data: T;
  refreshedToken?: string;
}

/**
 * Attempt to refresh an auth token via the WhatsApp gateway refresh endpoint.
 * Returns the new token or null if refresh fails.
 */
async function refreshToken(sessionId: string): Promise<string | null> {
  if (!WHATSAPP_GATEWAY_SECRET) {
    console.warn('[authenticated-fetch] Cannot refresh token: WHATSAPP_GATEWAY_SECRET not configured');
    return null;
  }

  if (!sessionId) {
    console.warn('[authenticated-fetch] Cannot refresh token: No sessionId provided');
    return null;
  }

  try {
    console.log(`[authenticated-fetch] Attempting token refresh for session ${sessionId}`);

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
      console.error(`[authenticated-fetch] Token refresh failed: ${response.status} - ${errorText}`);
      return null;
    }

    const data = (await response.json()) as { token: string; expiresAt: string };
    console.log(`[authenticated-fetch] Token refreshed successfully, expires at ${data.expiresAt}`);
    return data.token;
  } catch (error) {
    console.error('[authenticated-fetch] Token refresh error:', error);
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
  const { url, method = 'GET', body, authToken, sessionId, userId } = options;

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

  // Check for 401 and attempt refresh
  if (response.status === 401 && sessionId) {
    console.log(`[authenticated-fetch] Got 401 from ${url}, attempting token refresh...`);

    const newToken = await refreshToken(sessionId);

    if (newToken) {
      // Retry with new token
      console.log(`[authenticated-fetch] Retrying request with refreshed token...`);
      response = await makeRequest(newToken);

      if (response.ok) {
        const data = (await response.json()) as T;
        return { data, refreshedToken: newToken };
      }

      // Log the actual error for debugging
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
 * Convenience wrapper for tRPC POST endpoints (the most common pattern in tools).
 * Handles the tRPC response structure automatically.
 */
export async function authenticatedTrpcCall<T>(
  endpoint: string,
  input: unknown,
  options: {
    authToken: string;
    sessionId?: string;
    userId?: string;
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
  const data = result.data.result?.data || result.data.json || (result.data as T);

  return {
    data,
    refreshedToken: result.refreshedToken,
  };
}

/**
 * Convenience wrapper for tRPC GET endpoints.
 */
export async function authenticatedTrpcQuery<T>(
  endpoint: string,
  options: {
    authToken: string;
    sessionId?: string;
    userId?: string;
  }
): Promise<AuthenticatedFetchResult<T>> {
  const url = `${TODO_APP_BASE_URL}/api/trpc/${endpoint}`;

  const result = await authenticatedFetch<{ result?: { data?: T }; json?: T }>({
    url,
    method: 'GET',
    ...options,
  });

  // tRPC responses can have different structures
  const data = result.data.result?.data || result.data.json || (result.data as T);

  return {
    data,
    refreshedToken: result.refreshedToken,
  };
}
