import { describe, it, expect, vi, beforeEach } from 'vitest';

const authenticatedTrpcCall = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: (...args: unknown[]) => authenticatedTrpcCall(...args),
}));

import { rescheduleActionsTool } from './project-tools.js';

function makeRequestContext() {
  return new Map<string, string>([
    ['authToken', 'token-123'],
    ['userId', 'user-1'],
  ]);
}

/**
 * `action.bulkReschedule` takes `date` — the do-date. The app moves
 * `scheduledStart` and only pushes `dueDate` forward where it would fall
 * before it (exponential#838); `dueDate` survives there only as a deprecated
 * alias. Sending it under that name is the confusion the PR removed.
 */
describe('reschedule-actions', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('sends the new do-date as `date`, never `dueDate`', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { count: 2, actionIds: ['a1', 'a2'] } });

    const result = await rescheduleActionsTool.execute!(
      { actionIds: ['a1', 'a2'], date: '2026-10-09T00:00:00Z' },
      { requestContext: makeRequestContext() } as never,
    );

    expect(authenticatedTrpcCall).toHaveBeenCalledTimes(1);
    const [endpoint, payload] = authenticatedTrpcCall.mock.calls[0]!;
    expect(endpoint).toBe('action.bulkReschedule');
    expect(payload).toEqual({
      actionIds: ['a1', 'a2'],
      date: '2026-10-09T00:00:00.000Z',
    });
    expect(payload).not.toHaveProperty('dueDate');
    expect(result).toEqual({ count: 2, actionIds: ['a1', 'a2'] });
  });

  it('rejects an unparseable date before calling the app', async () => {
    await expect(
      rescheduleActionsTool.execute!(
        { actionIds: ['a1'], date: 'sometime next week' },
        { requestContext: makeRequestContext() } as never,
      ),
    ).rejects.toThrow(/Invalid date/);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });
});
