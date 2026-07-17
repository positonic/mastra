import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';

import {
  MatrixGateway,
  createMatrixGateway,
  type AgentLike,
  type AgentResolver,
  type MatrixClientLike,
  type MatrixEventLike,
  type MatrixRoomLike,
} from '../matrix-gateway.js';
import { markdownToMatrixHtml } from '../../utils/matrix-format.js';

const BOT_MXID = '@zoe:syntro.fi';
const USER_MXID = '@james:syntro.fi';
const DM_ROOM = '!dm123:syntro.fi';

function makeFakeClient(overrides: Partial<MatrixClientLike> = {}): MatrixClientLike {
  return {
    startClient: vi.fn(async () => {}),
    stopClient: vi.fn(),
    on: vi.fn(),
    getUserId: () => BOT_MXID,
    getRooms: vi.fn(() => []),
    getRoom: vi.fn(() => null),
    createRoom: vi.fn(async () => ({ room_id: DM_ROOM })),
    sendTextMessage: vi.fn(async () => ({})),
    sendEvent: vi.fn(async () => ({})),
    sendTyping: vi.fn(async () => ({})),
    joinRoom: vi.fn(async () => ({})),
    leave: vi.fn(async () => ({})),
    ...overrides,
  };
}

function makeEvent(sender: string, body: string, msgtype = 'm.text'): MatrixEventLike {
  return {
    getType: () => 'm.room.message',
    getSender: () => sender,
    getContent: () => ({ msgtype, body }),
    getRoomId: () => DM_ROOM,
  };
}

function makeRoom(roomId: string, memberIds: string[]): MatrixRoomLike {
  return {
    roomId,
    getJoinedMembers: () => memberIds.map((userId) => ({ userId })),
    getMyMembership: () => 'join',
  };
}

function okJson(body: unknown): Response {
  return { ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body) } as unknown as Response;
}

function errorResponse(status: number): Response {
  return { ok: false, status, json: async () => ({}), text: async () => 'error' } as unknown as Response;
}

let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  process.env.AUTH_SECRET = 'test-secret';
  process.env.GATEWAY_SECRET = 'test-gateway-secret';
  fetchMock = vi.fn(async () => okJson({ mapping: {} }));
  vi.stubGlobal('fetch', fetchMock);
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe('createMatrixGateway', () => {
  it('does not start when MATRIX_ACCESS_TOKEN is missing', () => {
    delete process.env.MATRIX_ACCESS_TOKEN;
    expect(createMatrixGateway()).toBeNull();
  });
});

describe('beginPairing', () => {
  it('creates an UNENCRYPTED DM room (no m.room.encryption initial state), invites the user, and prompts for the code', async () => {
    const client = makeFakeClient();
    const gateway = new MatrixGateway(client);

    const { pairingCode, roomId } = await gateway.beginPairing('u1', 'jwt-1', USER_MXID);

    expect(pairingCode).toMatch(/^[0-9A-F]{6}$/);
    expect(roomId).toBe(DM_ROOM);
    expect(client.createRoom).toHaveBeenCalledTimes(1);
    const createArgs = (client.createRoom as ReturnType<typeof vi.fn>).mock.calls[0][0];
    expect(createArgs.invite).toEqual([USER_MXID]);
    expect(createArgs.is_direct).toBe(true);
    // ADR-0043: the room must not carry encryption state
    expect(JSON.stringify(createArgs)).not.toContain('m.room.encryption');
    expect(client.sendTextMessage).toHaveBeenCalledWith(DM_ROOM, expect.stringContaining('pairing code'));
  });

  it('rejects an invalid mxid', async () => {
    const gateway = new MatrixGateway(makeFakeClient());
    await expect(gateway.beginPairing('u1', 'jwt-1', 'not-an-mxid')).rejects.toThrow(/Matrix user ID/);
  });
});

describe('pairing redemption', () => {
  it('persists the mapping app-side, stores it in memory, and welcomes the user', async () => {
    const client = makeFakeClient();
    const gateway = new MatrixGateway(client);
    const { pairingCode } = await gateway.beginPairing('u1', 'jwt-1', USER_MXID);

    await gateway._handleTimelineEventForTest(
      makeEvent(USER_MXID, pairingCode),
      makeRoom(DM_ROOM, [BOT_MXID, USER_MXID]),
    );

    // Mapping persisted via POST to the app
    const postCall = fetchMock.mock.calls.find((c) => (c[1] as RequestInit | undefined)?.method === 'POST');
    expect(postCall).toBeDefined();
    expect(String(postCall![0])).toContain('/api/matrix-gateway/mappings');
    expect(JSON.parse((postCall![1] as RequestInit).body as string)).toEqual({ mxid: USER_MXID, userId: 'u1' });

    const mapping = gateway.getMappingByMxid(USER_MXID);
    expect(mapping).toMatchObject({ mxid: USER_MXID, userId: 'u1', roomId: DM_ROOM });
    expect(gateway.hasPendingCode(pairingCode)).toBe(false);
    expect(client.sendTextMessage).toHaveBeenCalledWith(DM_ROOM, expect.stringContaining('Connected'));
  });

  it('refuses a code sent by a different MXID than the one that requested it', async () => {
    const client = makeFakeClient();
    const gateway = new MatrixGateway(client);
    const { pairingCode } = await gateway.beginPairing('u1', 'jwt-1', USER_MXID);

    await gateway._handleTimelineEventForTest(
      makeEvent('@mallory:matrix.org', pairingCode),
      makeRoom(DM_ROOM, [BOT_MXID, '@mallory:matrix.org']),
    );

    expect(gateway.getMappingByMxid(USER_MXID)).toBeUndefined();
    expect(gateway.getMappingByMxid('@mallory:matrix.org')).toBeUndefined();
    expect(gateway.hasPendingCode(pairingCode)).toBe(true);
    expect(client.sendTextMessage).toHaveBeenCalledWith(DM_ROOM, expect.stringContaining('different Matrix account'));
  });

  it('rejects an expired code and cleans it up', async () => {
    const client = makeFakeClient();
    const gateway = new MatrixGateway(client);
    const { pairingCode } = await gateway.beginPairing('u1', 'jwt-1', USER_MXID);
    gateway._agePendingPairingForTest(pairingCode, 11 * 60 * 1000);

    await gateway._handleTimelineEventForTest(
      makeEvent(USER_MXID, pairingCode),
      makeRoom(DM_ROOM, [BOT_MXID, USER_MXID]),
    );

    expect(gateway.getMappingByMxid(USER_MXID)).toBeUndefined();
    expect(gateway.hasPendingCode(pairingCode)).toBe(false);
    expect(client.sendTextMessage).toHaveBeenCalledWith(DM_ROOM, expect.stringContaining('expired'));
  });

  it('does not pair when the app rejects the mapping persist', async () => {
    const client = makeFakeClient();
    const gateway = new MatrixGateway(client);
    const { pairingCode } = await gateway.beginPairing('u1', 'jwt-1', USER_MXID);
    fetchMock.mockResolvedValue(errorResponse(500));

    await gateway._handleTimelineEventForTest(
      makeEvent(USER_MXID, pairingCode),
      makeRoom(DM_ROOM, [BOT_MXID, USER_MXID]),
    );

    expect(gateway.getMappingByMxid(USER_MXID)).toBeUndefined();
    expect(client.sendTextMessage).toHaveBeenCalledWith(DM_ROOM, expect.stringContaining('went wrong'));
  });
});

describe('unpaired senders', () => {
  it('sends pairing instructions, with a cooldown against loops', async () => {
    const client = makeFakeClient();
    const gateway = new MatrixGateway(client);
    const room = makeRoom(DM_ROOM, [BOT_MXID, '@stranger:matrix.org']);

    await gateway._handleTimelineEventForTest(makeEvent('@stranger:matrix.org', 'hello?'), room);
    await gateway._handleTimelineEventForTest(makeEvent('@stranger:matrix.org', 'anyone there?'), room);

    const instructionCalls = (client.sendTextMessage as ReturnType<typeof vi.fn>).mock.calls
      .filter((c) => String(c[1]).includes('pairing code'));
    expect(instructionCalls).toHaveLength(1);
  });

  it('ignores the bot\'s own messages', async () => {
    const client = makeFakeClient();
    const gateway = new MatrixGateway(client);

    await gateway._handleTimelineEventForTest(
      makeEvent(BOT_MXID, 'echo of my own message'),
      makeRoom(DM_ROOM, [BOT_MXID, USER_MXID]),
    );

    expect(client.sendTextMessage).not.toHaveBeenCalled();
  });
});

async function pairUser(gateway: MatrixGateway): Promise<void> {
  const { pairingCode } = await gateway.beginPairing('u1', 'jwt-1', USER_MXID);
  await gateway._handleTimelineEventForTest(
    makeEvent(USER_MXID, pairingCode),
    makeRoom(DM_ROOM, [BOT_MXID, USER_MXID]),
  );
}

describe('paired DM agent chat', () => {
  let fakeAgent: { generate: ReturnType<typeof vi.fn> };
  let resolver: AgentResolver;

  beforeEach(() => {
    fakeAgent = { generate: vi.fn(async () => ({ text: '**Hello** from the _agent_' })) };
    resolver = vi.fn(async () => fakeAgent as unknown as AgentLike) as unknown as AgentResolver;
  });

  it('routes a paired DM to the agent with Matrix memory scoping and replies with HTML formatted_body', async () => {
    const client = makeFakeClient();
    const gateway = new MatrixGateway(client, resolver);
    await pairUser(gateway);

    await gateway._handleTimelineEventForTest(
      makeEvent(USER_MXID, 'what is on my plate today?'),
      makeRoom(DM_ROOM, [BOT_MXID, USER_MXID]),
    );

    expect(resolver).toHaveBeenCalledWith('assistant');
    const [messages, opts] = fakeAgent.generate.mock.calls[0];
    expect(messages[0].role).toBe('system');
    expect(messages.at(-1)).toEqual({ role: 'user', content: 'what is on my plate today?' });
    expect(opts.memory).toEqual({ resource: 'u1', thread: `matrix-u1-${DM_ROOM}` });

    const htmlEvent = (client.sendEvent as ReturnType<typeof vi.fn>).mock.calls.find(
      (c) => c[1] === 'm.room.message',
    );
    expect(htmlEvent).toBeDefined();
    expect(htmlEvent![2]).toMatchObject({
      msgtype: 'm.text',
      body: '**Hello** from the _agent_',
      format: 'org.matrix.custom.html',
    });
    expect(String(htmlEvent![2].formatted_body)).toContain('<strong>Hello</strong>');
  });

  it('shows a typing indicator during generation and clears it after', async () => {
    const client = makeFakeClient();
    const gateway = new MatrixGateway(client, resolver);
    await pairUser(gateway);

    await gateway._handleTimelineEventForTest(
      makeEvent(USER_MXID, 'hi'),
      makeRoom(DM_ROOM, [BOT_MXID, USER_MXID]),
    );

    const typingCalls = (client.sendTyping as ReturnType<typeof vi.fn>).mock.calls;
    expect(typingCalls[0][1]).toBe(true);
    expect(typingCalls.at(-1)![1]).toBe(false);
  });

  it('refreshes the JWT exactly once and retries on a 401 from the agent', async () => {
    fakeAgent.generate
      .mockRejectedValueOnce(new Error('Request failed: 401 Unauthorized'))
      .mockResolvedValueOnce({ text: 'after refresh' });
    fetchMock.mockImplementation(async (url: string) => {
      if (String(url).includes('/refresh-token')) {
        return okJson({ token: 'fresh-jwt', expiresAt: new Date(Date.now() + 3600_000).toISOString() });
      }
      return okJson({ mapping: {} });
    });

    const client = makeFakeClient();
    const gateway = new MatrixGateway(client, resolver);
    await pairUser(gateway);

    await gateway._handleTimelineEventForTest(
      makeEvent(USER_MXID, 'hi'),
      makeRoom(DM_ROOM, [BOT_MXID, USER_MXID]),
    );

    expect(fakeAgent.generate).toHaveBeenCalledTimes(2);
    const refreshCalls = fetchMock.mock.calls.filter((c) => String(c[0]).includes('/refresh-token'));
    expect(refreshCalls).toHaveLength(1);
    // The retried call carries the fresh token in its request context
    const retryOpts = fakeAgent.generate.mock.calls[1][1];
    expect(retryOpts.requestContext.get('authToken')).toBe('fresh-jwt');
  });

  it('@mention overrides the default agent', async () => {
    const client = makeFakeClient();
    const gateway = new MatrixGateway(client, resolver);
    await pairUser(gateway);

    await gateway._handleTimelineEventForTest(
      makeEvent(USER_MXID, '@zoe how is my week?'),
      makeRoom(DM_ROOM, [BOT_MXID, USER_MXID]),
    );

    expect(resolver).toHaveBeenCalledWith('zoe');
    expect(fakeAgent.generate.mock.calls[0][0].at(-1).content).toBe('how is my week?');
  });

  it('politely declines non-text messages from a paired user', async () => {
    const client = makeFakeClient();
    const gateway = new MatrixGateway(client, resolver);
    await pairUser(gateway);

    await gateway._handleTimelineEventForTest(
      {
        getType: () => 'm.room.message',
        getSender: () => USER_MXID,
        getContent: () => ({ msgtype: 'm.image', url: 'mxc://x' }),
        getRoomId: () => DM_ROOM,
      },
      makeRoom(DM_ROOM, [BOT_MXID, USER_MXID]),
    );

    expect(fakeAgent.generate).not.toHaveBeenCalled();
    expect(client.sendTextMessage).toHaveBeenCalledWith(DM_ROOM, expect.stringContaining('text messages'));
  });

  it('!agent switches the default agent', async () => {
    const client = makeFakeClient();
    const gateway = new MatrixGateway(client, resolver);
    await pairUser(gateway);

    await gateway._handleTimelineEventForTest(
      makeEvent(USER_MXID, '!agent zoe'),
      makeRoom(DM_ROOM, [BOT_MXID, USER_MXID]),
    );
    expect(gateway.getMappingByMxid(USER_MXID)?.agentId).toBe('zoe');
    expect(fakeAgent.generate).not.toHaveBeenCalled();
  });
});

describe('markdownToMatrixHtml', () => {
  it('renders links, emphasis and code to real HTML', () => {
    const html = markdownToMatrixHtml('**bold** with [a link](https://example.com) and `code`');
    expect(html).toContain('<strong>bold</strong>');
    expect(html).toContain('<a href="https://example.com"');
    expect(html).toContain('<code>code</code>');
  });
});

describe('restart rebuild (no gateway-local file)', () => {
  it('loads mappings from the app and rebuilds canonical DM rooms from joined-room state', async () => {
    fetchMock.mockResolvedValue(okJson({ mappings: [{ mxid: USER_MXID, userId: 'u1' }] }));
    const client = makeFakeClient({
      getRooms: vi.fn(() => [
        makeRoom('!big:syntro.fi', [BOT_MXID, USER_MXID, '@third:syntro.fi']),
        makeRoom(DM_ROOM, [BOT_MXID, USER_MXID]),
      ]),
    });
    const gateway = new MatrixGateway(client);

    await gateway.loadMappingsFromApp();
    gateway.rebuildCanonicalRooms();

    const mapping = gateway.getMappingByMxid(USER_MXID);
    expect(mapping).toMatchObject({ userId: 'u1', roomId: DM_ROOM });
  });
});
