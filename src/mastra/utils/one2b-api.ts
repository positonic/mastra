/**
 * One2b Platform API Client
 *
 * The One2b platform uses tRPC with public procedures for lead creation.
 * Endpoints follow the pattern: POST /api/trpc/{router}.{procedure}
 * No authentication required for lead creation (publicProcedure).
 */

const ONE2B_BASE_URL = process.env.ONE2B_API_BASE_URL || 'http://localhost:3000';

/**
 * Call a tRPC mutation on the One2b platform.
 * tRPC mutations use POST with body: { json: input }
 */
export async function one2bTrpcMutation<T>(
  procedure: string,
  input: unknown,
): Promise<T> {
  const url = `${ONE2B_BASE_URL}/api/trpc/${procedure}`;

  console.log(`[one2b-api] POST ${procedure}`);

  const response = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ json: input }),
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Could not read response body');
    console.error(`[one2b-api] ${procedure} failed: ${response.status} - ${errorText}`);
    throw new Error(`One2b API error (${procedure}): ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as { result?: { data?: { json?: T } } };
  // Unwrap tRPC response structure
  const result = data.result?.data?.json ?? data.result?.data ?? data as unknown as T;
  return result as T;
}

/**
 * Call a tRPC query on the One2b platform.
 * tRPC queries use GET with input encoded in the URL.
 */
export async function one2bTrpcQuery<T>(
  procedure: string,
  input?: unknown,
): Promise<T> {
  let url = `${ONE2B_BASE_URL}/api/trpc/${procedure}`;

  if (input !== undefined) {
    const encoded = encodeURIComponent(JSON.stringify({ json: input }));
    url += `?input=${encoded}`;
  }

  console.log(`[one2b-api] GET ${procedure}`);

  const response = await fetch(url, {
    method: 'GET',
    headers: { 'Content-Type': 'application/json' },
  });

  if (!response.ok) {
    const errorText = await response.text().catch(() => 'Could not read response body');
    console.error(`[one2b-api] ${procedure} failed: ${response.status} - ${errorText}`);
    throw new Error(`One2b API error (${procedure}): ${response.status} - ${errorText}`);
  }

  const data = (await response.json()) as { result?: { data?: { json?: T } } };
  // tRPC wraps in { result: { data: { json: <actual> } } }
  // When the result is null (not found), json will be null — return null, not the wrapper
  const json = data.result?.data?.json;
  if (json !== undefined) return json as T;
  return data.result?.data as unknown as T;
}

/**
 * Search the web using Serper.dev API for contact research.
 */
export async function serperSearch(query: string, options?: { num?: number }): Promise<SerperResult[]> {
  const apiKey = process.env.SERPER_API_KEY;
  if (!apiKey) {
    throw new Error('SERPER_API_KEY is not configured');
  }

  const response = await fetch('https://google.serper.dev/search', {
    method: 'POST',
    headers: {
      'X-API-KEY': apiKey,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify({
      q: query,
      num: options?.num ?? 5,
    }),
  });

  if (!response.ok) {
    throw new Error(`Serper API error: ${response.status} ${response.statusText}`);
  }

  const data = (await response.json()) as SerperResponse;
  return data.organic ?? [];
}

export interface SerperResult {
  title: string;
  link: string;
  snippet: string;
  position?: number;
}

interface SerperResponse {
  organic?: SerperResult[];
  knowledgeGraph?: {
    title?: string;
    description?: string;
    type?: string;
  };
}
