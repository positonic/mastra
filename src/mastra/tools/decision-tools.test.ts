import { describe, it, expect, vi, beforeEach } from 'vitest';

const authenticatedTrpcCall = vi.fn();
const authenticatedTrpcQuery = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: (...args: unknown[]) => authenticatedTrpcCall(...args),
  authenticatedTrpcQuery: (...args: unknown[]) => authenticatedTrpcQuery(...args),
}));

import { listDecisionsTool, logDecisionTool, updateDecisionTool } from './decision-tools.js';

function makeRequestContext(overrides: Record<string, string> = {}) {
  return new Map<string, string>([
    ['authToken', 'token-123'],
    ['userId', 'user-1'],
    ['workspaceId', 'ws-1'],
    ...Object.entries(overrides),
  ]);
}

/**
 * The decision tools are thin: they shape the request for the `decision`
 * router and never write on their own (ADR-0016 / ADR-0060 in exponential).
 * These tests pin the request shape — source AGENT, workspace from context,
 * evidence in the server's turn shape — and the guard rails around
 * superseding.
 */
describe('log-decision', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('calls decision.create with the workspace from context and source AGENT', async () => {
    authenticatedTrpcCall.mockResolvedValue({
      data: { id: 'dec-1', number: 7, statement: 'Ship it', status: 'ACCEPTED', decidedAt: '2026-09-08T07:00:00.000Z' },
    });
    const result = await logDecisionTool.execute!(
      {
        statement: 'Ship it',
        transcriptionSessionId: 'meeting-1',
        evidence: [{ turnIndex: 3, speaker: 'Pat', text: "Let's ship it." }],
      },
      { requestContext: makeRequestContext() } as never,
    );
    expect(authenticatedTrpcCall).toHaveBeenCalledTimes(1);
    const [endpoint, payload] = authenticatedTrpcCall.mock.calls[0]!;
    expect(endpoint).toBe('decision.create');
    expect(payload).toMatchObject({
      workspaceId: 'ws-1',
      statement: 'Ship it',
      status: 'ACCEPTED',
      source: 'AGENT',
      transcriptionSessionId: 'meeting-1',
      evidence: [{ turnIndex: 3, speaker: 'Pat', startTime: null, text: "Let's ship it." }],
    });
    expect(result).toMatchObject({
      id: 'dec-1',
      label: 'D-0007',
      status: 'ACCEPTED',
      decidedAt: '2026-09-08T07:00:00.000Z',
    });
  });

  it("folds the model's natural phrasing into the contract: notes → body, confirmed → ACCEPTED", async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { id: 'dec-1', number: 1, status: 'ACCEPTED' } });
    await logDecisionTool.execute!(
      { statement: 'Park it', status: 'confirmed', notes: 'Decided in the standup' } as never,
      { requestContext: makeRequestContext() } as never,
    );
    expect(authenticatedTrpcCall.mock.calls[0]![1]).toMatchObject({
      status: 'ACCEPTED',
      body: 'Decided in the standup',
    });
  });

  it('drops evidence when there is no meeting to resolve the turns against', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { id: 'dec-1', number: 1, status: 'ACCEPTED' } });
    await logDecisionTool.execute!(
      {
        statement: 'Ship it',
        evidence: [{ turnIndex: 3, speaker: 'Pat', text: "Let's ship it." }],
      } as never,
      { requestContext: makeRequestContext() } as never,
    );
    // A turn index with no transcript behind it cannot be checked by anyone,
    // so it must not reach the log looking like a verbatim quote.
    const payload = authenticatedTrpcCall.mock.calls[0]![1] as { evidence?: unknown[] };
    expect(payload.evidence).toBeUndefined();
  });

  it('refuses without a workspace scope and never calls the server', async () => {
    await expect(
      logDecisionTool.execute!(
        { statement: 'x' },
        { requestContext: new Map([['authToken', 't']]) } as never,
      ),
    ).rejects.toThrow(/workspaceId/);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });
});

describe('update-decision', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('superseding needs supersededById, then calls decision.setStatus', async () => {
    await expect(
      updateDecisionTool.execute!(
        { decisionId: 'dec-1', status: 'SUPERSEDED' },
        { requestContext: makeRequestContext() } as never,
      ),
    ).rejects.toThrow(/supersededById/);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();

    authenticatedTrpcCall.mockResolvedValue({
      data: { id: 'dec-1', number: 1, status: 'SUPERSEDED', supersededBy: { id: 'dec-2', number: 2 } },
    });
    const result = await updateDecisionTool.execute!(
      { decisionId: 'dec-1', status: 'SUPERSEDED', supersededById: 'dec-2' },
      { requestContext: makeRequestContext() } as never,
    );
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'decision.setStatus',
      { workspaceId: 'ws-1', decisionId: 'dec-1', status: 'SUPERSEDED', supersededById: 'dec-2' },
      expect.objectContaining({ authToken: 'token-123' }),
    );
    expect(result).toMatchObject({ summary: expect.stringMatching(/superseded by D-0002/) });
  });

  it('edits content through decision.update and status through decision.setStatus, in that order', async () => {
    authenticatedTrpcCall
      .mockResolvedValueOnce({ data: { id: 'dec-1', number: 1, status: 'PROPOSED' } })
      .mockResolvedValueOnce({ data: { id: 'dec-1', number: 1, status: 'ACCEPTED' } });
    const result = await updateDecisionTool.execute!(
      { decisionId: 'dec-1', statement: 'Clearer wording', status: 'ACCEPTED' },
      { requestContext: makeRequestContext() } as never,
    );
    expect(authenticatedTrpcCall.mock.calls.map((c) => c[0])).toEqual([
      'decision.update',
      'decision.setStatus',
    ]);
    expect(authenticatedTrpcCall.mock.calls[0]![1]).toEqual({
      workspaceId: 'ws-1',
      decisionId: 'dec-1',
      statement: 'Clearer wording',
    });
    expect(result).toMatchObject({ status: 'ACCEPTED' });
  });

  it('refuses a D-label where an id belongs, before calling the server', async () => {
    for (const input of [
      { decisionId: 'D-0003', statement: 'x' },
      { decisionId: 'dec-1', status: 'SUPERSEDED', supersededById: 'D-0005' },
    ]) {
      await expect(
        updateDecisionTool.execute!(input as never, { requestContext: makeRequestContext() } as never),
      ).rejects.toThrow(/looks like a label/);
    }
    // The error names list-decisions so the model can recover on its own,
    // rather than retrying into the server's bare NOT_FOUND.
    await expect(
      updateDecisionTool.execute!(
        { decisionId: 'D-0003', statement: 'x' } as never,
        { requestContext: makeRequestContext() } as never,
      ),
    ).rejects.toThrow(/list-decisions/);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });

  it('reports what already landed when the status call fails after the content edit', async () => {
    authenticatedTrpcCall
      .mockResolvedValueOnce({ data: { id: 'dec-1', number: 1, status: 'PROPOSED' } })
      .mockRejectedValueOnce(new Error('CONFLICT'));

    await expect(
      updateDecisionTool.execute!(
        { decisionId: 'dec-1', statement: 'Clearer wording', status: 'ACCEPTED' },
        { requestContext: makeRequestContext() } as never,
      ),
    ).rejects.toThrow(/edited statement applied, but the status change to ACCEPTED failed.*partially updated/s);
  });

  it('refuses an empty update', async () => {
    await expect(
      updateDecisionTool.execute!(
        { decisionId: 'dec-1' },
        { requestContext: makeRequestContext() } as never,
      ),
    ).rejects.toThrow(/nothing to update/i);
  });
});

describe('list-decisions', () => {
  beforeEach(() => authenticatedTrpcQuery.mockReset());

  it('resolves a D-label by number instead of text-searching it', async () => {
    authenticatedTrpcQuery.mockResolvedValue({
      data: [
        { id: 'dec-3', number: 3, label: 'D-0003', statement: 'Old', status: 'ACCEPTED', source: 'MANUAL' },
        { id: 'dec-5', number: 5, label: 'D-0005', statement: 'New', status: 'ACCEPTED', source: 'MANUAL' },
      ],
    });
    const result = await listDecisionsTool.execute!(
      { search: 'D-0003', limit: 25 },
      { requestContext: makeRequestContext() } as never,
    );
    const endpoint = authenticatedTrpcQuery.mock.calls[0]![0] as string;
    const decoded = JSON.parse(decodeURIComponent(endpoint.slice('decision.list?input='.length)));
    expect(decoded.json.search).toBeUndefined();
    // Asked for by number, so the server returns the one row rather than the
    // whole log (with its evidence blobs) for the client to sift.
    expect(decoded.json.number).toBe(3);
    expect(result).toMatchObject({ total: 1, decisions: [expect.objectContaining({ id: 'dec-3', label: 'D-0003' })] });
  });

  it('GETs decision.list with {"json": ...} input and flattens the rows', async () => {
    authenticatedTrpcQuery.mockResolvedValue({
      data: [
        {
          id: 'dec-1',
          label: 'D-0001',
          statement: 'Park it',
          status: 'ACCEPTED',
          source: 'MEETING',
          decidedAt: '2026-09-08T07:00:00.000Z',
          transcriptionSession: { id: 'm-1', title: 'Daily Standup' },
          project: null,
          product: { id: 'p-1', name: 'Fixture Product' },
        },
      ],
    });
    const result = await listDecisionsTool.execute!(
      { search: 'park', status: 'ACCEPTED', limit: 25 },
      { requestContext: makeRequestContext() } as never,
    );
    const endpoint = authenticatedTrpcQuery.mock.calls[0]![0] as string;
    expect(endpoint.startsWith('decision.list?input=')).toBe(true);
    const decoded = JSON.parse(decodeURIComponent(endpoint.slice('decision.list?input='.length)));
    expect(decoded).toEqual({ json: { workspaceId: 'ws-1', search: 'park', statuses: ['ACCEPTED'], limit: 25 } });
    expect(result).toMatchObject({
      total: 1,
      decisions: [
        expect.objectContaining({
          label: 'D-0001',
          meetingTitle: 'Daily Standup',
          product: 'Fixture Product',
          project: null,
        }),
      ],
    });
  });
});
