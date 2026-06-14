import { describe, it, expect, vi, beforeEach } from 'vitest';

// Mock the authenticated tRPC transport so the tool's execute can be exercised
// without a running backend. We assert the tool maps its arguments onto the
// correct mastra endpoint.
const authenticatedTrpcCall = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: (...args: unknown[]) => authenticatedTrpcCall(...args),
}));

const { addObjectiveCommentTool } = await import('./okr-tools.js');

function makeRequestContext(overrides: Record<string, string> = {}) {
  const map = new Map<string, string>([
    ['authToken', 'token-123'],
    ['userId', 'user-1'],
    ...Object.entries(overrides),
  ]);
  return map;
}

describe('addObjectiveCommentTool', () => {
  beforeEach(() => {
    authenticatedTrpcCall.mockReset();
  });

  it('calls mastra.addGoalComment with the mapped arguments', async () => {
    const created = {
      id: 'c1',
      goalId: 42,
      authorId: 'user-1',
      content: 'Strategy summary',
      createdAt: '2026-06-14T00:00:00.000Z',
    };
    authenticatedTrpcCall.mockResolvedValue({ data: created });

    const result = await addObjectiveCommentTool.execute!(
      { goalId: 42, content: 'Strategy summary' },
      { requestContext: makeRequestContext() } as never,
    );

    expect(authenticatedTrpcCall).toHaveBeenCalledTimes(1);
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.addGoalComment',
      { goalId: 42, content: 'Strategy summary' },
      expect.objectContaining({ authToken: 'token-123', userId: 'user-1' }),
    );
    expect(result).toEqual(created);
  });

  it('throws when no auth token is present', async () => {
    await expect(
      addObjectiveCommentTool.execute!(
        { goalId: 42, content: 'x' },
        { requestContext: new Map() } as never,
      ),
    ).rejects.toThrow(/authentication token/i);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });
});
