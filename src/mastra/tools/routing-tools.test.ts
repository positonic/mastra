import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { Roster, AssignActionResult } from './routing-tools.js';

// Mock the authenticated tRPC transport so no network call is made.
const authenticatedTrpcCall = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: (...args: unknown[]) => authenticatedTrpcCall(...args),
  authenticatedTrpcQuery: vi.fn(),
}));

const {
  listAssignableMembersTool,
  listAssignableMembersOutputSchema,
  assignActionTool,
  assignActionInputSchema,
  isContainmentNotFound,
  routingTools,
} = await import('./routing-tools.js');
const { quickCreateActionTool } = await import('./index.js');

const ctx = (overrides: Record<string, string> = {}) => ({ requestContext: makeRequestContext(overrides) }) as never;

async function listMembers(input: { actionId?: string; projectId?: string }): Promise<Roster> {
  return (await listAssignableMembersTool.execute!(input, ctx())) as Roster;
}

async function assign(input: { actionId: string; userIds: string[] }): Promise<AssignActionResult> {
  return (await assignActionTool.execute!(input, ctx())) as AssignActionResult;
}

function makeRequestContext(overrides: Record<string, string> = {}) {
  return new Map<string, string>([
    ['authToken', 'token-123'],
    ['userId', 'james'],
    ['workspaceId', 'ws-clear'],
    ...Object.entries(overrides),
  ]);
}

const TRAVEL = {
  id: 'pos-travel',
  title: 'Travel researcher',
  remit: 'Trips, venues, hotels and itineraries.',
  notAccountableFor: 'Booking or paying for anything.',
};
const DELIVERY = { id: 'pos-delivery', title: 'Delivery lead', remit: 'Delivery plans and milestones.', notAccountableFor: null };

/** The app's `AssignableUser[]` per the V2 contract (Agent PRD D8). */
const ROSTER = {
  assignableUsers: [
    { id: 'james', name: 'James', email: 'j@example.com', image: null, isAgent: false, assistantOwner: null, positions: [DELIVERY], agentDescription: null },
    { id: 'andi', name: 'Andi', email: 'a@example.com', image: null, isAgent: false, assistantOwner: null, positions: [DELIVERY, TRAVEL], agentDescription: null },
    {
      id: 'aria',
      name: 'Aria',
      email: null,
      image: null,
      isAgent: true,
      assistantOwner: { id: 'james', name: 'James', emoji: '🦊' },
      positions: [TRAVEL],
      agentDescription: null,
    },
    {
      id: 'bot',
      name: 'Report bot',
      email: null,
      image: null,
      isAgent: true,
      assistantOwner: null,
      positions: [],
      agentDescription: 'Weekly status reports.',
    },
  ],
  actionContext: { hasProject: false, hasTeam: false, userTeamCount: 0 },
};

describe('routing tools', () => {
  it('exposes exactly the two V2 tool ids', () => {
    expect(Object.values(routingTools).map((t) => t.id).sort()).toEqual(['assign-action', 'list-assignable-members']);
  });
});

describe('listAssignableMembersTool', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('reads the prospective-action roster with the workspace from context, not from input', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: ROSTER });

    await listAssignableMembersTool.execute!({ projectId: 'p1' }, { requestContext: makeRequestContext() } as never);

    expect(authenticatedTrpcCall).toHaveBeenCalledTimes(1);
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'action.getAssignableUsersForContext',
      { projectId: 'p1', workspaceId: 'ws-clear' },
      expect.objectContaining({ authToken: 'token-123', userId: 'james' }),
    );
  });

  it('defaults projectId to the page context exactly as quick-create-action does, and reports it', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: ROSTER });

    const roster = (await listAssignableMembersTool.execute!(
      {},
      { requestContext: makeRequestContext({ projectId: 'p-page' }) } as never,
    )) as Roster;
    expect(authenticatedTrpcCall).toHaveBeenLastCalledWith(
      'action.getAssignableUsersForContext',
      { projectId: 'p-page', workspaceId: 'ws-clear' },
      expect.anything(),
    );
    expect(roster.projectId).toBe('p-page');

    // An explicit projectId wins over the page's.
    const explicit = (await listAssignableMembersTool.execute!(
      { projectId: 'p1' },
      { requestContext: makeRequestContext({ projectId: 'p-page' }) } as never,
    )) as Roster;
    expect(authenticatedTrpcCall).toHaveBeenLastCalledWith(
      'action.getAssignableUsersForContext',
      { projectId: 'p1', workspaceId: 'ws-clear' },
      expect.anything(),
    );
    expect(explicit.projectId).toBe('p1');

    // Same resolution quick-create-action uses for the action it files.
    authenticatedTrpcCall.mockResolvedValue({ data: { success: true, action: { id: 'a1', name: 'x', priority: 'Quick' } } });
    await quickCreateActionTool.execute!({ text: 'x' }, { requestContext: makeRequestContext({ projectId: 'p-page' }) } as never);
    expect((authenticatedTrpcCall.mock.lastCall![1] as Record<string, unknown>).projectId).toBe('p-page');
  });

  it('reports no projectId when read by actionId or with no project anywhere', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: ROSTER });
    expect((await listMembers({ actionId: 'a1' })).projectId).toBeNull();
    expect((await listMembers({})).projectId).toBeNull();
  });

  it('reads the existing-action roster when given an actionId (which wins over projectId)', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: ROSTER });

    await listAssignableMembersTool.execute!(
      { actionId: 'a1', projectId: 'p1' },
      { requestContext: makeRequestContext() } as never,
    );

    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'action.getAssignableUsers',
      { actionId: 'a1' },
      expect.objectContaining({ authToken: 'token-123' }),
    );
  });

  it('lists each Position once and points members at it, with requester flags', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: ROSTER });

    const result = await listMembers({});

    expect(result.positions).toEqual([DELIVERY, TRAVEL]);
    const byId = Object.fromEntries(result.members.map((m) => [m.id, m]));
    expect(byId.james).toMatchObject({ isRequester: true, isRequestersAssistant: false, positionIds: ['pos-delivery'] });
    expect(byId.andi).toMatchObject({ isRequester: false, isRequestersAssistant: false, positionIds: ['pos-delivery', 'pos-travel'] });
    expect(byId.aria).toMatchObject({
      isAgent: true,
      isRequester: false,
      isRequestersAssistant: true,
      assistantOwner: { id: 'james', name: 'James' },
      positionIds: ['pos-travel'],
    });
    expect(byId.bot).toMatchObject({ isAgent: true, isRequestersAssistant: false, positionIds: [], agentDescription: 'Weekly status reports.' });
    // Remit text is carried on positions, not repeated per member.
    expect(JSON.stringify(result.members)).not.toContain('itineraries');
  });

  it('validates against its own output schema', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: ROSTER });
    const result = await listMembers({});
    expect(listAssignableMembersOutputSchema.safeParse(result).success).toBe(true);
  });

  it('tolerates a Position with a null title or remit', async () => {
    authenticatedTrpcCall.mockResolvedValue({
      data: { assignableUsers: [{ id: 'andi', name: 'Andi', positions: [{ id: 'p1', title: null, remit: null }] }] },
    });
    const result = await listMembers({});
    expect(result.positions).toEqual([{ id: 'p1', title: '', remit: '', notAccountableFor: null }]);
  });

  it('tolerates an app build that does not send positions yet', async () => {
    authenticatedTrpcCall.mockResolvedValue({
      data: { assignableUsers: [{ id: 'andi', name: 'Andi', email: null, image: null, isAgent: false, assistantOwner: null }] },
    });
    const result = await listMembers({});
    expect(result).toEqual({
      projectId: null,
      positions: [],
      members: [
        {
          id: 'andi',
          name: 'Andi',
          email: null,
          isAgent: false,
          assistantOwner: null,
          isRequester: false,
          isRequestersAssistant: false,
          positionIds: [],
          agentDescription: null,
        },
      ],
    });
  });

  it('refuses without a token', async () => {
    await expect(
      listAssignableMembersTool.execute!({}, { requestContext: new Map() } as never),
    ).rejects.toThrow(/authentication token/i);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });
});

describe('assignActionTool', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('calls action.assign as the user and surfaces agentRunsQueued', async () => {
    authenticatedTrpcCall.mockResolvedValue({
      data: {
        id: 'a1',
        name: 'Shortlist Madrid hotels near the venue',
        assignees: [
          { user: { id: 'james', name: 'James', email: null, image: null } },
          { user: { id: 'aria', name: 'Aria', email: null, image: null } },
        ],
        project: null,
        agentRunsQueued: 1,
      },
    });

    const result = await assignActionTool.execute!(
      { actionId: 'a1', userIds: ['aria'] },
      { requestContext: makeRequestContext() } as never,
    );

    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'action.assign',
      { actionId: 'a1', userIds: ['aria'] },
      expect.objectContaining({ authToken: 'token-123', userId: 'james' }),
    );
    expect(result).toEqual({
      actionId: 'a1',
      assignees: [
        { id: 'james', name: 'James' },
        { id: 'aria', name: 'Aria' },
      ],
      agentRunsQueued: 1,
    });
  });

  it('reports agentRunsQueued as null, never 0, when the app does not send it', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { id: 'a1', assignees: [] } });
    const result = await assign({ actionId: 'a1', userIds: ['andi'] });
    expect(result.agentRunsQueued).toBeNull();
  });

  it('accepts a comma-string of ids the model sometimes emits', () => {
    const parsed = assignActionInputSchema.safeParse({ actionId: 'a1', userIds: 'andi, aria' });
    expect(parsed.success && parsed.data.userIds).toEqual(['andi', 'aria']);
  });

  it('rejects an empty or oversized assignee list', () => {
    expect(assignActionInputSchema.safeParse({ actionId: 'a1', userIds: [] }).success).toBe(false);
    const eleven = Array.from({ length: 11 }, (_, i) => `u${i}`);
    expect(assignActionInputSchema.safeParse({ actionId: 'a1', userIds: eleven }).success).toBe(false);
  });

  it('turns a containment NOT_FOUND into an instruction not to retry silently', async () => {
    authenticatedTrpcCall.mockRejectedValueOnce(
      new Error('Request failed: 404 Not Found - {"error":{"json":{"data":{"code":"NOT_FOUND"}}}}'),
    );
    await expect(
      assignActionTool.execute!({ actionId: 'a1', userIds: ['stranger'] }, { requestContext: makeRequestContext() } as never),
    ).rejects.toThrow(/outside what the user could assign by hand[\s\S]*do not retry/);
  });

  it('does not read a missing procedure as a containment refusal', () => {
    expect(isContainmentNotFound(new Error('Request failed: 404 Not Found - {"code":"NOT_FOUND"}'))).toBe(true);
    expect(
      isContainmentNotFound(new Error('Request failed: 404 Not Found - No "mutation"-procedure on path "action.assign"')),
    ).toBe(false);
    expect(isContainmentNotFound(new Error('Request failed: 500 Internal Server Error - Action not found'))).toBe(false);
  });

  it('passes other failures through unchanged', async () => {
    authenticatedTrpcCall.mockRejectedValueOnce(new Error('Request failed: 500 Internal Server Error - Action not found'));
    await expect(
      assignActionTool.execute!({ actionId: 'nope', userIds: ['andi'] }, { requestContext: makeRequestContext() } as never),
    ).rejects.toThrow(/Action not found/);
  });

  it('tells the model where ids come from, that an Assistant starts a run, and not to retry a NOT_FOUND', () => {
    expect(assignActionTool.description).toMatch(/list-assignable-members/);
    expect(assignActionTool.description).toMatch(/starts its Agent run/);
    expect(assignActionTool.description).toMatch(
      /0 when the action was already assigned to that Assistant \(re-assigning does not restart it\), is parked/,
    );
    expect(assignActionTool.description).toMatch(/tell the user plainly that no run started rather than invent a cause/);
    expect(assignActionTool.description).toMatch(/NOT_FOUND[\s\S]*do not retry/);
  });

  it('takes no credential or workspace in its input', () => {
    for (const tool of Object.values(routingTools)) {
      const keys = Object.keys((tool.inputSchema as unknown as { shape: Record<string, unknown> }).shape);
      expect(keys.filter((k) => /token|auth|workspace|userId$/i.test(k))).toEqual([]);
    }
  });
});

describe('quickCreateActionTool — workspace forwarding (Agent PRD D8.3)', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  const created = { data: { success: true, action: { id: 'a1', name: 'Shortlist Madrid hotels', priority: 'Quick' } } };

  it('forwards workspaceId from context so a project-less action lands in the workspace', async () => {
    authenticatedTrpcCall.mockResolvedValue(created);
    await quickCreateActionTool.execute!({ text: 'Shortlist Madrid hotels near the venue' }, ctx());
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'mastra.quickCreateAction',
      expect.objectContaining({ text: 'Shortlist Madrid hotels near the venue', workspaceId: 'ws-clear' }),
      expect.objectContaining({ authToken: 'token-123' }),
    );
  });

  it('sends no workspaceId when the context has none (or a blank one)', async () => {
    authenticatedTrpcCall.mockResolvedValue(created);
    await quickCreateActionTool.execute!(
      { text: 'Call John' },
      { requestContext: new Map([['authToken', 't']]) } as never,
    );
    await quickCreateActionTool.execute!(
      { text: 'Call John' },
      { requestContext: new Map([['authToken', 't'], ['workspaceId', ' ']]) } as never,
    );
    for (const [, payload] of authenticatedTrpcCall.mock.calls) {
      expect((payload as Record<string, unknown>).workspaceId).toBeUndefined();
    }
  });

  it('retries once without the workspace when the context workspace is FORBIDDEN (viewer, stale pairing)', async () => {
    authenticatedTrpcCall
      .mockRejectedValueOnce(new Error('Request failed: 403 Forbidden - {"code":"FORBIDDEN"}'))
      .mockResolvedValueOnce(created);
    const result = await quickCreateActionTool.execute!({ text: 'Call John' }, ctx());
    expect(authenticatedTrpcCall).toHaveBeenCalledTimes(2);
    expect((authenticatedTrpcCall.mock.calls[0]![1] as Record<string, unknown>).workspaceId).toBe('ws-clear');
    expect((authenticatedTrpcCall.mock.calls[1]![1] as Record<string, unknown>).workspaceId).toBeUndefined();
    expect(result).toMatchObject({ success: true });
  });

  it('does not retry other failures, or a FORBIDDEN with no workspace forwarded', async () => {
    authenticatedTrpcCall.mockRejectedValueOnce(new Error('Request failed: 500 Internal Server Error - boom'));
    await expect(quickCreateActionTool.execute!({ text: 'Call John' }, ctx())).rejects.toThrow(/boom/);
    authenticatedTrpcCall.mockRejectedValueOnce(new Error('Request failed: 403 Forbidden - {"code":"FORBIDDEN"}'));
    await expect(
      quickCreateActionTool.execute!({ text: 'Call John' }, { requestContext: new Map([['authToken', 't']]) } as never),
    ).rejects.toThrow(/FORBIDDEN/);
    expect(authenticatedTrpcCall).toHaveBeenCalledTimes(2);
  });

  it('does not take a workspace from tool input', () => {
    const keys = Object.keys((quickCreateActionTool.inputSchema as unknown as { shape: Record<string, unknown> }).shape);
    expect(keys).not.toContain('workspaceId');
  });
});
