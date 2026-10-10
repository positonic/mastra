import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the authenticated tRPC transport so no network call is made.
const authenticatedTrpcCall = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: (...args: unknown[]) => authenticatedTrpcCall(...args),
}));

const { saveToReadingListTool, listReadingListTool, markReadingListItemTool } = await import(
  './reading-list-tools.js'
);

function makeRequestContext(overrides: Record<string, string> = {}) {
  return new Map<string, string>([
    ['authToken', 'token-123'],
    ['userId', 'user-1'],
    ['workspaceId', 'ws-1'],
    ...Object.entries(overrides),
  ]);
}

describe('saveToReadingListTool', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('only saves links the user asked to save (never ones found in content)', () => {
    expect(saveToReadingListTool.description).toMatch(/ONLY when the user asks/i);
    expect(saveToReadingListTool.description).toMatch(/never for a link that merely came up/i);
  });

  it('files the URL as a to_read bookmark in the context workspace, never embedded', async () => {
    const serverResult = { resource: { id: 'r1', title: 'example.com', url: 'https://www.example.com/post' } };
    authenticatedTrpcCall.mockResolvedValue({ data: serverResult });

    const result = await saveToReadingListTool.execute!(
      { url: 'https://www.example.com/post', note: 'from Sam' },
      { requestContext: makeRequestContext() } as never,
    );

    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'resource.create',
      {
        title: 'example.com',
        url: 'https://www.example.com/post',
        description: 'from Sam',
        contentType: 'bookmark',
        readStatus: 'to_read',
        generateEmbeddings: false,
        workspaceId: 'ws-1',
      },
      expect.objectContaining({ authToken: 'token-123', userId: 'user-1' }),
    );
    expect(result).toEqual(serverResult);
  });

  it('keeps an explicit title', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { resource: { id: 'r1', title: 'Essay' } } });
    await saveToReadingListTool.execute!(
      { url: 'https://example.com/x', title: '  Essay  ' },
      { requestContext: makeRequestContext() } as never,
    );
    expect(authenticatedTrpcCall.mock.calls[0][1]).toMatchObject({ title: 'Essay', description: undefined });
  });

  it('throws when no auth token is present', async () => {
    await expect(
      saveToReadingListTool.execute!(
        { url: 'https://example.com/x' },
        { requestContext: new Map() } as never,
      ),
    ).rejects.toThrow(/authentication token/i);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });
});

describe('listReadingListTool', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('defaults to the unread queue scoped to the context workspace', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { resources: [] } });
    await listReadingListTool.execute!({}, { requestContext: makeRequestContext() } as never);
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'resource.list',
      { workspaceId: 'ws-1', readStatus: 'unread', limit: 20 },
      expect.objectContaining({ authToken: 'token-123' }),
    );
  });

  it('passes an explicit status and limit through', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { resources: [] } });
    await listReadingListTool.execute!(
      { status: 'read', limit: 5 },
      { requestContext: makeRequestContext() } as never,
    );
    expect(authenticatedTrpcCall.mock.calls[0][1]).toMatchObject({ readStatus: 'read', limit: 5 });
  });
});

describe('markReadingListItemTool', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('marks read by default via resource.setReadStatus', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { id: 'r1', readStatus: 'read', readAt: '2026-10-10T00:00:00Z' } });
    const out = await markReadingListItemTool.execute!(
      { resourceId: 'r1' },
      { requestContext: makeRequestContext() } as never,
    );
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'resource.setReadStatus',
      { id: 'r1', readStatus: 'read' },
      expect.objectContaining({ authToken: 'token-123' }),
    );
    expect(out).toMatchObject({ readStatus: 'read' });
  });
});
