import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the authenticated tRPC transport so the tool's execute can be exercised
// without a running backend. We assert the tool maps its arguments onto the
// correct mastra endpoint (the ADR-0020 authenticated-callback shape) — the
// Notion credential is resolved server-side and never reaches this tool.
const authenticatedTrpcCall = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: (...args: unknown[]) => authenticatedTrpcCall(...args),
}));

const { notionSearchTool } = await import('./notion-tools.js');

function makeRequestContext(overrides: Record<string, string> = {}) {
  return new Map<string, string>([
    ['authToken', 'token-123'],
    ['userId', 'user-1'],
    ['workspaceId', 'ws-1'],
    ...Object.entries(overrides),
  ]);
}

describe('notionSearchTool', () => {
  beforeEach(() => {
    authenticatedTrpcCall.mockReset();
  });

  it('calls mastra.notionSearch with the mapped arguments + workspaceId from context', async () => {
    const serverResult = {
      connected: true,
      total: 1,
      results: [{ id: 'p1', type: 'page', title: 'Payments', url: 'https://notion.so/p1' }],
      hasMore: false,
    };
    authenticatedTrpcCall.mockResolvedValue({ data: serverResult });

    const result = await notionSearchTool.execute!(
      { query: 'payments', filter: 'database' },
      { requestContext: makeRequestContext() } as never,
    );

    expect(authenticatedTrpcCall).toHaveBeenCalledTimes(1);
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.notionSearch',
      { query: 'payments', filter: 'database', workspaceId: 'ws-1' },
      expect.objectContaining({ authToken: 'token-123', userId: 'user-1' }),
    );
    expect(result).toEqual(serverResult);
  });

  it('passes workspaceId: undefined when none is in context', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { connected: false } });

    await notionSearchTool.execute!(
      { query: 'anything' },
      { requestContext: new Map([['authToken', 't'], ['userId', 'u']]) } as never,
    );

    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.notionSearch',
      { query: 'anything', filter: undefined, workspaceId: undefined },
      expect.objectContaining({ authToken: 't', userId: 'u' }),
    );
  });

  it('throws when no auth token is present (never reaches the backend)', async () => {
    await expect(
      notionSearchTool.execute!(
        { query: 'x' },
        { requestContext: new Map() } as never,
      ),
    ).rejects.toThrow(/authentication token/i);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });

  it('surfaces a backend failure as an { error } result', async () => {
    authenticatedTrpcCall.mockRejectedValue(new Error('boom'));

    const result = await notionSearchTool.execute!(
      { query: 'x' },
      { requestContext: makeRequestContext() } as never,
    );

    expect(result).toEqual({ error: 'boom' });
  });
});
