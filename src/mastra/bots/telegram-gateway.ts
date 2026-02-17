import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';

import TelegramBot from 'node-telegram-bot-api';
import { createLogger } from '@mastra/core/logger';
import { RequestContext } from '@mastra/core/di';

import {
  GatewayError,
  type AgentIdentifier,
  verifyAndExtractUserId,
  encryptToken,
  decryptToken,
  parseMessageForMention,
  splitMessage,
  sendJsonResponse,
  handleGatewayError,
  setCorsHeaders,
} from '../utils/gateway-shared.js';
import {
  weatherAgent,
  pierreAgent,
  ashAgent,
  projectManagerAgent,
  zoeAgent,
} from '../agents/index.js';
import { assistantAgent } from '../agents/assistant-agent.js';
import { captureException, captureAuthFailure } from '../utils/sentry.js';

function getAgentByIdentifier(identifier: AgentIdentifier) {
  const agents = {
    'weather': weatherAgent,
    'pierre': pierreAgent,
    'ash': ashAgent,
    'paddy': projectManagerAgent,
    'zoe': zoeAgent,
    'assistant': assistantAgent,
  };
  return agents[identifier];
}

const logger = createLogger({
  name: 'TelegramGateway',
  level: 'info',
});

const INSTANCE_ID = `tg-gateway-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Configuration
const GATEWAY_PORT = parseInt(process.env.TELEGRAM_GATEWAY_PORT || '4113', 10);
const SESSIONS_DIR = process.env.TELEGRAM_SESSIONS_DIR || path.join(os.homedir(), '.mastra', 'telegram-sessions');
const MAPPINGS_FILE = path.join(SESSIONS_DIR, 'telegram-mappings.json');
const MAX_MESSAGE_LENGTH = 4096;
const CONVERSATION_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_HISTORY_MESSAGES = 10;

// Token refresh configuration
const TODO_APP_BASE_URL = process.env.TODO_APP_BASE_URL || 'http://localhost:3000';
const GATEWAY_SECRET = process.env.GATEWAY_SECRET || process.env.WHATSAPP_GATEWAY_SECRET;

// ─── Types ──────────────────────────────────────────────────────────────────

interface TelegramUserMapping {
  telegramChatId: number;
  telegramUsername: string | null;
  userId: string;
  encryptedAuthToken: string;
  agentId: string;
  assistantId?: string;
  assistantName?: string;
  workspaceId?: string;
  pairedAt: string;
  lastActive: string | null;
}

interface MappingsFile {
  [telegramChatId: string]: TelegramUserMapping;
}

interface PendingPairing {
  userId: string;
  authToken: string;
  agentId: string;
  assistantId?: string;
  assistantName?: string;
  workspaceId?: string;
  createdAt: number;
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

// ─── Telegram formatting context ────────────────────────────────────────────

const TELEGRAM_SYSTEM_CONTEXT = `You are responding via Telegram. Format your responses for Telegram:
- Use *bold* for emphasis (renders correctly)
- Use _italic_ for subtle emphasis
- Use \`code\` for inline code
- Use numbered lists (1. 2. 3.) for ordered items
- Keep responses concise — Telegram has a 4096 character limit per message
- NO markdown tables — they don't render properly in Telegram
- NO headers with # — use *bold text* instead
- NO markdown links [text](url) — just write the URL directly

Example format for lists:
1. *Item Name* (Status, Priority)
   Brief description here...

2. *Another Item* (Status, Priority)
   Another description...`;

// ─── Helpers ────────────────────────────────────────────────────────────────

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

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

export class TelegramGateway {
  private bot: TelegramBot | null = null;
  private mappings: Map<number, TelegramUserMapping> = new Map(); // chatId → mapping
  private userIdToChatId: Map<string, number> = new Map(); // userId → chatId (reverse lookup)
  private pendingPairings: Map<string, PendingPairing> = new Map(); // code → pairing
  private conversations: Map<number, ConversationState> = new Map(); // chatId → state
  private httpServer: Server | null = null;
  private pairingCleanupInterval: ReturnType<typeof setInterval> | null = null;

  constructor() {
    logger.info(`🚀 [${INSTANCE_ID}] Telegram Gateway initializing...`);
  }

  async initialize(): Promise<void> {
    await ensureDir(SESSIONS_DIR);
    await this.loadMappings();

    // Start HTTP server FIRST so the health check endpoint is always reachable,
    // even if the Telegram bot fails to start (e.g. polling conflict, bad token).
    this.startHttpServer();
    this.startPairingCleanup();

    try {
      await this.startBot();
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Telegram bot failed to start, HTTP server still running:`, error);
    }

    logger.info(`✅ [${INSTANCE_ID}] Telegram Gateway initialized with ${this.mappings.size} paired user(s)`);
  }

  // ─── Mappings persistence ───────────────────────────────────────────────

  private async loadMappings(): Promise<void> {
    try {
      const data = await fs.readFile(MAPPINGS_FILE, 'utf-8');
      const file: MappingsFile = JSON.parse(data);

      for (const [chatIdStr, mapping] of Object.entries(file)) {
        const chatId = Number(chatIdStr);
        this.mappings.set(chatId, mapping);
        this.userIdToChatId.set(mapping.userId, chatId);
      }

      logger.info(`📂 [${INSTANCE_ID}] Loaded ${this.mappings.size} mapping(s) from disk`);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        logger.error(`❌ [${INSTANCE_ID}] Error loading mappings:`, error);
      }
    }
  }

  private async saveMappings(): Promise<void> {
    try {
      const file: MappingsFile = {};
      for (const [chatId, mapping] of this.mappings) {
        file[String(chatId)] = mapping;
      }
      await fs.writeFile(MAPPINGS_FILE, JSON.stringify(file, null, 2));
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error saving mappings:`, error);
    }
  }

  // ─── Telegram bot ───────────────────────────────────────────────────────

  private async startBot(): Promise<void> {
    const token = process.env.TELEGRAM_BOT_TOKEN;
    if (!token) {
      logger.warn(`⚠️ [${INSTANCE_ID}] TELEGRAM_BOT_TOKEN not set, bot will not start`);
      return;
    }

    try {
      // Clear stale polling connections
      await this.clearExistingConnections(token);

      this.bot = new TelegramBot(token, { polling: false });
      this.setupEventHandlers();
      await this.bot.startPolling();

      const me = await this.bot.getMe();
      logger.info(`✅ [${INSTANCE_ID}] Telegram bot @${me.username} polling started`);
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Failed to start Telegram bot:`, error);
      throw error;
    }
  }

  private async clearExistingConnections(token: string): Promise<void> {
    try {
      const response = await fetch(`https://api.telegram.org/bot${token}/getUpdates?offset=-1`, {
        method: 'POST',
      });
      if (response.ok) {
        logger.info(`✅ [${INSTANCE_ID}] Cleared existing Telegram connections`);
      }
    } catch (error) {
      logger.warn(`⚠️ [${INSTANCE_ID}] Could not clear existing connections:`, error);
    }
  }

  private setupEventHandlers(): void {
    if (!this.bot) return;

    this.bot.on('message', async (msg) => {
      try {
        await this.handleMessage(msg);
      } catch (error) {
        logger.error(`❌ [${INSTANCE_ID}] Error handling message from ${msg.chat.id}:`, error);
      }
    });

    this.bot.on('error', (error) => {
      logger.error(`🚨 [${INSTANCE_ID}] Bot error:`, error);
    });

    this.bot.on('polling_error', (error) => {
      logger.error(`🔄 [${INSTANCE_ID}] Polling error:`, error);
    });
  }

  // ─── Message handling ───────────────────────────────────────────────────

  private async handleMessage(msg: TelegramBot.Message): Promise<void> {
    const chatId = msg.chat.id;
    const text = msg.text;

    if (!text) return;

    // Handle commands
    if (text.startsWith('/')) {
      await this.handleCommand(msg, text);
      return;
    }

    // Look up paired user
    const mapping = this.mappings.get(chatId);
    if (!mapping) {
      await this.bot?.sendMessage(
        chatId,
        "You haven't connected your Exponential account yet.\n\nConnect here: https://www.exponential.im/settings/assistant\n\nOnce you have a pairing code, send /start CODE here"
      );
      return;
    }

    logger.info(`📨 [${INSTANCE_ID}] Message from user ${mapping.userId} (chat ${chatId}): ${text.substring(0, 50)}...`);

    // Parse for @mention to override agent
    const parsed = parseMessageForMention(text);

    // Manage conversation state
    let conversation = this.conversations.get(chatId);
    const now = Date.now();

    let agentId: AgentIdentifier;
    if (parsed.agent) {
      // Explicit @mention overrides
      agentId = parsed.agent;
    } else if (conversation && (now - conversation.lastInteraction) < CONVERSATION_TIMEOUT_MS) {
      // Continue active conversation
      agentId = conversation.agentId;
    } else {
      // Default to user's configured agent
      agentId = mapping.agentId as AgentIdentifier;
    }

    // Update or create conversation state (preserve history if continuing)
    if (!conversation || (now - conversation.lastInteraction) >= CONVERSATION_TIMEOUT_MS) {
      conversation = { agentId, lastInteraction: now, history: [] };
    } else {
      conversation.agentId = agentId;
      conversation.lastInteraction = now;
    }
    this.conversations.set(chatId, conversation);

    // Process with agent
    await this.processMessage(mapping, chatId, parsed.text, agentId, conversation);
  }

  private async handleCommand(msg: TelegramBot.Message, text: string): Promise<void> {
    const chatId = msg.chat.id;
    const parts = text.split(/\s+/);
    const command = parts[0].toLowerCase().replace(/@\w+$/, ''); // Strip bot username suffix

    switch (command) {
      case '/start': {
        const code = parts[1];
        if (!code) {
          await this.bot?.sendMessage(
            chatId,
            "Welcome! To connect your Exponential account:\n\n1. Go to https://www.exponential.im/settings/assistant\n2. Click \"Connect Telegram\" to get a pairing code\n3. Send /start CODE here\n\nExample: /start A3F1B2"
          );
          return;
        }
        await this.completePairing(msg, code.toUpperCase());
        break;
      }

      case '/disconnect': {
        const mapping = this.mappings.get(chatId);
        if (!mapping) {
          await this.bot?.sendMessage(chatId, "You don't have a connected account.");
          return;
        }
        this.mappings.delete(chatId);
        this.userIdToChatId.delete(mapping.userId);
        this.conversations.delete(chatId);
        await this.saveMappings();
        await this.bot?.sendMessage(chatId, "Disconnected. You can reconnect anytime with a new pairing code.");
        logger.info(`👋 [${INSTANCE_ID}] User ${mapping.userId} disconnected (chat ${chatId})`);
        break;
      }

      case '/agent': {
        const agentName = parts[1]?.toLowerCase();
        if (!agentName) {
          await this.bot?.sendMessage(
            chatId,
            "Switch your default agent:\n/agent assistant\n/agent zoe\n/agent paddy\n/agent pierre\n/agent ash\n/agent weather"
          );
          return;
        }

        const mapping = this.mappings.get(chatId);
        if (!mapping) {
          await this.bot?.sendMessage(chatId, "Please connect your account first with /start CODE");
          return;
        }

        const validAgents: AgentIdentifier[] = ['assistant', 'zoe', 'paddy', 'pierre', 'ash', 'weather'];
        if (!validAgents.includes(agentName as AgentIdentifier)) {
          await this.bot?.sendMessage(chatId, `Unknown agent "${agentName}". Available: ${validAgents.join(', ')}`);
          return;
        }

        mapping.agentId = agentName;
        await this.saveMappings();
        await this.bot?.sendMessage(chatId, `Default agent switched to *${agentName}*. You can also use @mention to talk to a specific agent.`, { parse_mode: 'Markdown' });
        break;
      }

      case '/help': {
        await this.bot?.sendMessage(
          chatId,
          "*Exponential Telegram Bot*\n\n" +
          "Commands:\n" +
          "/start CODE — Connect your Exponential account\n" +
          "/disconnect — Disconnect your account\n" +
          "/agent NAME — Switch default agent (assistant, zoe, paddy, pierre, ash, weather)\n" +
          "/help — Show this help\n\n" +
          "You can also @mention an agent inline:\n" +
          "@paddy what are my tasks?\n" +
          "@zoe how's my week looking?",
          { parse_mode: 'Markdown' }
        );
        break;
      }

      default:
        // Unknown command, ignore
        break;
    }
  }

  // ─── Pairing flow ──────────────────────────────────────────────────────

  generatePairingCode(
    userId: string,
    authToken: string,
    agentId: string = 'assistant',
    assistantId?: string,
    assistantName?: string,
    workspaceId?: string,
  ): string {
    // Check if user already has a pairing — remove old one
    for (const [code, pairing] of this.pendingPairings) {
      if (pairing.userId === userId) {
        this.pendingPairings.delete(code);
      }
    }

    const code = generatePairingCode();
    this.pendingPairings.set(code, {
      userId,
      authToken,
      agentId,
      assistantId,
      assistantName,
      workspaceId,
      createdAt: Date.now(),
    });

    logger.info(`🔑 [${INSTANCE_ID}] Generated pairing code ${code} for user ${userId}`);
    return code;
  }

  private async completePairing(msg: TelegramBot.Message, code: string): Promise<void> {
    const chatId = msg.chat.id;
    const pairing = this.pendingPairings.get(code);

    if (!pairing) {
      // Check if already connected (duplicate /start from deep link)
      const existingMapping = this.mappings.get(chatId);
      if (existingMapping) {
        // Already paired — silently ignore the duplicate
        return;
      }
      await this.bot?.sendMessage(
        chatId,
        "Invalid or expired pairing code. Please generate a new one from the Exponential app."
      );
      return;
    }

    // Check expiry
    if (Date.now() - pairing.createdAt > PAIRING_CODE_TTL_MS) {
      this.pendingPairings.delete(code);
      await this.bot?.sendMessage(
        chatId,
        "This pairing code has expired. Please generate a new one from the Exponential app."
      );
      return;
    }

    // Remove any existing mapping for this user (re-pairing)
    const existingChatId = this.userIdToChatId.get(pairing.userId);
    if (existingChatId !== undefined) {
      this.mappings.delete(existingChatId);
      this.conversations.delete(existingChatId);
    }

    // Encrypt the auth token for storage
    const secret = process.env.AUTH_SECRET;
    if (!secret) {
      await this.bot?.sendMessage(chatId, "Server configuration error. Please try again later.");
      logger.error(`❌ [${INSTANCE_ID}] AUTH_SECRET not configured, cannot encrypt token`);
      return;
    }

    const mapping: TelegramUserMapping = {
      telegramChatId: chatId,
      telegramUsername: msg.from?.username || null,
      userId: pairing.userId,
      encryptedAuthToken: encryptToken(pairing.authToken, secret),
      agentId: pairing.agentId,
      assistantId: pairing.assistantId,
      assistantName: pairing.assistantName,
      workspaceId: pairing.workspaceId,
      pairedAt: new Date().toISOString(),
      lastActive: null,
    };

    this.mappings.set(chatId, mapping);
    this.userIdToChatId.set(pairing.userId, chatId);
    this.pendingPairings.delete(code);
    await this.saveMappings();

    let welcomeMsg: string;
    if (mapping.agentId === 'assistant' && mapping.assistantName) {
      welcomeMsg = `Connected! I'm *${mapping.assistantName}* — your AI assistant here in Exponential.\n\nJust type a message to get started.\n\nUse /help to see all commands.`;
    } else {
      const agentLabel = mapping.agentId === 'assistant' ? 'your assistant' : `*${mapping.agentId}*`;
      welcomeMsg = `Connected! Your default agent is ${agentLabel}.\n\nJust type a message to get started.\n\nUse /help to see all commands.`;
    }
    await this.bot?.sendMessage(chatId, welcomeMsg, { parse_mode: 'Markdown' });

    logger.info(`🔗 [${INSTANCE_ID}] Paired user ${pairing.userId} to Telegram chat ${chatId} (@${msg.from?.username})`);
  }

  private startPairingCleanup(): void {
    // Clean up expired pairing codes every minute
    this.pairingCleanupInterval = setInterval(() => {
      const now = Date.now();
      for (const [code, pairing] of this.pendingPairings) {
        if (now - pairing.createdAt > PAIRING_CODE_TTL_MS) {
          this.pendingPairings.delete(code);
        }
      }
    }, 60_000);
  }

  // ─── Agent message processing ──────────────────────────────────────────

  private async processMessage(
    mapping: TelegramUserMapping,
    chatId: number,
    text: string,
    agentId: AgentIdentifier,
    conversation: ConversationState,
  ): Promise<void> {
    try {
      // Show typing indicator
      await this.bot?.sendChatAction(chatId, 'typing');

      // Decrypt auth token
      const secret = process.env.AUTH_SECRET;
      if (!secret) {
        await this.bot?.sendMessage(chatId, "Server configuration error. Please try again later.");
        return;
      }

      let authToken = decryptToken(mapping.encryptedAuthToken, secret);
      if (!authToken) {
        logger.warn(`⚠️ [${INSTANCE_ID}] Failed to decrypt token for user ${mapping.userId}, attempting refresh...`);
        authToken = await this.refreshAuthToken(mapping);
        if (!authToken) {
          await this.bot?.sendMessage(
            chatId,
            "Your session has expired. Please reconnect from the Exponential app (Settings > Integrations > Telegram)."
          );
          return;
        }
      }

      const agent = getAgentByIdentifier(agentId);
      logger.info(`🤖 [${INSTANCE_ID}] Routing to @${agentId} for user ${mapping.userId}`);

      // Build conversation history
      const history = conversation.history;
      history.push({ role: 'user', content: text });
      while (history.length > MAX_HISTORY_MESSAGES) {
        history.shift();
      }

      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: TELEGRAM_SYSTEM_CONTEXT },
        ...history,
      ];

      // Create RequestContext
      const createRequestContext = (token: string) => {
        return new RequestContext([
          ['authToken', token],
          ['userId', mapping.userId],
          ['telegramChatId', String(chatId)],
          ...(mapping.workspaceId ? [['workspaceId', mapping.workspaceId] as [string, string]] : []),
        ]);
      };

      const memoryScope = {
        resource: mapping.userId,
        thread: `tg-${mapping.userId}-${chatId}`,
      };

      // Call agent with retry on auth failure
      let response;
      try {
        response = await agent.generate(messages, {
          requestContext: createRequestContext(authToken),
          memory: memoryScope,
        });
      } catch (error) {
        if (this.isUnauthorizedError(error)) {
          logger.warn(`⚠️ [${INSTANCE_ID}] Auth error for user ${mapping.userId}, refreshing token...`);
          const newToken = await this.refreshAuthToken(mapping);
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

        await this.sendLongMessage(chatId, agentResponse);

        // Update last active
        mapping.lastActive = new Date().toISOString();
        await this.saveMappings();

        logger.info(`✅ [${INSTANCE_ID}] Sent response to user ${mapping.userId} (history: ${history.length} msgs)`);
      } else {
        await this.bot?.sendMessage(chatId, "Sorry, I couldn't process your request. Please try again.");
      }
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error processing message for user ${mapping.userId}:`, error);

      captureException(error, {
        userId: mapping.userId,
        operation: 'processMessage',
        extra: { agentId, chatId, textPreview: text.substring(0, 100) },
      });

      await this.bot?.sendMessage(chatId, "Sorry, I encountered an error. Please try again later.");
    }
  }

  private async sendLongMessage(chatId: number, message: string): Promise<void> {
    if (message.length <= MAX_MESSAGE_LENGTH) {
      try {
        await this.bot?.sendMessage(chatId, message, { parse_mode: 'Markdown' });
      } catch {
        // Markdown parse failed, send plain
        await this.bot?.sendMessage(chatId, message);
      }
      return;
    }

    const chunks = splitMessage(message, MAX_MESSAGE_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = i === 0 ? '' : `(${i + 1}/${chunks.length}) `;
      try {
        await this.bot?.sendMessage(chatId, prefix + chunks[i], { parse_mode: 'Markdown' });
      } catch {
        await this.bot?.sendMessage(chatId, prefix + chunks[i]);
      }
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
  }

  // ─── Token management ─────────────────────────────────────────────────

  private async refreshAuthToken(mapping: TelegramUserMapping): Promise<string | null> {
    if (!GATEWAY_SECRET) {
      logger.warn(`⚠️ [${INSTANCE_ID}] Cannot refresh token: GATEWAY_SECRET not configured`);
      return null;
    }

    try {
      logger.info(`🔄 [${INSTANCE_ID}] Refreshing auth token for user ${mapping.userId}`);

      const response = await fetch(`${TODO_APP_BASE_URL}/api/telegram-gateway/refresh-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Secret': GATEWAY_SECRET,
        },
        body: JSON.stringify({ userId: mapping.userId }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`❌ [${INSTANCE_ID}] Token refresh failed: ${response.status} - ${errorText}`);
        captureAuthFailure(new Error(`Token refresh failed: ${response.status}`), {
          userId: mapping.userId,
          endpoint: `${TODO_APP_BASE_URL}/api/telegram-gateway/refresh-token`,
          statusCode: response.status,
        });
        return null;
      }

      const data = await response.json() as { token: string; expiresAt: string };

      // Re-encrypt and persist the new token
      const secret = process.env.AUTH_SECRET;
      if (secret) {
        mapping.encryptedAuthToken = encryptToken(data.token, secret);
        await this.saveMappings();
      }

      logger.info(`✅ [${INSTANCE_ID}] Token refreshed for user ${mapping.userId}, expires at ${data.expiresAt}`);
      return data.token;
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error refreshing token:`, error);
      captureException(error, {
        userId: mapping.userId,
        operation: 'refreshAuthToken',
      });
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

  // ─── HTTP API Server ──────────────────────────────────────────────────

  private startHttpServer(): void {
    this.httpServer = createServer(async (req, res) => {
      // CORS — restrict to known origins; JWT auth provides primary protection
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
      logger.info(`🌐 [${INSTANCE_ID}] Telegram Gateway HTTP server running at http://localhost:${GATEWAY_PORT}`);
      logger.info(`   POST   /pair     — Generate pairing code`);
      logger.info(`   DELETE /pair     — Unpair account`);
      logger.info(`   GET    /status   — Check pairing status`);
      logger.info(`   PUT    /settings — Update agent settings`);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${GATEWAY_PORT}`);
    const pathname = url.pathname;

    // Dev-only test page (no auth required)
    if (req.method === 'GET' && pathname === '/' && process.env.NODE_ENV !== 'production') {
      this.serveTestPage(res);
      return;
    }

    // Extract auth token
    const authHeader = req.headers.authorization;
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!authToken) {
      sendJsonResponse(res, 401, { error: 'Authorization header required' });
      return;
    }

    // Verify JWT and extract userId
    let userId: string;
    try {
      userId = verifyAndExtractUserId(authToken);
    } catch (error) {
      handleGatewayError(error, res);
      return;
    }

    // Route
    if (req.method === 'POST' && pathname === '/pair') {
      await this.handlePairRequest(userId, authToken, req, res);
    } else if (req.method === 'DELETE' && pathname === '/pair') {
      await this.handleUnpairRequest(userId, res);
    } else if (req.method === 'GET' && pathname === '/status') {
      this.handleStatusRequest(userId, res);
    } else if (req.method === 'PUT' && pathname === '/settings') {
      await this.handleSettingsRequest(userId, req, res);
    } else {
      sendJsonResponse(res, 404, { error: 'Not found' });
    }
  }

  /**
   * Dev-only test page that simulates the Exponential app's "Connect Telegram" flow.
   * Uses EXPONENTIAL_TEST_JWT from env so you can test without the Exponential app running.
   */
  private serveTestPage(res: ServerResponse): void {
    const testJwt = process.env.EXPONENTIAL_TEST_JWT || '';
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Telegram Integration — Test Page</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif; background: #0f0f0f; color: #e0e0e0; display: flex; justify-content: center; padding: 40px 20px; min-height: 100vh; }
    .card { background: #1a1a1a; border: 1px solid #2a2a2a; border-radius: 16px; padding: 32px; max-width: 480px; width: 100%; }
    h1 { font-size: 20px; margin-bottom: 4px; }
    .subtitle { color: #888; font-size: 14px; margin-bottom: 24px; }
    .status-row { display: flex; align-items: center; gap: 8px; padding: 16px; background: #111; border-radius: 10px; margin-bottom: 20px; }
    .dot { width: 10px; height: 10px; border-radius: 50%; }
    .dot.green { background: #22c55e; }
    .dot.gray { background: #555; }
    .dot.orange { background: #f59e0b; }
    .status-text { font-size: 14px; }
    .status-detail { color: #888; font-size: 12px; }
    button { width: 100%; padding: 12px; border-radius: 10px; border: none; font-size: 15px; font-weight: 600; cursor: pointer; transition: opacity 0.15s; }
    button:hover { opacity: 0.85; }
    button:disabled { opacity: 0.4; cursor: not-allowed; }
    .btn-primary { background: #2563eb; color: white; }
    .btn-danger { background: #dc2626; color: white; margin-top: 8px; }
    .link-box { margin-top: 20px; padding: 16px; background: #111; border-radius: 10px; text-align: center; }
    .link-box a { display: inline-block; padding: 12px 24px; background: #2563eb; color: white; text-decoration: none; border-radius: 8px; font-weight: 600; font-size: 15px; }
    .link-box a:hover { opacity: 0.85; }
    .code { font-family: monospace; font-size: 24px; letter-spacing: 4px; color: #60a5fa; margin: 8px 0; }
    .expires { color: #888; font-size: 12px; }
    .agent-select { margin-bottom: 20px; }
    .agent-select label { display: block; font-size: 13px; color: #888; margin-bottom: 6px; }
    .agent-select select { width: 100%; padding: 10px; background: #111; color: #e0e0e0; border: 1px solid #333; border-radius: 8px; font-size: 14px; }
    .error { color: #f87171; font-size: 13px; margin-top: 8px; }
    .step { color: #888; font-size: 13px; margin-top: 12px; line-height: 1.6; }
    .dev-note { margin-top: 24px; padding: 12px; background: #1c1917; border: 1px solid #44403c; border-radius: 8px; font-size: 12px; color: #a8a29e; }
  </style>
</head>
<body>
  <div class="card">
    <h1>Connect Telegram</h1>
    <p class="subtitle">Chat with your assistant from Telegram</p>

    <div class="status-row">
      <div class="dot" id="statusDot"></div>
      <div>
        <div class="status-text" id="statusText">Checking...</div>
        <div class="status-detail" id="statusDetail"></div>
      </div>
    </div>

    <div id="connectSection" style="display:none;">
      <div class="agent-select">
        <label>Default agent</label>
        <select id="agentSelect">
          <option value="assistant" selected>Assistant (customizable)</option>
          <option value="zoe">Zoe (companion)</option>
          <option value="paddy">Paddy (project manager)</option>
          <option value="pierre">Pierre (crypto trading)</option>
          <option value="ash">Ash (lean startup)</option>
          <option value="weather">Weather Agent</option>
        </select>
      </div>
      <button class="btn-primary" id="connectBtn" onclick="startPairing()">Connect Telegram</button>
    </div>

    <div id="pairingSection" style="display:none;">
      <div class="link-box">
        <div style="margin-bottom:12px; font-size:14px;">Tap to open in Telegram:</div>
        <a id="telegramLink" href="#" target="_blank">Open @Bot in Telegram</a>
        <div class="code" id="pairingCode"></div>
        <div class="expires" id="expiresText"></div>
      </div>
      <div class="step">
        The link will open Telegram and automatically send the pairing code to the bot.
        Once paired, you can start chatting!
      </div>
    </div>

    <div id="connectedSection" style="display:none;">
      <div class="agent-select">
        <label>Default agent</label>
        <select id="agentSelectConnected" onchange="updateSettings()">
          <option value="assistant">Assistant (customizable)</option>
          <option value="zoe">Zoe (companion)</option>
          <option value="paddy">Paddy (project manager)</option>
          <option value="pierre">Pierre (crypto trading)</option>
          <option value="ash">Ash (lean startup)</option>
          <option value="weather">Weather Agent</option>
        </select>
      </div>
      <button class="btn-danger" onclick="disconnect()">Disconnect Telegram</button>
    </div>

    <div class="error" id="errorText"></div>

    <div class="dev-note">
      <strong>Dev test page</strong> — uses EXPONENTIAL_TEST_JWT from .env.
      This page simulates what the Exponential app's Settings &gt; Integrations &gt; Telegram page would do.
    </div>
  </div>

  <script>
    const API = '';
    const JWT = '${testJwt}';
    let pollInterval = null;

    const headers = { 'Authorization': 'Bearer ' + JWT, 'Content-Type': 'application/json' };

    async function checkStatus() {
      try {
        const res = await fetch(API + '/status', { headers });
        if (!res.ok) { showError('Auth failed — check EXPONENTIAL_TEST_JWT'); return; }
        const data = await res.json();

        if (data.paired) {
          showConnected(data);
        } else {
          showDisconnected();
        }
      } catch (e) { showError('Cannot reach gateway: ' + e.message); }
    }

    function showDisconnected() {
      document.getElementById('statusDot').className = 'dot gray';
      document.getElementById('statusText').textContent = 'Not connected';
      document.getElementById('statusDetail').textContent = '';
      document.getElementById('connectSection').style.display = '';
      document.getElementById('pairingSection').style.display = 'none';
      document.getElementById('connectedSection').style.display = 'none';
      clearError();
    }

    function showConnected(data) {
      document.getElementById('statusDot').className = 'dot green';
      document.getElementById('statusText').textContent = 'Connected' + (data.telegramUsername ? ' as @' + data.telegramUsername : '');
      document.getElementById('statusDetail').textContent = data.lastActive ? 'Last active: ' + new Date(data.lastActive).toLocaleString() : '';
      document.getElementById('connectSection').style.display = 'none';
      document.getElementById('pairingSection').style.display = 'none';
      document.getElementById('connectedSection').style.display = '';
      if (data.agentId) document.getElementById('agentSelectConnected').value = data.agentId;
      if (pollInterval) { clearInterval(pollInterval); pollInterval = null; }
      clearError();
    }

    async function startPairing() {
      const btn = document.getElementById('connectBtn');
      btn.disabled = true;
      btn.textContent = 'Generating code...';
      clearError();

      try {
        const agentId = document.getElementById('agentSelect').value;
        const res = await fetch(API + '/pair', { method: 'POST', headers, body: JSON.stringify({ agentId }) });
        if (!res.ok) { const e = await res.json(); showError(e.error || 'Failed'); btn.disabled = false; btn.textContent = 'Connect Telegram'; return; }
        const data = await res.json();

        document.getElementById('pairingCode').textContent = data.pairingCode;
        const link = document.getElementById('telegramLink');
        link.href = 'https://t.me/' + data.botUsername + '?start=' + data.pairingCode;
        link.textContent = 'Open @' + data.botUsername + ' in Telegram';
        document.getElementById('expiresText').textContent = 'Code expires in ' + Math.round(data.expiresInSeconds / 60) + ' minutes';
        document.getElementById('connectSection').style.display = 'none';
        document.getElementById('pairingSection').style.display = '';

        // Poll for completion
        pollInterval = setInterval(async () => {
          try {
            const s = await fetch(API + '/status', { headers });
            const d = await s.json();
            if (d.paired) showConnected(d);
          } catch {}
        }, 2000);

      } catch (e) { showError(e.message); }
      btn.disabled = false;
      btn.textContent = 'Connect Telegram';
    }

    async function disconnect() {
      if (!confirm('Disconnect your Telegram account?')) return;
      try {
        await fetch(API + '/pair', { method: 'DELETE', headers });
        showDisconnected();
      } catch (e) { showError(e.message); }
    }

    async function updateSettings() {
      const agentId = document.getElementById('agentSelectConnected').value;
      try {
        await fetch(API + '/settings', { method: 'PUT', headers, body: JSON.stringify({ agentId }) });
      } catch {}
    }

    function showError(msg) { document.getElementById('errorText').textContent = msg; }
    function clearError() { document.getElementById('errorText').textContent = ''; }

    checkStatus();
  </script>
</body>
</html>`;

    res.writeHead(200, { 'Content-Type': 'text/html' });
    res.end(html);
  }

  private async handlePairRequest(
    userId: string,
    authToken: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    try {
      const body = await readBody(req);
      const { agentId, assistantId, assistantName, workspaceId } = body ? JSON.parse(body) : {};

      const code = this.generatePairingCode(
        userId,
        authToken,
        agentId || 'assistant',
        assistantId,
        assistantName,
        workspaceId,
      );

      const botUsername = await this.getBotUsername();

      sendJsonResponse(res, 200, {
        pairingCode: code,
        botUsername,
        expiresInSeconds: PAIRING_CODE_TTL_MS / 1000,
      });
    } catch (error: any) {
      sendJsonResponse(res, 400, { error: error.message || 'Invalid request' });
    }
  }

  private async handleUnpairRequest(userId: string, res: ServerResponse): Promise<void> {
    const chatId = this.userIdToChatId.get(userId);
    if (chatId === undefined) {
      sendJsonResponse(res, 404, { error: 'No Telegram account linked' });
      return;
    }

    this.mappings.delete(chatId);
    this.userIdToChatId.delete(userId);
    this.conversations.delete(chatId);
    await this.saveMappings();

    // Notify user via Telegram
    await this.bot?.sendMessage(chatId, "Your Exponential account has been disconnected. You can reconnect anytime.");

    sendJsonResponse(res, 200, { success: true });
    logger.info(`👋 [${INSTANCE_ID}] User ${userId} unpaired via API`);
  }

  private handleStatusRequest(userId: string, res: ServerResponse): void {
    const chatId = this.userIdToChatId.get(userId);
    if (chatId === undefined) {
      sendJsonResponse(res, 200, { paired: false });
      return;
    }

    const mapping = this.mappings.get(chatId);
    sendJsonResponse(res, 200, {
      paired: true,
      telegramUsername: mapping?.telegramUsername || null,
      agentId: mapping?.agentId || null,
      lastActive: mapping?.lastActive || null,
    });
  }

  private async handleSettingsRequest(
    userId: string,
    req: IncomingMessage,
    res: ServerResponse,
  ): Promise<void> {
    const chatId = this.userIdToChatId.get(userId);
    if (chatId === undefined) {
      sendJsonResponse(res, 404, { error: 'No Telegram account linked' });
      return;
    }

    const mapping = this.mappings.get(chatId);
    if (!mapping) {
      sendJsonResponse(res, 404, { error: 'No Telegram account linked' });
      return;
    }

    try {
      const body = await readBody(req);
      const { agentId, assistantId } = body ? JSON.parse(body) : {};

      if (agentId) mapping.agentId = agentId;
      if (assistantId !== undefined) mapping.assistantId = assistantId || undefined;

      await this.saveMappings();
      sendJsonResponse(res, 200, { success: true, agentId: mapping.agentId, assistantId: mapping.assistantId });
    } catch (error: any) {
      sendJsonResponse(res, 400, { error: error.message || 'Invalid request' });
    }
  }

  private async getBotUsername(): Promise<string | null> {
    try {
      const me = await this.bot?.getMe();
      return me?.username || null;
    } catch {
      return null;
    }
  }

  // ─── Shutdown ─────────────────────────────────────────────────────────

  async shutdown(): Promise<void> {
    logger.info(`🛑 [${INSTANCE_ID}] Shutting down Telegram Gateway...`);

    if (this.pairingCleanupInterval) {
      clearInterval(this.pairingCleanupInterval);
    }

    if (this.bot) {
      try {
        await this.bot.stopPolling();
      } catch (error) {
        logger.error(`❌ [${INSTANCE_ID}] Error stopping bot polling:`, error);
      }
    }

    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
    }

    logger.info(`✅ [${INSTANCE_ID}] Telegram Gateway shutdown complete`);
  }
}

// ─── Global instance management ─────────────────────────────────────────────

let globalGateway: TelegramGateway | null = null;

export function createTelegramGateway(): TelegramGateway | null {
  if (globalGateway) {
    logger.info(`♻️ [${INSTANCE_ID}] Telegram Gateway already exists, reusing instance`);
    return globalGateway;
  }

  try {
    globalGateway = new TelegramGateway();
    globalGateway.initialize().catch(err => {
      logger.error(`❌ [${INSTANCE_ID}] Failed to initialize Telegram Gateway:`, err);
      globalGateway = null;
    });
    return globalGateway;
  } catch (error) {
    logger.error(`❌ [${INSTANCE_ID}] Failed to create Telegram Gateway:`, error);
    return null;
  }
}

export async function cleanupTelegramGateway(): Promise<void> {
  if (globalGateway) {
    await globalGateway.shutdown();
    globalGateway = null;
  }
}

export function getTelegramGateway(): TelegramGateway | null {
  return globalGateway;
}
