import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import crypto from 'crypto';

import { createLogger } from '../utils/logger.js';
import { RequestContext } from '@mastra/core/request-context';

import {
  type AgentIdentifier,
  verifyAndExtractUserId,
  parseMessageForMention,
  sendJsonResponse,
  handleGatewayError,
  setCorsHeaders,
} from '../utils/gateway-shared.js';
import { markdownToMatrixHtml } from '../utils/matrix-format.js';
import { captureException, captureAuthFailure } from '../utils/sentry.js';

const logger = createLogger({
  name: 'MatrixGateway',
  level: 'info',
});

const INSTANCE_ID = `mx-gateway-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Configuration
const GATEWAY_PORT = parseInt(process.env.MATRIX_GATEWAY_PORT || '4114', 10);
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const INSTRUCTION_COOLDOWN_MS = 5 * 60 * 1000; // don't spam unpaired senders

// Token refresh configuration — read at call time (not module load) so env
// set after import (tests, late dotenv) is honored.
function appBaseUrl(): string {
  return process.env.TODO_APP_BASE_URL || 'http://localhost:3000';
}
function gatewaySecret(): string | undefined {
  return process.env.GATEWAY_SECRET || process.env.WHATSAPP_GATEWAY_SECRET;
}

const MXID_PATTERN = /^@[^:\s]+:\S+$/;
const PAIRING_CODE_PATTERN = /^[0-9A-F]{6}$/;

const CONVERSATION_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes (Telegram parity)
const MAX_HISTORY_MESSAGES = 10;
const TYPING_TIMEOUT_MS = 30_000;
const NON_TEXT_REPLY_COOLDOWN_MS = 60 * 1000; // one polite reply per attachment burst

// Matrix renders real HTML (formatted_body), so unlike WhatsApp/Telegram the
// agent may use full standard markdown — links, lists, code blocks, tables.
const MATRIX_SYSTEM_CONTEXT = `You are responding via Matrix (rendered as rich HTML in clients like Element). Format your responses in standard markdown:
- Links, lists, **bold**, _italic_, \`code\`, fenced code blocks and tables all render properly
- Keep responses conversational and reasonably concise — this is a chat, not a document`;

// ─── Minimal matrix-js-sdk surface ──────────────────────────────────────────
// The gateway depends on this narrow interface (not the full MatrixClient) so
// tests can inject a fake client. The real client is created lazily in
// initialize() from matrix-js-sdk. NO initRustCrypto — E2EE is deliberately
// out of scope (ADR-0043); the bot only ever creates unencrypted rooms.

export interface MatrixRoomMemberLike {
  userId: string;
}

export interface MatrixRoomLike {
  roomId: string;
  getJoinedMembers(): MatrixRoomMemberLike[];
  getMyMembership(): string | null;
  currentState?: {
    getStateEvents(eventType: string, stateKey: string): unknown;
  };
}

export interface MatrixEventLike {
  getType(): string;
  getSender(): string | undefined;
  getContent(): Record<string, unknown>;
  getRoomId(): string | undefined;
}

export interface MatrixClientLike {
  startClient(opts?: { initialSyncLimit?: number }): Promise<void>;
  stopClient(): void;
  on(event: string, listener: (...args: any[]) => void): unknown;
  getUserId(): string | null;
  getRooms(): MatrixRoomLike[];
  getRoom(roomId: string): MatrixRoomLike | null;
  createRoom(opts: {
    preset?: string;
    is_direct?: boolean;
    invite?: string[];
  }): Promise<{ room_id: string }>;
  sendTextMessage(roomId: string, body: string): Promise<unknown>;
  sendEvent(
    roomId: string,
    eventType: string,
    content: Record<string, unknown>,
  ): Promise<unknown>;
  sendTyping(roomId: string, isTyping: boolean, timeoutMs: number): Promise<unknown>;
  joinRoom(roomId: string): Promise<unknown>;
  leave(roomId: string): Promise<unknown>;
}

// ─── Types ──────────────────────────────────────────────────────────────────

export interface MatrixUserMapping {
  mxid: string;
  userId: string;
  roomId: string | null; // canonical unencrypted DM (gateway state, rebuilt at boot)
  agentId: AgentIdentifier;
  assistantId?: string;
  assistantName?: string;
  workspaceId?: string;
  pairedAt: string;
  lastActive: string | null;
}

interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

interface ConversationState {
  agentId: AgentIdentifier;
  lastInteraction: number;
  history: HistoryMessage[];
}

/** The slice of a Mastra agent the gateway needs — injectable for tests. */
export interface AgentLike {
  generate(
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>,
    opts: { requestContext: RequestContext<any>; memory: { resource: string; thread: string } },
  ): Promise<{ text: string }>;
}

export type AgentResolver = (agentId: AgentIdentifier) => Promise<AgentLike>;

/** Default resolver — lazy import so unit tests never load the real agents. */
const defaultAgentResolver: AgentResolver = async (agentId) => {
  const agents = await import('../agents/index.js');
  const { assistantAgent } = await import('../agents/assistant-agent.js');
  const registry: Record<AgentIdentifier, AgentLike> = {
    weather: agents.weatherAgent as unknown as AgentLike,
    pierre: agents.pierreAgent as unknown as AgentLike,
    ash: agents.ashAgent as unknown as AgentLike,
    paddy: agents.projectManagerAgent as unknown as AgentLike,
    zoe: agents.zoeAgent as unknown as AgentLike,
    one2b: agents.one2bAgent as unknown as AgentLike,
    assistant: assistantAgent as unknown as AgentLike,
  };
  return registry[agentId];
};

interface PendingPairing {
  userId: string;
  authToken: string;
  mxid: string;
  roomId: string | null;
  agentId: AgentIdentifier;
  assistantId?: string;
  assistantName?: string;
  workspaceId?: string;
  createdAt: number;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function generatePairingCode(): string {
  return crypto.randomBytes(3).toString('hex').toUpperCase(); // 6-char hex e.g. "A3F1B2"
}

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

// ─── Main Gateway Class ─────────────────────────────────────────────────────

export class MatrixGateway {
  private client: MatrixClientLike | null = null;
  private mappings: Map<string, MatrixUserMapping> = new Map(); // mxid → mapping
  private userIdToMxid: Map<string, string> = new Map(); // userId → mxid (reverse lookup)
  private pendingPairings: Map<string, PendingPairing> = new Map(); // code → pairing
  private authTokens: Map<string, string> = new Map(); // userId → JWT (in-memory only)
  private lastInstructedAt: Map<string, number> = new Map(); // mxid → ts (anti-spam)
  private conversations: Map<string, ConversationState> = new Map(); // userId → state
  private lastNonTextReplyAt: Map<string, number> = new Map(); // roomId → ts
  private httpServer: Server | null = null;
  private pairingCleanupInterval: ReturnType<typeof setInterval> | null = null;
  private started = false;

  constructor(
    private readonly injectedClient: MatrixClientLike | null = null,
    private readonly agentResolver: AgentResolver = defaultAgentResolver,
  ) {
    logger.info(`🚀 [${INSTANCE_ID}] Matrix Gateway initializing...`);
    // Tests inject a fake client and drive the class without initialize()
    // (which binds the HTTP port and hits the real SDK).
    this.client = injectedClient;
  }

  async initialize(): Promise<void> {
    // Start the HTTP server FIRST so /health is always reachable, even if the
    // Matrix client fails to start (bad token, homeserver down).
    this.startHttpServer();
    this.startPairingCleanup();

    const homeserverUrl = process.env.MATRIX_HOMESERVER_URL;
    const accessToken = process.env.MATRIX_ACCESS_TOKEN;
    const botUserId = process.env.MATRIX_BOT_USER_ID;

    if (!this.injectedClient && (!homeserverUrl || !accessToken || !botUserId)) {
      logger.warn(
        `⚠️ [${INSTANCE_ID}] MATRIX_HOMESERVER_URL / MATRIX_ACCESS_TOKEN / MATRIX_BOT_USER_ID not fully set — Matrix client will not start`,
      );
      return;
    }

    await this.loadMappingsFromApp();

    try {
      if (this.injectedClient) {
        this.client = this.injectedClient;
      } else {
        // Lazy import keeps unit tests (which always inject a fake) free of the SDK.
        const sdk = await import('matrix-js-sdk');
        this.client = sdk.createClient({
          baseUrl: homeserverUrl!,
          accessToken: accessToken!,
          userId: botUserId!,
        }) as unknown as MatrixClientLike;
      }

      this.attachClientHandlers();
      await this.client.startClient({ initialSyncLimit: 10 });
      this.started = true;
      logger.info(`✅ [${INSTANCE_ID}] Matrix client started as ${this.client.getUserId()}`);
    } catch (error) {
      // Contain startup errors — never crash the shared gateway process.
      logger.error(`❌ [${INSTANCE_ID}] Failed to start Matrix client:`, error);
      captureException(error, { operation: 'matrixGateway.initialize' });
      this.client = null;
    }
  }

  private attachClientHandlers(): void {
    if (!this.client) return;

    this.client.on('sync', (state: string) => {
      if (state === 'PREPARED') {
        try {
          this.rebuildCanonicalRooms();
        } catch (error) {
          logger.error(`❌ [${INSTANCE_ID}] Canonical-room rebuild failed:`, error);
        }
      } else if (state === 'ERROR') {
        // startClient retries transient sync errors itself; just log.
        logger.warn(`⚠️ [${INSTANCE_ID}] Sync error state (client will retry)`);
      }
    });

    this.client.on(
      'Room.timeline',
      (event: MatrixEventLike, room: MatrixRoomLike | undefined, toStartOfTimeline: boolean | undefined, _removed: boolean, data: { liveEvent?: boolean } | undefined) => {
        void (async () => {
          try {
            if (toStartOfTimeline || (data && data.liveEvent === false)) return;
            await this.handleTimelineEvent(event, room);
          } catch (error) {
            logger.error(`❌ [${INSTANCE_ID}] Timeline handler error:`, error);
            captureException(error, { operation: 'matrixGateway.timeline' });
          }
        })();
      },
    );
  }

  // ─── Mappings (persisted app-side, ADR-0043: no gateway-local file) ──────

  async loadMappingsFromApp(): Promise<void> {
    if (!gatewaySecret()) {
      logger.warn(`⚠️ [${INSTANCE_ID}] GATEWAY_SECRET not set — cannot load mappings`);
      return;
    }
    try {
      const response = await fetch(`${appBaseUrl()}/api/matrix-gateway/mappings`, {
        headers: { 'X-Gateway-Secret': gatewaySecret()! },
      });
      if (!response.ok) {
        logger.error(`❌ [${INSTANCE_ID}] Failed to load mappings: ${response.status}`);
        return;
      }
      const data = await response.json() as { mappings: Array<{ mxid: string; userId: string }> };
      for (const { mxid, userId } of data.mappings) {
        this.mappings.set(mxid, {
          mxid,
          userId,
          roomId: null, // rebuilt from joined-room state after sync
          agentId: 'assistant', // agent preference is gateway-memory only; defaults after restart
          pairedAt: '',
          lastActive: null,
        });
        this.userIdToMxid.set(userId, mxid);
      }
      logger.info(`✅ [${INSTANCE_ID}] Loaded ${this.mappings.size} mapping(s) from app`);
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error loading mappings:`, error);
    }
  }

  private async persistMapping(mxid: string, userId: string): Promise<boolean> {
    if (!gatewaySecret()) {
      logger.warn(`⚠️ [${INSTANCE_ID}] GATEWAY_SECRET not set — cannot persist mapping`);
      return false;
    }
    try {
      const response = await fetch(`${appBaseUrl()}/api/matrix-gateway/mappings`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Secret': gatewaySecret()!,
        },
        body: JSON.stringify({ mxid, userId }),
      });
      if (!response.ok) {
        logger.error(`❌ [${INSTANCE_ID}] Failed to persist mapping: ${response.status}`);
        return false;
      }
      return true;
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error persisting mapping:`, error);
      return false;
    }
  }

  private async deleteMappingInApp(mxid: string): Promise<void> {
    if (!gatewaySecret()) return;
    try {
      await fetch(`${appBaseUrl()}/api/matrix-gateway/mappings`, {
        method: 'DELETE',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Secret': gatewaySecret()!,
        },
        body: JSON.stringify({ mxid }),
      });
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error deleting mapping:`, error);
    }
  }

  /**
   * Rebuild userId → canonical-DM-room from joined-room state. A canonical DM
   * is a bot-created 2-member room whose other member is a paired MXID. This is
   * what lets the app schema stay free of room ids (zero migrations).
   */
  rebuildCanonicalRooms(): void {
    if (!this.client) return;
    const botUserId = this.client.getUserId();
    let rebuilt = 0;
    for (const room of this.client.getRooms()) {
      if (room.getMyMembership() !== 'join') continue;
      const members = room.getJoinedMembers();
      if (members.length !== 2) continue;
      const other = members.find((m) => m.userId !== botUserId);
      if (!other) continue;
      const mapping = this.mappings.get(other.userId);
      if (mapping && !mapping.roomId) {
        mapping.roomId = room.roomId;
        rebuilt++;
      }
    }
    logger.info(`🔁 [${INSTANCE_ID}] Rebuilt canonical rooms for ${rebuilt} mapping(s)`);
  }

  // ─── Message handling ───────────────────────────────────────────────────

  private async handleTimelineEvent(event: MatrixEventLike, room: MatrixRoomLike | undefined): Promise<void> {
    if (!this.client || !room) return;
    if (event.getType() !== 'm.room.message') return;

    const sender = event.getSender();
    if (!sender || sender === this.client.getUserId()) return;

    const content = event.getContent();
    const senderMapping = this.mappings.get(sender);

    // Media / non-text from a paired user in their DM: polite decline, once per burst
    if (content.msgtype !== 'm.text' || typeof content.body !== 'string') {
      if (senderMapping && senderMapping.roomId === room.roomId && content.msgtype) {
        const last = this.lastNonTextReplyAt.get(room.roomId) ?? 0;
        if (Date.now() - last > NON_TEXT_REPLY_COOLDOWN_MS) {
          this.lastNonTextReplyAt.set(room.roomId, Date.now());
          await this.client.sendTextMessage(
            room.roomId,
            "I can only handle text messages for now — attachments and voice notes are on the roadmap.",
          );
        }
      }
      return;
    }
    const text = content.body.trim();
    if (!text) return;

    // 1. Pairing-code redemption (only expected inside the bot-created room)
    const maybeCode = text.toUpperCase();
    if (PAIRING_CODE_PATTERN.test(maybeCode) && this.pendingPairings.has(maybeCode)) {
      await this.completePairing(sender, room, maybeCode);
      return;
    }

    // 2. Paired user in their canonical DM
    const mapping = this.mappings.get(sender);
    if (mapping) {
      if (!mapping.roomId) {
        // Mapping loaded from app but room not rebuilt yet — adopt this room if
        // it looks like our DM (2 members incl. the bot).
        const members = room.getJoinedMembers();
        if (members.length === 2) mapping.roomId = room.roomId;
      }
      if (mapping.roomId === room.roomId) {
        await this.handlePairedMessage(mapping, text);
        return;
      }
      return; // paired user talking somewhere else — DM-only (guardrails handle rooms)
    }

    // 3. Unpaired sender → pairing instructions (cooldown to avoid loops)
    const last = this.lastInstructedAt.get(sender) ?? 0;
    if (Date.now() - last > INSTRUCTION_COOLDOWN_MS) {
      this.lastInstructedAt.set(sender, Date.now());
      await this.client.sendTextMessage(
        room.roomId,
        "You haven't connected your Exponential account yet.\n\nConnect here: https://www.exponential.im/settings/assistant\n\nOnce you have a pairing code, send it here.",
      );
    }
  }

  /** Paired-DM handling: commands, agent selection, then agent routing. */
  protected async handlePairedMessage(mapping: MatrixUserMapping, text: string): Promise<void> {
    mapping.lastActive = new Date().toISOString();

    if (text.startsWith('!')) {
      await this.handleCommand(mapping, text);
      return;
    }

    // Parse for @mention to override agent (Telegram parity)
    const parsed = parseMessageForMention(text);

    let conversation = this.conversations.get(mapping.userId);
    const now = Date.now();

    let agentId: AgentIdentifier;
    if (parsed.agent) {
      agentId = parsed.agent;
    } else if (conversation && (now - conversation.lastInteraction) < CONVERSATION_TIMEOUT_MS) {
      agentId = conversation.agentId;
    } else {
      agentId = mapping.agentId;
    }

    if (!conversation || (now - conversation.lastInteraction) >= CONVERSATION_TIMEOUT_MS) {
      conversation = { agentId, lastInteraction: now, history: [] };
    } else {
      conversation.agentId = agentId;
      conversation.lastInteraction = now;
    }
    this.conversations.set(mapping.userId, conversation);

    await this.processMessage(mapping, parsed.text, agentId, conversation);
  }

  private async handleCommand(mapping: MatrixUserMapping, text: string): Promise<void> {
    const roomId = mapping.roomId!;
    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase();

    switch (command) {
      case '!agent': {
        const agentName = parts[1]?.toLowerCase();
        const validAgents: AgentIdentifier[] = ['assistant', 'zoe', 'paddy', 'pierre', 'ash', 'weather', 'one2b'];
        if (!agentName || !validAgents.includes(agentName as AgentIdentifier)) {
          await this.client?.sendTextMessage(
            roomId,
            `Switch your default agent with: !agent NAME\nAvailable: ${validAgents.join(', ')}\n(Current: ${mapping.agentId})`,
          );
          return;
        }
        mapping.agentId = agentName as AgentIdentifier;
        await this.client?.sendTextMessage(roomId, `Default agent switched to ${agentName}. You can also @mention an agent inline.`);
        break;
      }
      case '!help': {
        await this.client?.sendTextMessage(
          roomId,
          'Exponential Matrix Bot\n\nCommands:\n!agent NAME — switch default agent\n!help — this help\n\nYou can also @mention an agent inline, e.g. "@zoe how is my week looking?"\nManage the connection at https://www.exponential.im/settings/assistant',
        );
        break;
      }
      default:
        // Unknown ! command — treat as a normal message? No: ignore quietly.
        break;
    }
  }

  private async processMessage(
    mapping: MatrixUserMapping,
    text: string,
    agentId: AgentIdentifier,
    conversation: ConversationState,
  ): Promise<void> {
    const roomId = mapping.roomId!;
    if (!this.client) return;
    let typing = false;

    try {
      let authToken = this.authTokens.get(mapping.userId) ?? null;
      if (!authToken) {
        // Post-restart: tokens are memory-only, mint a fresh one
        authToken = await this.refreshAuthToken(mapping.userId);
        if (!authToken) {
          await this.client.sendTextMessage(
            roomId,
            'Your session has expired. Please reconnect from the Exponential app (Settings > Assistant).',
          );
          return;
        }
      }

      const agent = await this.agentResolver(agentId);
      logger.info(`🤖 [${INSTANCE_ID}] Routing to @${agentId} for user ${mapping.userId}`);

      await this.client.sendTyping(roomId, true, TYPING_TIMEOUT_MS);
      typing = true;

      const history = conversation.history;
      history.push({ role: 'user', content: text });
      while (history.length > MAX_HISTORY_MESSAGES) {
        history.shift();
      }

      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: MATRIX_SYSTEM_CONTEXT },
        ...history,
      ];

      const createRequestContext = (token: string) => {
        return new RequestContext([
          ['authToken', token],
          ['userId', mapping.userId],
          ['matrixRoomId', roomId],
          ...(mapping.workspaceId ? [['workspaceId', mapping.workspaceId] as [string, string]] : []),
        ]);
      };

      const memoryScope = {
        resource: mapping.userId,
        thread: `matrix-${mapping.userId}-${roomId}`,
      };

      let response;
      try {
        response = await agent.generate(messages, {
          requestContext: createRequestContext(authToken),
          memory: memoryScope,
        });
      } catch (error) {
        if (this.isUnauthorizedError(error)) {
          logger.warn(`⚠️ [${INSTANCE_ID}] Auth error for user ${mapping.userId}, refreshing token...`);
          const newToken = await this.refreshAuthToken(mapping.userId);
          if (newToken) {
            authToken = newToken;
            response = await agent.generate(messages, {
              requestContext: createRequestContext(authToken),
              memory: memoryScope,
            });
          } else {
            throw error;
          }
        } else {
          throw error;
        }
      }

      const agentResponse = response.text;

      if (agentResponse) {
        history.push({ role: 'assistant', content: agentResponse });
        while (history.length > MAX_HISTORY_MESSAGES) {
          history.shift();
        }

        await this.sendMarkdownMessage(roomId, agentResponse);
        logger.info(`✅ [${INSTANCE_ID}] Sent response to user ${mapping.userId} (history: ${history.length} msgs)`);
      } else {
        await this.client.sendTextMessage(roomId, "Sorry, I couldn't process your request. Please try again.");
      }
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error processing message for user ${mapping.userId}:`, error);
      captureException(error, {
        userId: mapping.userId,
        operation: 'processMessage',
        extra: { agentId, roomId, textPreview: text.substring(0, 100) },
      });
      await this.client.sendTextMessage(roomId, 'Sorry, I encountered an error. Please try again later.');
    } finally {
      if (typing) {
        await this.client.sendTyping(roomId, false, 0).catch(() => undefined);
      }
    }
  }

  /**
   * Send agent markdown as a Matrix message: markdown source in `body`
   * (spec-intended plain-text fallback), rendered HTML in `formatted_body`.
   */
  private async sendMarkdownMessage(roomId: string, markdown: string): Promise<void> {
    let formatted: string | null = null;
    try {
      formatted = markdownToMatrixHtml(markdown);
    } catch {
      formatted = null; // rendering failed — fall back to plain text
    }

    if (formatted) {
      await this.client?.sendEvent(roomId, 'm.room.message', {
        msgtype: 'm.text',
        body: markdown,
        format: 'org.matrix.custom.html',
        formatted_body: formatted,
      });
    } else {
      await this.client?.sendTextMessage(roomId, markdown);
    }
  }

  private async refreshAuthToken(userId: string): Promise<string | null> {
    if (!gatewaySecret()) {
      logger.warn(`⚠️ [${INSTANCE_ID}] Cannot refresh token: GATEWAY_SECRET not configured`);
      return null;
    }

    try {
      logger.info(`🔄 [${INSTANCE_ID}] Refreshing auth token for user ${userId}`);

      const response = await fetch(`${appBaseUrl()}/api/matrix-gateway/refresh-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Secret': gatewaySecret()!,
        },
        body: JSON.stringify({ userId }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`❌ [${INSTANCE_ID}] Token refresh failed: ${response.status} - ${errorText}`);
        captureAuthFailure(new Error(`Token refresh failed: ${response.status}`), {
          userId,
          endpoint: `${appBaseUrl()}/api/matrix-gateway/refresh-token`,
          statusCode: response.status,
        });
        return null;
      }

      const data = await response.json() as { token: string; expiresAt: string };
      this.authTokens.set(userId, data.token);
      logger.info(`✅ [${INSTANCE_ID}] Token refreshed for user ${userId}, expires at ${data.expiresAt}`);
      return data.token;
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error refreshing token:`, error);
      captureException(error, { userId, operation: 'refreshAuthToken' });
      return null;
    }
  }

  private isUnauthorizedError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return message.includes('unauthorized') || message.includes('401');
    }
    return false;
  }

  // ─── Pairing flow ──────────────────────────────────────────────────────

  /**
   * Called from POST /pair. Unlike Telegram (where the user initiates the chat),
   * the BOT must create the DM: a user-initiated Element DM is encrypted by
   * default and this gateway deliberately has no crypto (ADR-0043). The code
   * sent back inside the bot-created room proves the caller owns the MXID.
   */
  async beginPairing(
    userId: string,
    authToken: string,
    mxid: string,
    agentId: AgentIdentifier = 'assistant',
    assistantId?: string,
    assistantName?: string,
    workspaceId?: string,
  ): Promise<{ pairingCode: string; roomId: string | null }> {
    if (!MXID_PATTERN.test(mxid)) {
      throw new Error('A full Matrix user ID is required (e.g. @you:syntro.fi)');
    }

    // Drop any previous pending pairing for this user
    for (const [code, pairing] of this.pendingPairings) {
      if (pairing.userId === userId) this.pendingPairings.delete(code);
    }

    // Reuse the existing canonical room on re-pair, else create a fresh
    // UNENCRYPTED room (no m.room.encryption initial state — ADR-0043).
    let roomId: string | null = this.mappings.get(mxid)?.roomId ?? null;
    if (!roomId && this.client) {
      const created = await this.client.createRoom({
        preset: 'trusted_private_chat',
        is_direct: true,
        invite: [mxid],
      });
      roomId = created.room_id;
    }

    const code = generatePairingCode();
    this.pendingPairings.set(code, {
      userId,
      authToken,
      mxid,
      roomId,
      agentId,
      assistantId,
      assistantName,
      workspaceId,
      createdAt: Date.now(),
    });

    if (roomId) {
      await this.client?.sendTextMessage(
        roomId,
        'Hi! To connect your Exponential account, reply here with the pairing code shown in the app.',
      );
    }

    logger.info(`🔑 [${INSTANCE_ID}] Generated pairing code ${code} for user ${userId} (${mxid})`);
    return { pairingCode: code, roomId };
  }

  private async completePairing(senderMxid: string, room: MatrixRoomLike, code: string): Promise<void> {
    const pairing = this.pendingPairings.get(code);
    if (!pairing || !this.client) return;

    if (pairing.mxid !== senderMxid) {
      // Someone other than the claimed MXID sent the code — ownership proof failed.
      logger.warn(`⚠️ [${INSTANCE_ID}] Pairing code from unexpected sender ${senderMxid} (expected ${pairing.mxid})`);
      await this.client.sendTextMessage(
        room.roomId,
        'This pairing code was issued for a different Matrix account. Please generate a new one from the Exponential app.',
      );
      return;
    }

    if (Date.now() - pairing.createdAt > PAIRING_CODE_TTL_MS) {
      this.pendingPairings.delete(code);
      await this.client.sendTextMessage(
        room.roomId,
        'This pairing code has expired. Please generate a new one from the Exponential app.',
      );
      return;
    }

    const persisted = await this.persistMapping(pairing.mxid, pairing.userId);
    if (!persisted) {
      await this.client.sendTextMessage(
        room.roomId,
        'Something went wrong saving your connection. Please try again in a moment.',
      );
      return;
    }

    // Remove any previous mapping for this user (re-pairing from a new MXID)
    const previousMxid = this.userIdToMxid.get(pairing.userId);
    if (previousMxid && previousMxid !== pairing.mxid) {
      this.mappings.delete(previousMxid);
    }

    const mapping: MatrixUserMapping = {
      mxid: pairing.mxid,
      userId: pairing.userId,
      roomId: pairing.roomId ?? room.roomId,
      agentId: pairing.agentId,
      assistantId: pairing.assistantId,
      assistantName: pairing.assistantName,
      workspaceId: pairing.workspaceId,
      pairedAt: new Date().toISOString(),
      lastActive: null,
    };
    this.mappings.set(pairing.mxid, mapping);
    this.userIdToMxid.set(pairing.userId, pairing.mxid);
    this.authTokens.set(pairing.userId, pairing.authToken);
    this.pendingPairings.delete(code);

    let welcome: string;
    if (mapping.agentId === 'assistant' && mapping.assistantName) {
      welcome = `Connected! I'm ${mapping.assistantName} — your AI assistant here in Exponential.\n\nJust type a message to get started.`;
    } else {
      const agentLabel = mapping.agentId === 'assistant' ? 'your assistant' : mapping.agentId;
      welcome = `Connected! Your default agent is ${agentLabel}.\n\nJust type a message to get started.`;
    }
    await this.client.sendTextMessage(mapping.roomId!, welcome);

    logger.info(`🔗 [${INSTANCE_ID}] Paired user ${pairing.userId} to ${pairing.mxid} (room ${mapping.roomId})`);
  }

  private startPairingCleanup(): void {
    this.pairingCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [code, pairing] of this.pendingPairings) {
        if (now - pairing.createdAt > PAIRING_CODE_TTL_MS) {
          this.pendingPairings.delete(code);
        }
      }
    }, 60_000);
  }

  // ─── HTTP API Server ──────────────────────────────────────────────────

  private startHttpServer(): void {
    this.httpServer = createServer(async (req, res) => {
      setCorsHeaders(req, res);

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        await this.handleRequest(req, res);
      } catch (error: any) {
        logger.error(`❌ [${INSTANCE_ID}] HTTP error:`, error);
        sendJsonResponse(res, 500, { error: error.message || 'Internal server error' });
      }
    });

    this.httpServer.listen(GATEWAY_PORT, () => {
      logger.info(`🌐 [${INSTANCE_ID}] Matrix Gateway HTTP server running at http://localhost:${GATEWAY_PORT}`);
      logger.info(`   POST   /pair     — Begin pairing (creates the unencrypted DM)`);
      logger.info(`   DELETE /pair     — Unpair account`);
      logger.info(`   GET    /status   — Check pairing status`);
      logger.info(`   GET    /health   — Liveness (no auth)`);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${GATEWAY_PORT}`);
    const pathname = url.pathname;

    if (req.method === 'GET' && pathname === '/health') {
      sendJsonResponse(res, 200, {
        status: 'ok',
        matrixConnected: this.started && this.client !== null,
      });
      return;
    }

    const authHeader = req.headers.authorization;
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!authToken) {
      sendJsonResponse(res, 401, { error: 'Authorization header required' });
      return;
    }

    let userId: string;
    try {
      userId = verifyAndExtractUserId(authToken, { audience: 'matrix-gateway' });
    } catch (error) {
      handleGatewayError(error, res);
      return;
    }

    if (req.method === 'POST' && pathname === '/pair') {
      await this.handlePairRequest(userId, authToken, req, res);
    } else if (req.method === 'DELETE' && pathname === '/pair') {
      await this.handleUnpairRequest(userId, res);
    } else if (req.method === 'GET' && pathname === '/status') {
      this.handleStatusRequest(userId, res);
    } else {
      sendJsonResponse(res, 404, { error: 'Not found' });
    }
  }

  private async handlePairRequest(
    userId: string,
    authToken: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const body = await readBody(req);
      const { mxid, agentId, assistantId, assistantName, workspaceId } = body ? JSON.parse(body) : {};

      if (!this.client) {
        sendJsonResponse(res, 503, { error: 'Matrix client is not connected' });
        return;
      }

      const { pairingCode, roomId } = await this.beginPairing(
        userId,
        authToken,
        mxid,
        agentId || 'assistant',
        assistantId,
        assistantName,
        workspaceId,
      );

      sendJsonResponse(res, 200, {
        pairingCode,
        roomId,
        botUserId: this.client.getUserId(),
        expiresInSeconds: PAIRING_CODE_TTL_MS / 1000,
      });
    } catch (error: any) {
      sendJsonResponse(res, 400, { error: error.message || 'Invalid request' });
    }
  }

  private async handleUnpairRequest(userId: string, res: ServerResponse): Promise<void> {
    const mxid = this.userIdToMxid.get(userId);
    if (mxid === undefined) {
      sendJsonResponse(res, 404, { error: 'No Matrix account linked' });
      return;
    }

    const mapping = this.mappings.get(mxid);
    this.mappings.delete(mxid);
    this.userIdToMxid.delete(userId);
    this.authTokens.delete(userId);
    await this.deleteMappingInApp(mxid);

    if (mapping?.roomId) {
      await this.client?.sendTextMessage(
        mapping.roomId,
        'Your Exponential account has been disconnected. You can reconnect anytime.',
      );
    }

    sendJsonResponse(res, 200, { success: true });
    logger.info(`👋 [${INSTANCE_ID}] User ${userId} unpaired via API`);
  }

  private handleStatusRequest(userId: string, res: ServerResponse): void {
    const mxid = this.userIdToMxid.get(userId);
    if (mxid === undefined) {
      sendJsonResponse(res, 200, { paired: false });
      return;
    }

    const mapping = this.mappings.get(mxid);
    sendJsonResponse(res, 200, {
      paired: true,
      mxid,
      agentId: mapping?.agentId || null,
      lastActive: mapping?.lastActive || null,
    });
  }

  // ─── Test hooks (state inspection for unit tests) ─────────────────────

  getMappingByMxid(mxid: string): MatrixUserMapping | undefined {
    return this.mappings.get(mxid);
  }

  hasPendingCode(code: string): boolean {
    return this.pendingPairings.has(code);
  }

  /** Test-only: drive a timeline event without a real sync loop. */
  async _handleTimelineEventForTest(event: MatrixEventLike, room: MatrixRoomLike): Promise<void> {
    await this.handleTimelineEvent(event, room);
  }

  /** Test-only: age a pending pairing so expiry paths can be exercised. */
  _agePendingPairingForTest(code: string, ageMs: number): void {
    const pairing = this.pendingPairings.get(code);
    if (pairing) pairing.createdAt = Date.now() - ageMs;
  }

  // ─── Shutdown ─────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    logger.info(`🛑 [${INSTANCE_ID}] Shutting down Matrix Gateway...`);

    if (this.pairingCleanupInterval) {
      clearInterval(this.pairingCleanupInterval);
    }

    if (this.client) {
      try {
        this.client.stopClient();
      } catch (error) {
        logger.error(`❌ [${INSTANCE_ID}] Error stopping Matrix client:`, error);
      }
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
    }

    logger.info(`✅ [${INSTANCE_ID}] Matrix Gateway shutdown complete`);
  }
}

// ─── Global instance management ─────────────────────────────────────────────

let globalGateway: MatrixGateway | null = null;

export function createMatrixGateway(): MatrixGateway | null {
  if (globalGateway) {
    logger.info(`♻️ [${INSTANCE_ID}] Matrix Gateway already exists, reusing instance`);
    return globalGateway;
  }

  if (!process.env.MATRIX_ACCESS_TOKEN) {
    logger.warn(`⚠️ [${INSTANCE_ID}] MATRIX_ACCESS_TOKEN not set — Matrix Gateway will not start`);
    return null;
  }

  try {
    globalGateway = new MatrixGateway();
    globalGateway.initialize().catch(err => {
      logger.error(`❌ [${INSTANCE_ID}] Failed to initialize Matrix Gateway:`, err);
      globalGateway = null;
    });
    return globalGateway;
  } catch (error) {
    logger.error(`❌ [${INSTANCE_ID}] Failed to create Matrix Gateway:`, error);
    return null;
  }
}

export async function cleanupMatrixGateway(): Promise<void> {
  if (globalGateway) {
    await globalGateway.shutdown();
    globalGateway = null;
  }
}

export function getMatrixGateway(): MatrixGateway | null {
  return globalGateway;
}
