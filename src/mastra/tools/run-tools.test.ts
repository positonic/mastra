import { describe, it, expect, vi, beforeEach } from 'vitest';

const authenticatedTrpcCall = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: (...args: unknown[]) => authenticatedTrpcCall(...args),
}));

const { finishRunTool } = await import('./run-tools.js');

function makeRequestContext(overrides: Record<string, string> = {}) {
  return new Map<string, string>([
    ['authToken', 'run-jwt'],
    ['userId', 'shadow-user-1'],
    ...Object.entries(overrides),
  ]);
}

describe('finishRunTool', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('calls mastra.finishRun with summary and readyToClose, never a runId (that is a JWT claim)', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { ok: true } });

    const result = await finishRunTool.execute!(
      { summary: 'Found two venues; drafted a comparison.', readyToClose: false },
      { requestContext: makeRequestContext() } as never,
    );

    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.finishRun',
      { summary: 'Found two venues; drafted a comparison.', readyToClose: false },
      expect.objectContaining({ authToken: 'run-jwt', userId: 'shadow-user-1' }),
    );
    const [, payload] = authenticatedTrpcCall.mock.calls[0]!;
    expect(payload).not.toHaveProperty('runId');
    expect(result).toEqual({ finished: true });
  });

  it('refuses without a run token', async () => {
    await expect(
      finishRunTool.execute!(
        { summary: 'x', readyToClose: true },
        { requestContext: new Map() } as never,
      ),
    ).rejects.toThrow(/authentication token/);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });
});
