import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the authenticated tRPC transport so no network call is made.
const authenticatedTrpcCall = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: (...args: unknown[]) => authenticatedTrpcCall(...args),
}));

const { createPageTool, updatePageTool } = await import('./knowledge-tools.js');

function makeRequestContext(overrides: Record<string, string> = {}) {
  return new Map<string, string>([
    ['authToken', 'token-123'],
    ['userId', 'user-1'],
    ['workspaceId', 'ws-1'],
    ...Object.entries(overrides),
  ]);
}

describe('createPageTool', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('mandates draft-and-confirm in its description (no silent writes)', () => {
    expect(createPageTool.description).toMatch(/draft-and-confirm/i);
    expect(createPageTool.description).toMatch(/confirm/i);
  });

  it('calls mastra.createPage with the body, title, and workspaceId from context', async () => {
    const serverResult = {
      page: {
        id: 'page-1',
        title: 'Our Process',
        workspaceId: 'ws-1',
        projectId: null,
        includeInSearch: true,
      },
    };
    authenticatedTrpcCall.mockResolvedValue({ data: serverResult });

    const result = await createPageTool.execute!(
      { title: 'Our Process', body: '# Our Process\nStep 1…' },
      { requestContext: makeRequestContext() } as never,
    );

    expect(authenticatedTrpcCall).toHaveBeenCalledTimes(1);
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.createPage',
      {
        workspaceId: 'ws-1',
        title: 'Our Process',
        body: '# Our Process\nStep 1…',
        projectId: undefined,
        includeInSearch: undefined,
      },
      expect.objectContaining({ authToken: 'token-123', userId: 'user-1' }),
    );
    expect(result).toEqual(serverResult);
  });

  it('throws when no auth token is present', async () => {
    await expect(
      createPageTool.execute!(
        { title: 'x', body: 'y' },
        { requestContext: new Map() } as never,
      ),
    ).rejects.toThrow(/authentication token/i);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });

  it('throws when no workspace is in context', async () => {
    await expect(
      createPageTool.execute!(
        { title: 'x', body: 'y' },
        { requestContext: new Map([['authToken', 't']]) } as never,
      ),
    ).rejects.toThrow(/workspace/i);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });
});

describe('updatePageTool', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('mandates draft-and-confirm in its description (no silent writes)', () => {
    expect(updatePageTool.description).toMatch(/draft-and-confirm/i);
    expect(updatePageTool.description).toMatch(/confirm/i);
  });

  it('calls mastra.updatePage with pageId and the update fields', async () => {
    const serverResult = {
      page: { id: 'page-1', title: 'Updated', includeInSearch: true },
    };
    authenticatedTrpcCall.mockResolvedValue({ data: serverResult });

    const result = await updatePageTool.execute!(
      { pageId: 'page-1', title: 'Updated', body: '# Updated' },
      { requestContext: makeRequestContext() } as never,
    );

    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.updatePage',
      {
        pageId: 'page-1',
        title: 'Updated',
        body: '# Updated',
        includeInSearch: undefined,
      },
      expect.objectContaining({ authToken: 'token-123', userId: 'user-1' }),
    );
    expect(result).toEqual(serverResult);
  });

  it('throws when no auth token is present', async () => {
    await expect(
      updatePageTool.execute!(
        { pageId: 'page-1', title: 'x' },
        { requestContext: new Map() } as never,
      ),
    ).rejects.toThrow(/authentication token/i);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });
});
