import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { z } from 'zod';

const authenticatedTrpcCall = vi.fn();
const authenticatedTrpcQuery = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: (...args: unknown[]) => authenticatedTrpcCall(...args),
  authenticatedTrpcQuery: (...args: unknown[]) => authenticatedTrpcQuery(...args),
}));

const {
  getRunContextTool,
  reportProgressTool,
  commentOnActionTool,
  reassignActionTool,
  askOwnerTool,
  finishRunTool,
  runUpdateActionTool,
  runTools,
} = await import('./run-tools.js');

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

describe('run tools — endpoint contract (Agent PRD D5)', () => {
  beforeEach(() => {
    authenticatedTrpcCall.mockReset();
    authenticatedTrpcQuery.mockReset();
  });

  it('exposes exactly the D5 tool ids', () => {
    expect(Object.values(runTools).map((t) => t.id).sort()).toEqual(
      ['ask-owner', 'comment-on-action', 'finish-run', 'get-run-context', 'reassign-action', 'report-progress'].sort(),
    );
  });

  it('get-run-context queries mastra.getRunContext with no input (the run is the JWT)', async () => {
    const ctx = {
      action: {
        id: 'a1',
        name: 'Find a venue',
        description: null,
        status: 'ACTIVE',
        priority: 'Quick',
        dueDate: null,
        project: { id: 'p1', name: 'Offsite' },
        workspaceId: 'ws1',
      },
      assignees: [{ id: 'shadow-user-1', name: 'Aria', isAgent: true }],
      members: [{ id: 'u2', name: 'Andi', isAgent: false, assistantOwner: null, positions: [], agentDescription: null }],
      comments: [],
      owner: { id: 'u1', name: 'James' },
      predecessor: null,
    };
    authenticatedTrpcQuery.mockResolvedValue({ data: ctx });

    const result = await getRunContextTool.execute!({}, { requestContext: makeRequestContext() } as never);

    expect(authenticatedTrpcQuery).toHaveBeenCalledWith(
      'mastra.getRunContext',
      expect.objectContaining({ authToken: 'run-jwt' }),
    );
    expect(result).toEqual(ctx);
  });

  it('get-run-context keeps members\' Positions and agentDescription through output validation (Agent PRD D8.4)', async () => {
    const travel = {
      id: 'pos-travel',
      title: 'Travel researcher',
      remit: 'Trips, venues, hotels.',
      notAccountableFor: 'Booking anything.',
    };
    const ctx = {
      action: { id: 'a1', name: 'Shortlist Madrid hotels', description: null, status: 'ACTIVE', priority: 'Quick', dueDate: null, project: null, workspaceId: 'ws1' },
      assignees: [{ id: 'shadow-user-1', name: 'Aria', isAgent: true }],
      members: [
        { id: 'u2', name: 'Andi', isAgent: false, assistantOwner: null, positions: [travel], agentDescription: null },
        { id: 'bot', name: 'Report bot', isAgent: true, assistantOwner: null, positions: [], agentDescription: 'Weekly status reports.' },
      ],
      comments: [],
      owner: { id: 'u1', name: 'James' },
      predecessor: null,
    };
    authenticatedTrpcQuery.mockResolvedValue({ data: ctx });

    const result = await getRunContextTool.execute!({}, { requestContext: makeRequestContext() } as never);
    expect(result).toEqual(ctx);

    // What Mastra's output validation leaves the model with.
    const parsed = (getRunContextTool.outputSchema as unknown as z.ZodTypeAny).parse(ctx) as typeof ctx;
    expect(parsed.members[0]!.positions).toEqual([travel]);
    expect(parsed.members[1]!.agentDescription).toBe('Weekly status reports.');
  });

  it('get-run-context output still validates against an app build without member Positions', () => {
    const parsed = (getRunContextTool.outputSchema as unknown as z.ZodTypeAny).parse({
      action: { id: 'a', name: 'n', description: null, status: 'ACTIVE', priority: null, dueDate: null, project: null, workspaceId: null },
      assignees: [],
      members: [{ id: 'u2', name: 'Andi', isAgent: false, assistantOwner: null }],
      comments: [],
      owner: { id: 'o', name: null },
      predecessor: null,
    }) as { members: { positions: unknown[]; agentDescription: string | null }[] };
    expect(parsed.members[0]).toMatchObject({ positions: [], agentDescription: null });
  });

  it('get-run-context tells the model to delegate by Remit', () => {
    expect(getRunContextTool.description).toMatch(/Positions and Remits[\s\S]*delegate by Remit/);
  });

  it('report-progress posts mastra.reportProgress with the text', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: {} });
    await reportProgressTool.execute!({ text: 'Searching the CRM' }, { requestContext: makeRequestContext() } as never);
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.reportProgress',
      { text: 'Searching the CRM' },
      expect.objectContaining({ authToken: 'run-jwt' }),
    );
  });

  it('comment-on-action posts mastra.commentOnAction with the markdown', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { commentId: 'c1' } });
    const result = await commentOnActionTool.execute!(
      { markdown: 'Two venues found, see below.' },
      { requestContext: makeRequestContext() } as never,
    );
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.commentOnAction',
      { markdown: 'Two venues found, see below.' },
      expect.objectContaining({ authToken: 'run-jwt' }),
    );
    expect(result).toEqual({ commentId: 'c1' });
  });

  it('reassign-action posts mastra.reassignAction with the userId only', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { assigned: { id: 'u2', name: 'Andi', isAgent: false } } });
    await reassignActionTool.execute!({ userId: 'u2' }, { requestContext: makeRequestContext() } as never);
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.reassignAction',
      { userId: 'u2' },
      expect.objectContaining({ authToken: 'run-jwt' }),
    );
  });

  it('no run tool ever sends a runId', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: {} });
    authenticatedTrpcQuery.mockResolvedValue({ data: { action: { id: 'a', name: 'n', description: null, status: 'ACTIVE', priority: null, dueDate: null, project: null, workspaceId: null }, assignees: [], members: [], comments: [], owner: { id: 'o', name: null }, predecessor: null } });
    const ctx = { requestContext: makeRequestContext({ runId: 'should-not-leak' }) } as never;
    await getRunContextTool.execute!({}, ctx);
    await reportProgressTool.execute!({ text: 'x' }, ctx);
    await commentOnActionTool.execute!({ markdown: 'x' }, ctx);
    await reassignActionTool.execute!({ userId: 'u' }, ctx);
    await askOwnerTool.execute!({ question: 'q' }, ctx);
    await finishRunTool.execute!({ summary: 'x', readyToClose: true }, ctx);
    for (const call of [...authenticatedTrpcCall.mock.calls, ...authenticatedTrpcQuery.mock.calls]) {
      for (const arg of call) if (arg && typeof arg === 'object') expect(arg).not.toHaveProperty('runId');
    }
  });
});

describe('runUpdateActionTool', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('posts mastra.updateAction like the chat tool, for the fields it allows', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { action: { id: 'a1' } } });
    await runUpdateActionTool.execute!(
      { actionId: 'a1', name: 'Book Hotel Marlow' },
      { requestContext: makeRequestContext() } as never,
    );
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.updateAction',
      { actionId: 'a1', name: 'Book Hotel Marlow' },
      expect.objectContaining({ authToken: 'run-jwt' }),
    );
  });

  it('tells the model it cannot change status', () => {
    expect(runUpdateActionTool.description).toMatch(/cannot change an action's status/);
    expect(runUpdateActionTool.description).not.toMatch(/priority\/status/);
  });
});

describe('askOwnerTool — stop semantics', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('posts mastra.askOwner with the question and returns a stop instruction', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: {} });

    const result = await askOwnerTool.execute!(
      { question: 'Which date works for the offsite: 12 or 19 Nov?' },
      { requestContext: makeRequestContext() } as never,
    );

    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.askOwner',
      { question: 'Which date works for the offsite: 12 or 19 Nov?' },
      expect.objectContaining({ authToken: 'run-jwt' }),
    );
    expect(result).toMatchObject({ stop: true, status: 'WAITING_ON_OWNER' });
    expect(result.message).toMatch(/stop here|end your turn/i);
  });

  it('is described to the model as the last call, with no finish-run after it', () => {
    expect(askOwnerTool.description).toMatch(/LAST call/);
    expect(askOwnerTool.description).toMatch(/do not call finish-run/i);
  });
});
