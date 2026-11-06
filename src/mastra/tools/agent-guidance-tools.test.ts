import { describe, it, expect, vi, beforeEach } from 'vitest';

const authenticatedTrpcQuery = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcQuery: (...args: unknown[]) => authenticatedTrpcQuery(...args),
}));

import { getContextTool, getMethodTool } from './agent-guidance-tools.js';

function makeRequestContext(overrides: Record<string, string | undefined> = {}) {
  const entries: [string, string][] = [];
  for (const [k, v] of Object.entries({ authToken: 'token-123', userId: 'user-1', workspaceId: 'ws-1', ...overrides })) {
    if (v !== undefined) entries.push([k, v]);
  }
  return new Map<string, string>(entries);
}

/** tRPC GET endpoint → [procedure, decoded input.json]. */
function splitEndpoint(endpoint: string): [string, unknown] {
  const [procedure, query] = endpoint.split('?');
  const input = new URLSearchParams(query).get('input');
  return [procedure!, input ? JSON.parse(input).json : undefined];
}

const METHOD = {
  version: '0.1.0',
  status: 'draft',
  contentHash: 'sha256:abc',
  publishedAt: null,
  canonicalSource: { repo: 'positonic/exponential', path: 'content/docs/method', url: null },
  documents: [{ id: 'method', title: 'The Exponential Method', href: '/docs/method', markdown: '# Method' }],
};

/**
 * The guidance tools are thin wrappers over the app's `agentGuidance` router
 * (the same procedures MCP and CLI agents call). These tests pin the request
 * shape and the one piece of local behaviour: "no method yet" is a result,
 * not an error.
 */
describe('get-method', () => {
  // Block body: vitest treats a function returned from beforeEach as a
  // teardown hook, and mockReset() returns the mock itself.
  beforeEach(() => {
    authenticatedTrpcQuery.mockReset();
  });

  it('queries agentGuidance.method with the workspace from context and returns the payload', async () => {
    authenticatedTrpcQuery.mockResolvedValue({ data: METHOD });
    const result = await getMethodTool.execute!({}, { requestContext: makeRequestContext() } as never);

    expect(authenticatedTrpcQuery).toHaveBeenCalledTimes(1);
    const [endpoint, auth] = authenticatedTrpcQuery.mock.calls[0]!;
    expect(splitEndpoint(endpoint)).toEqual(['agentGuidance.method', { workspaceId: 'ws-1' }]);
    expect(auth).toMatchObject({ authToken: 'token-123', userId: 'user-1' });
    expect(result).toEqual({ available: true, ...METHOD });
  });

  it('sends no workspace when the context has none', async () => {
    authenticatedTrpcQuery.mockResolvedValue({ data: METHOD });
    await getMethodTool.execute!({}, { requestContext: makeRequestContext({ workspaceId: undefined }) } as never);
    expect(splitEndpoint(authenticatedTrpcQuery.mock.calls[0]![0])).toEqual(['agentGuidance.method', {}]);
  });

  it('reports "no published method yet" as unavailable rather than failing', async () => {
    authenticatedTrpcQuery.mockImplementation(async () => {
      throw new Error('Request failed: 404 Not Found - {"error":{"json":{"message":"No published method yet"}}}');
    });
    const result = await getMethodTool.execute!({}, { requestContext: makeRequestContext() } as never);
    expect(result).toEqual({ available: false, message: 'No published method yet' });
  });

  it('rethrows a non-404 failure even if it carries the same words', async () => {
    authenticatedTrpcQuery.mockImplementation(async () => {
      throw new Error('Request failed: 500 Internal Server Error - No published method yet');
    });
    await expect(
      getMethodTool.execute!({}, { requestContext: makeRequestContext() } as never),
    ).rejects.toThrow('500');
  });

  it('rethrows any other failure', async () => {
    authenticatedTrpcQuery.mockImplementation(async () => {
      throw new Error('Request failed: 500 Internal Server Error');
    });
    await expect(
      getMethodTool.execute!({}, { requestContext: makeRequestContext() } as never),
    ).rejects.toThrow('500');
  });

  it('refuses without an auth token', async () => {
    await expect(
      getMethodTool.execute!({}, { requestContext: makeRequestContext({ authToken: undefined }) } as never),
    ).rejects.toThrow('No authentication token');
  });
});

const CONTEXT = {
  workspace: { id: 'ws-1', slug: 'exponential', name: 'Exponential' },
  project: { id: 'proj-1', name: 'Launch' },
  authority: 'guidance',
  instructions: [{ scope: 'workspace', sourceId: 'ws-1', text: 'Be brief.' }],
  assembled: '<user_data>Be brief.</user_data>',
  revision: 'sha256:def',
  generatedAt: '2026-10-11T17:00:00.000Z',
};

describe('get-context', () => {
  beforeEach(() => {
    authenticatedTrpcQuery.mockReset();
  });

  it('queries agentGuidance.context for the context workspace and returns the payload unchanged', async () => {
    authenticatedTrpcQuery.mockResolvedValue({ data: CONTEXT });
    const result = await getContextTool.execute!({}, { requestContext: makeRequestContext() } as never);

    const [endpoint, auth] = authenticatedTrpcQuery.mock.calls[0]!;
    expect(splitEndpoint(endpoint)).toEqual(['agentGuidance.context', { workspaceId: 'ws-1' }]);
    expect(auth).toMatchObject({ authToken: 'token-123', userId: 'user-1' });
    expect(result).toEqual(CONTEXT);
  });

  it('forwards projectId, and an explicit workspaceId over the context one', async () => {
    authenticatedTrpcQuery.mockResolvedValue({ data: CONTEXT });
    await getContextTool.execute!(
      { workspaceId: 'ws-2', projectId: 'proj-1' },
      { requestContext: makeRequestContext() } as never,
    );
    expect(splitEndpoint(authenticatedTrpcQuery.mock.calls[0]![0])).toEqual([
      'agentGuidance.context',
      { workspaceId: 'ws-2', projectId: 'proj-1' },
    ]);
  });

  it('asks for a workspace when neither the input nor the context has one', async () => {
    await expect(
      getContextTool.execute!({}, { requestContext: makeRequestContext({ workspaceId: undefined }) } as never),
    ).rejects.toThrow(/get-user-workspaces/);
    expect(authenticatedTrpcQuery).not.toHaveBeenCalled();
  });
});
