import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import crypto, { randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

import jwt from 'jsonwebtoken';
import makeWASocket, {
  useMultiFileAuthState,
  makeCacheableSignalKeyStore,
  fetchLatestBaileysVersion,
  DisconnectReason,
  WASocket,
  BaileysEventMap,
  proto,
} from '@whiskeysockets/baileys';
import QRCode from 'qrcode';
import { createLogger } from '@mastra/core/logger';
import { Boom } from '@hapi/boom';

import { RequestContext } from '@mastra/core/di';
import {
  weatherAgent,
  pierreAgent,
  ashAgent,
  projectManagerAgent,
  zoeAgent,
} from '../agents/index.js';
import { captureException, captureAuthFailure } from '../utils/sentry.js';

const logger = createLogger({
  name: 'WhatsAppGateway',
  level: 'info',
});

// Generate unique instance ID for logging
const INSTANCE_ID = `wa-gateway-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Configuration
const GATEWAY_PORT = parseInt(process.env.WHATSAPP_GATEWAY_PORT || '4112', 10);
// Use WHATSAPP_SESSIONS_DIR env var for Railway volume mount, or default to home directory for local dev
const SESSIONS_DIR = process.env.WHATSAPP_SESSIONS_DIR || path.join(os.homedir(), '.mastra', 'whatsapp-sessions');
const SESSIONS_FILE = path.join(SESSIONS_DIR, 'sessions.json');
const MAX_SESSIONS = parseInt(process.env.WHATSAPP_MAX_SESSIONS || '10', 10);
const MAX_MESSAGE_LENGTH = 4096;
const CONVERSATION_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const PRIVATE_RESPONSE_MODE = process.env.WHATSAPP_PRIVATE_RESPONSES === 'true'; // Reply in self-chat only

// Token refresh configuration
const TODO_APP_BASE_URL = process.env.TODO_APP_BASE_URL || 'http://localhost:3000';
const WHATSAPP_GATEWAY_SECRET = process.env.WHATSAPP_GATEWAY_SECRET;

// Invisible bot signature to detect messages sent by any instance of this gateway
// Uses zero-width characters that are invisible to users but detectable by code
const BOT_SIGNATURE = '\u200B\u200C\u200B'; // Zero-width space + zero-width non-joiner + zero-width space

// JWT Types
interface JWTPayload {
  userId: string;
  sub: string;
  email?: string | null;
  name?: string | null;
  tokenType: string;
  aud: string;
  iss: string;
}

// Error codes for stable error identification
type GatewayErrorCode =
  | 'AUTH_SECRET_NOT_CONFIGURED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'TOKEN_MISSING_USERID'
  | 'MAX_SESSIONS_REACHED';

// Custom error class with stable code property
class GatewayError extends Error {
  code: GatewayErrorCode;

  constructor(code: GatewayErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'GatewayError';
  }
}

// JWT Verification
function verifyAndExtractUserId(token: string): string {
  const secret = process.env.AUTH_SECRET;
  if (!secret) {
    throw new GatewayError('AUTH_SECRET_NOT_CONFIGURED', 'AUTH_SECRET not configured');
  }

  try {
    const payload = jwt.verify(token, secret, {
      audience: 'mastra-agents',
      issuer: 'todo-app',
    }) as JWTPayload;

    const userId = payload.userId || payload.sub;
    if (!userId) {
      throw new GatewayError('TOKEN_MISSING_USERID', 'Token missing userId');
    }
    return userId;
  } catch (error: any) {
    if (error instanceof GatewayError) {
      throw error;
    }
    if (error.name === 'TokenExpiredError') {
      throw new GatewayError('TOKEN_EXPIRED', 'Token expired');
    } else if (error.name === 'JsonWebTokenError') {
      throw new GatewayError('TOKEN_INVALID', 'Invalid token');
    }
    throw error;
  }
}

// Token encryption for secure storage at rest
// Format: salt:iv:authTag:ciphertext (all hex encoded)
const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

function encryptToken(token: string, secret: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(secret, salt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

function decryptToken(encrypted: string, secret: string): string | null {
  try {
    const parts = encrypted.split(':');
    if (parts.length !== 4) return null;

    const [saltHex, ivHex, authTagHex, data] = parts;
    const salt = Buffer.from(saltHex, 'hex');
    const key = crypto.scryptSync(secret, salt, 32);
    const iv = Buffer.from(ivHex, 'hex');
    const authTag = Buffer.from(authTagHex, 'hex');

    const decipher = crypto.createDecipheriv(ENCRYPTION_ALGORITHM, key, iv);
    decipher.setAuthTag(authTag);

    let decrypted = decipher.update(data, 'hex', 'utf8');
    decrypted += decipher.final('utf8');
    return decrypted;
  } catch (error) {
    logger.warn(`⚠️ Failed to decrypt token: ${error}`);
    return null;
  }
}

// Types
interface SessionMetadata {
  userId: string;
  phoneNumber: string | null;
  createdAt: string;
  lastConnected: string | null;
  encryptedAuthToken?: string; // Encrypted JWT for persistence across restarts
}

interface SessionsFile {
  [sessionId: string]: SessionMetadata;
}

// Cached message structure for context retrieval
interface CachedMessage {
  timestamp: Date;
  fromMe: boolean;
  text: string;
  messageId: string;
}

interface WhatsAppSession {
  id: string;
  userId: string;
  sock: WASocket | null;
  currentQr: string | null;
  isConnected: boolean;
  phoneNumber: string | null;
  createdAt: Date;
  credentialsPath: string;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
  lastAuthToken?: string; // Store latest valid token for agent calls
  conversations: Map<string, ConversationState>; // Track active conversations per chat
  sentMessageIds: Set<string>; // Track messages sent by the bot to avoid feedback loops
  messageCache: Map<string, CachedMessage[]>; // Cache messages per contact JID for context
}

interface ConnectionStatus {
  connected: boolean;
  phoneNumber: string | null;
  qrAvailable: boolean;
}

// Utility functions
function jidToE164(jid: string): string | null {
  const match = jid.match(/^(\d+)(?::\d+)?@s\.whatsapp\.net$/);
  if (match) return `+${match[1]}`;
  return null;
}

function extractText(message: proto.IMessage | undefined | null): string | undefined {
  if (!message) return undefined;

  const text = message.conversation
    ?? message.extendedTextMessage?.text
    ?? message.imageMessage?.caption
    ?? message.videoMessage?.caption;

  return text?.trim();
}

async function ensureDir(dir: string): Promise<void> {
  await fs.mkdir(dir, { recursive: true });
}

// Agent routing types and functions
type AgentIdentifier = 'weather' | 'pierre' | 'ash' | 'paddy' | 'zoe';

const DEFAULT_AGENT: AgentIdentifier = 'zoe';

interface ParsedMessage {
  text: string;
  agent: AgentIdentifier | null;
}

// Message history entry for conversation context
interface HistoryMessage {
  role: 'user' | 'assistant';
  content: string;
}

// Maximum number of history messages to keep (to prevent context overflow)
const MAX_HISTORY_MESSAGES = 10;

interface ConversationState {
  agentId: AgentIdentifier;
  lastInteraction: number;  // timestamp
  lastAgentMessageId?: string;  // for reply detection
  history: HistoryMessage[];  // conversation history for agent context
}

const AGENT_ALIASES: Record<string, AgentIdentifier> = {
  'weather': 'weather',
  'pierre': 'pierre',
  'ash': 'ash',
  'paddy': 'paddy',
  'zoe': 'zoe',
};

function parseMessageForMention(text: string): ParsedMessage {
  const match = text.match(/^@(\w+)\s*/i);
  if (!match) {
    return { text, agent: null };
  }

  const mention = match[1].toLowerCase();
  const agent = AGENT_ALIASES[mention] || null;
  const cleanText = text.substring(match[0].length).trim();

  return { text: cleanText || text, agent };
}

function getAgentByIdentifier(identifier: AgentIdentifier) {
  const agents = {
    'weather': weatherAgent,
    'pierre': pierreAgent,
    'ash': ashAgent,
    'paddy': projectManagerAgent,
    'zoe': zoeAgent,
  };
  return agents[identifier];
}

// Conversation management helpers
function isSelfChat(session: WhatsAppSession, jid: string): boolean {
  const sessionPhone = session.phoneNumber?.replace(/\D/g, '');
  const chatPhone = jid.replace(/@.*/, '').replace(/\D/g, '');
  return !!sessionPhone && sessionPhone === chatPhone;
}

function extractQuotedText(msg: proto.IWebMessageInfo): string | null {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  if (!contextInfo?.quotedMessage) return null;

  return contextInfo.quotedMessage.conversation ||
         contextInfo.quotedMessage.extendedTextMessage?.text ||
         null;
}

function isReplyToAgent(
  msg: proto.IWebMessageInfo,
  session: WhatsAppSession,
  jid: string
): boolean {
  const contextInfo = msg.message?.extendedTextMessage?.contextInfo;
  if (!contextInfo?.stanzaId) return false;

  const conversation = session.conversations.get(jid);
  return conversation?.lastAgentMessageId === contextInfo.stanzaId;
}

function getActiveConversation(
  session: WhatsAppSession,
  jid: string
): ConversationState | null {
  const conversation = session.conversations.get(jid);
  if (!conversation) return null;

  const elapsed = Date.now() - conversation.lastInteraction;
  if (elapsed > CONVERSATION_TIMEOUT_MS) {
    return null; // Expired
  }
  return conversation;
}

// Main Gateway Class
export class WhatsAppGateway {
  private sessions: Map<string, WhatsAppSession> = new Map();
  private httpServer: Server | null = null;
  private sessionsMetadata: SessionsFile = {};

  constructor() {
    logger.info(`🚀 [${INSTANCE_ID}] WhatsApp Gateway initializing...`);
  }

  async initialize(): Promise<void> {
    // Ensure directories exist
    await ensureDir(SESSIONS_DIR);

    // Load existing sessions metadata
    await this.loadSessionsMetadata();

    // Reconnect existing sessions
    await this.reconnectExistingSessions();

    // Start HTTP server
    this.startHttpServer();

    logger.info(`✅ [${INSTANCE_ID}] WhatsApp Gateway initialized with ${this.sessions.size} sessions`);
  }

  private async loadSessionsMetadata(): Promise<void> {
    try {
      const data = await fs.readFile(SESSIONS_FILE, 'utf-8');
      this.sessionsMetadata = JSON.parse(data);
      logger.info(`📂 [${INSTANCE_ID}] Loaded ${Object.keys(this.sessionsMetadata).length} session(s) from metadata`);
    } catch (error: any) {
      if (error.code !== 'ENOENT') {
        logger.error(`❌ [${INSTANCE_ID}] Error loading sessions metadata:`, error);
      }
      this.sessionsMetadata = {};
    }
  }

  private async saveSessionsMetadata(): Promise<void> {
    try {
      const secret = process.env.AUTH_SECRET;

      // Before saving, encrypt any auth tokens from active sessions
      if (secret) {
        for (const [sessionId, session] of this.sessions) {
          if (session.lastAuthToken && this.sessionsMetadata[sessionId]) {
            this.sessionsMetadata[sessionId].encryptedAuthToken = encryptToken(
              session.lastAuthToken,
              secret
            );
          }
        }
      }

      await fs.writeFile(SESSIONS_FILE, JSON.stringify(this.sessionsMetadata, null, 2));
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error saving sessions metadata:`, error);
    }
  }

  private async reconnectExistingSessions(): Promise<void> {
    const secret = process.env.AUTH_SECRET;

    for (const [sessionId, metadata] of Object.entries(this.sessionsMetadata)) {
      try {
        const credentialsPath = path.join(SESSIONS_DIR, sessionId);

        // Check if credentials exist
        try {
          await fs.access(path.join(credentialsPath, 'creds.json'));
        } catch {
          logger.info(`⚠️ [${INSTANCE_ID}] Session ${sessionId} has no credentials, skipping`);
          continue;
        }

        // Attempt to restore encrypted auth token
        let restoredAuthToken: string | undefined;
        if (metadata.encryptedAuthToken && secret) {
          restoredAuthToken = decryptToken(metadata.encryptedAuthToken, secret) ?? undefined;
          if (restoredAuthToken) {
            logger.info(`🔑 [${INSTANCE_ID}] Restored auth token for session ${sessionId}`);
          } else {
            logger.warn(`⚠️ [${INSTANCE_ID}] Failed to decrypt auth token for session ${sessionId}, will need refresh`);
          }
        }

        const session: WhatsAppSession = {
          id: sessionId,
          userId: metadata.userId,
          sock: null,
          currentQr: null,
          isConnected: false,
          phoneNumber: metadata.phoneNumber,
          createdAt: new Date(metadata.createdAt),
          credentialsPath,
          reconnectAttempts: 0,
          maxReconnectAttempts: 5,
          lastAuthToken: restoredAuthToken,
          conversations: new Map(),
          sentMessageIds: new Set(),
          messageCache: new Map(),
        };

        this.sessions.set(sessionId, session);
        await this.createSocketForSession(session);

        logger.info(`🔄 [${INSTANCE_ID}] Reconnecting session ${sessionId}`);
      } catch (error) {
        logger.error(`❌ [${INSTANCE_ID}] Error reconnecting session ${sessionId}:`, error);
      }
    }
  }

  // Session lifecycle methods
  async createSession(authToken: string): Promise<string> {
    // Verify JWT and extract userId
    const userId = verifyAndExtractUserId(authToken);

    if (this.sessions.size >= MAX_SESSIONS) {
      throw new GatewayError('MAX_SESSIONS_REACHED', `Maximum sessions (${MAX_SESSIONS}) reached`);
    }

    // Check if user already has a session
    for (const [existingId, session] of this.sessions) {
      if (session.userId === userId) {
        // Update the stored auth token for future agent calls
        session.lastAuthToken = authToken;
        logger.info(`♻️ [${INSTANCE_ID}] User ${userId} already has session ${existingId}`);
        return existingId;
      }
    }

    const sessionId = randomUUID().slice(0, 8);
    const credentialsPath = path.join(SESSIONS_DIR, sessionId);

    await ensureDir(credentialsPath);

    const session: WhatsAppSession = {
      id: sessionId,
      userId,
      sock: null,
      currentQr: null,
      isConnected: false,
      phoneNumber: null,
      createdAt: new Date(),
      credentialsPath,
      reconnectAttempts: 0,
      maxReconnectAttempts: 5,
      lastAuthToken: authToken,
      conversations: new Map(),
      sentMessageIds: new Set(),
      messageCache: new Map(),
    };

    this.sessions.set(sessionId, session);

    // Save metadata
    this.sessionsMetadata[sessionId] = {
      userId,
      phoneNumber: null,
      createdAt: session.createdAt.toISOString(),
      lastConnected: null,
    };
    await this.saveSessionsMetadata();

    // Create socket (will generate QR)
    await this.createSocketForSession(session);

    logger.info(`✨ [${INSTANCE_ID}] Created new session ${sessionId}`);
    return sessionId;
  }

  getSession(sessionId: string, authToken: string): WhatsAppSession | null {
    const session = this.sessions.get(sessionId);
    if (!session) return null;

    // Verify JWT and extract userId
    const userId = verifyAndExtractUserId(authToken);
    if (session.userId !== userId) {
      return null; // Not authorized to access this session
    }

    // Update the stored auth token for future agent calls
    session.lastAuthToken = authToken;

    return session;
  }

  async destroySession(sessionId: string, authToken: string): Promise<boolean> {
    const session = this.getSession(sessionId, authToken);
    if (!session) return false;

    // Close socket
    if (session.sock) {
      try {
        session.sock.ws?.close();
      } catch (error) {
        logger.error(`❌ [${INSTANCE_ID}] Error closing socket for session ${sessionId}:`, error);
      }
    }

    // Remove credentials
    try {
      await fs.rm(session.credentialsPath, { recursive: true, force: true });
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error removing credentials for session ${sessionId}:`, error);
    }

    // Remove from maps
    this.sessions.delete(sessionId);
    delete this.sessionsMetadata[sessionId];
    await this.saveSessionsMetadata();

    logger.info(`🗑️ [${INSTANCE_ID}] Destroyed session ${sessionId}`);
    return true;
  }

  // Baileys socket management
  private async createSocketForSession(session: WhatsAppSession): Promise<void> {
    try {
      const { state, saveCreds } = await useMultiFileAuthState(session.credentialsPath);
      const { version } = await fetchLatestBaileysVersion();

      // Create a silent logger for Baileys to reduce noise
      const baileysLogger = {
        level: 'silent' as const,
        trace: () => {},
        debug: () => {},
        info: () => {},
        warn: () => {},
        error: (msg: string) => logger.error(`[Baileys ${session.id}] ${msg}`),
        fatal: (msg: string) => logger.error(`[Baileys ${session.id}] FATAL: ${msg}`),
        child: () => baileysLogger,
      };

      session.sock = makeWASocket({
        auth: {
          creds: state.creds,
          keys: makeCacheableSignalKeyStore(state.keys, baileysLogger as any),
        },
        version,
        logger: baileysLogger as any,
        printQRInTerminal: false,
        browser: ['Mastra', 'Chrome', '1.0.0'],
        syncFullHistory: false,
        markOnlineOnConnect: false,
      });

      // Handle credential updates
      session.sock.ev.on('creds.update', saveCreds);

      // Handle connection updates
      session.sock.ev.on('connection.update', (update) => {
        this.handleConnectionUpdate(session, update);
      });

      // Handle incoming messages
      session.sock.ev.on('messages.upsert', (upsert) => {
        this.handleMessagesUpsert(session, upsert);
      });

    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error creating socket for session ${session.id}:`, error);
      throw error;
    }
  }

  private handleConnectionUpdate(
    session: WhatsAppSession,
    update: BaileysEventMap['connection.update']
  ): void {
    const { connection, lastDisconnect, qr } = update;

    if (qr) {
      session.currentQr = qr;
      session.isConnected = false;
      logger.info(`📱 [${INSTANCE_ID}] QR code available for session ${session.id}`);
    }

    if (connection === 'open') {
      session.isConnected = true;
      session.currentQr = null;
      session.reconnectAttempts = 0;

      // Get phone number from credentials
      const phoneNumber = session.sock?.user?.id;
      if (phoneNumber) {
        session.phoneNumber = jidToE164(phoneNumber);

        // Update metadata
        this.sessionsMetadata[session.id] = {
          ...this.sessionsMetadata[session.id],
          phoneNumber: session.phoneNumber,
          lastConnected: new Date().toISOString(),
        };
        this.saveSessionsMetadata();
      }

      logger.info(`✅ [${INSTANCE_ID}] Session ${session.id} connected as ${session.phoneNumber}`);
    }

    if (connection === 'close') {
      session.isConnected = false;
      const statusCode = (lastDisconnect?.error as Boom)?.output?.statusCode;

      logger.info(`🔌 [${INSTANCE_ID}] Session ${session.id} disconnected (code: ${statusCode})`);

      if (statusCode === DisconnectReason.loggedOut) {
        logger.warn(`⚠️ [${INSTANCE_ID}] Session ${session.id} logged out, needs re-authentication`);
        // Clear QR so user can re-login
        session.currentQr = null;
      } else if (session.reconnectAttempts < session.maxReconnectAttempts) {
        // Attempt reconnection with backoff
        session.reconnectAttempts++;
        const delay = Math.min(1000 * Math.pow(2, session.reconnectAttempts), 30000);

        logger.info(`🔄 [${INSTANCE_ID}] Reconnecting session ${session.id} in ${delay}ms (attempt ${session.reconnectAttempts})`);

        setTimeout(() => {
          this.createSocketForSession(session).catch(err => {
            logger.error(`❌ [${INSTANCE_ID}] Reconnection failed for session ${session.id}:`, err);
          });
        }, delay);
      }
    }
  }

  private async handleMessagesUpsert(
    session: WhatsAppSession,
    upsert: BaileysEventMap['messages.upsert']
  ): Promise<void> {
    if (upsert.type !== 'notify') return;

    for (const msg of upsert.messages ?? []) {
      try {
        // Skip if no remote JID
        const remoteJid = msg.key.remoteJid;
        if (!remoteJid) continue;

        // Skip status/broadcast
        if (remoteJid.endsWith('@status') || remoteJid.endsWith('@broadcast')) continue;

        // Skip group messages for now
        if (remoteJid.endsWith('@g.us')) continue;

        // Cache ALL messages from individual chats for context retrieval
        // This happens before other filtering so we capture both incoming and outgoing messages
        const textForCache = extractText(msg.message);
        if (textForCache && msg.key.id) {
          this.cacheMessage(session, remoteJid, {
            timestamp: new Date(msg.messageTimestamp ? Number(msg.messageTimestamp) * 1000 : Date.now()),
            fromMe: msg.key.fromMe ?? false,
            text: textForCache,
            messageId: msg.key.id,
          });
        }

        // We want to process messages FROM the session owner (fromMe = true)
        // This allows the user to send commands from any chat
        if (!msg.key.fromMe) continue;

        // Skip messages that the bot itself sent (avoid feedback loops)
        if (msg.key.id && session.sentMessageIds.has(msg.key.id)) {
          continue;
        }

        // Extract text
        const text = extractText(msg.message);
        if (!text) continue;

        // Skip messages with bot signature (handles cross-instance deduplication)
        // This catches messages sent by other instances (local/deployed) of this gateway
        if (text.includes(BOT_SIGNATURE)) {
          logger.debug(`🤖 [${INSTANCE_ID}] Skipping bot-signed message`);
          continue;
        }

        // Check for conversation termination command
        if (text.toLowerCase().trim() === 'bye') {
          const hadConversation = session.conversations.has(remoteJid);
          session.conversations.delete(remoteJid);

          if (hadConversation) {
            // React with thumbs up to acknowledge
            await session.sock?.sendMessage(remoteJid, {
              react: {
                text: '👍',
                key: msg.key
              }
            });
            logger.info(`👋 [${INSTANCE_ID}] Conversation ended in ${remoteJid}`);
          }
          continue;
        }

        // Extract quoted message if this is a reply
        const quotedText = extractQuotedText(msg);

        // Parse for @mention
        const parsed = parseMessageForMention(text);

        // Determine if we should process this message
        const selfChat = isSelfChat(session, remoteJid);
        const replyToAgent = isReplyToAgent(msg, session, remoteJid);
        const activeConversation = getActiveConversation(session, remoteJid);

        let agentId: AgentIdentifier | undefined;
        let shouldProcess = false;

        if (selfChat) {
          // Self-chat: always process, use mention or default to Paddy
          shouldProcess = true;
          agentId = parsed.agent || DEFAULT_AGENT;
        } else if (parsed.agent) {
          // Explicit @mention: always process
          shouldProcess = true;
          agentId = parsed.agent;
        } else if (replyToAgent && activeConversation) {
          // Reply to agent's message within active conversation
          shouldProcess = true;
          agentId = activeConversation.agentId;
        } else if (activeConversation) {
          // Within active conversation window (no mention needed)
          shouldProcess = true;
          agentId = activeConversation.agentId;
        }

        if (!shouldProcess || !agentId) {
          logger.debug(`📭 [${INSTANCE_ID}] Ignoring message: ${text.substring(0, 30)}...`);
          continue;
        }

        // Update or create conversation state (preserve history if continuing conversation)
        const existingConversation = session.conversations.get(remoteJid);
        session.conversations.set(remoteJid, {
          agentId,
          lastInteraction: Date.now(),
          lastAgentMessageId: existingConversation?.lastAgentMessageId,
          history: existingConversation?.history ?? [],  // Preserve history or start fresh
        });

        // Get the chat we're sending to (for logging)
        const chatE164 = jidToE164(remoteJid);
        const chatType = selfChat ? 'self-chat' : (chatE164 || remoteJid);

        logger.info(`📨 [${INSTANCE_ID}] Processing for @${agentId} in ${chatType}: ${parsed.text.substring(0, 50)}...`);

        // Build message content with quoted context
        let messageContent = parsed.text;
        if (quotedText) {
          messageContent = `[Replying to: "${quotedText}"]\n\n${parsed.text}`;
        }

        // Mark as read
        await session.sock?.readMessages([{ remoteJid, id: msg.key.id!, participant: undefined, fromMe: false }]);

        // Process with the agent
        await this.processMessage(session, remoteJid, messageContent, agentId);

      } catch (error) {
        logger.error(`❌ [${INSTANCE_ID}] Error processing message in session ${session.id}:`, error);
      }
    }
  }

  /**
   * Refresh the auth token for a session by calling the exponential API.
   * This is used when the current token has expired.
   */
  private async refreshAuthToken(session: WhatsAppSession): Promise<string | null> {
    if (!WHATSAPP_GATEWAY_SECRET) {
      logger.warn(`⚠️ [${INSTANCE_ID}] Cannot refresh token: WHATSAPP_GATEWAY_SECRET not configured`);
      return null;
    }

    try {
      logger.info(`🔄 [${INSTANCE_ID}] Attempting to refresh auth token for session ${session.id}`);

      const response = await fetch(`${TODO_APP_BASE_URL}/api/whatsapp-gateway/refresh-token`, {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'X-Gateway-Secret': WHATSAPP_GATEWAY_SECRET,
        },
        body: JSON.stringify({ sessionId: session.id }),
      });

      if (!response.ok) {
        const errorText = await response.text();
        logger.error(`❌ [${INSTANCE_ID}] Token refresh failed: ${response.status} - ${errorText}`);

        // Capture auth failure to Sentry
        captureAuthFailure(new Error(`Token refresh failed: ${response.status}`), {
          userId: session.userId,
          sessionId: session.id,
          endpoint: `${TODO_APP_BASE_URL}/api/whatsapp-gateway/refresh-token`,
          statusCode: response.status,
        });

        return null;
      }

      const data = await response.json() as { token: string; expiresAt: string };
      session.lastAuthToken = data.token;

      // Save the new encrypted token to metadata
      await this.saveSessionsMetadata();

      logger.info(`✅ [${INSTANCE_ID}] Token refreshed successfully for session ${session.id}, expires at ${data.expiresAt}`);
      return data.token;
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error refreshing token:`, error);

      captureException(error, {
        userId: session.userId,
        sessionId: session.id,
        operation: 'refreshAuthToken',
      });

      return null;
    }
  }

  /**
   * Check if an error indicates an unauthorized/expired token.
   */
  private isUnauthorizedError(error: unknown): boolean {
    if (error instanceof Error) {
      const message = error.message.toLowerCase();
      return message.includes('unauthorized') || message.includes('401');
    }
    return false;
  }

  private async processMessage(
    session: WhatsAppSession,
    jid: string,
    text: string,
    agentId: AgentIdentifier
  ): Promise<void> {
    try {
      // Determine where to send the response
      // In private mode, always respond in self-chat so only the user sees it
      const selfChatJid = session.sock?.user?.id;
      const isSelfChat = selfChatJid && jid === selfChatJid;
      const responseJid = (PRIVATE_RESPONSE_MODE && !isSelfChat && selfChatJid) ? selfChatJid : jid;

      // Send typing indicator
      await session.sock?.sendPresenceUpdate('composing', responseJid);

      // Check if we have a valid auth token, try to refresh if missing
      if (!session.lastAuthToken) {
        logger.warn(`⚠️ [${INSTANCE_ID}] Session ${session.id} has no auth token, attempting refresh...`);
        const newToken = await this.refreshAuthToken(session);
        if (!newToken) {
          await session.sock?.sendMessage(responseJid, {
            text: "Your session needs to be refreshed. Please open the app and reconnect your WhatsApp to continue using the assistant."
          });
          return;
        }
      }

      // Select agent based on mention
      const agent = getAgentByIdentifier(agentId);
      logger.info(`🤖 [${INSTANCE_ID}] Routing to @${agentId} for session ${session.id}`);

      // Try to call the agent, with automatic token refresh on auth failure
      let response;
      let authToken = session.lastAuthToken!;

      // Helper to create request context with auth token
      const createRequestContext = (token: string) => {
        return new RequestContext([
          ['authToken', token],
          ['whatsappSession', session.id],
          ['whatsappPhone', session.phoneNumber || ''],
          ['userId', session.userId],
        ]);
      };

      // WhatsApp-specific formatting context for the agent
      const whatsappSystemContext = `You are responding via WhatsApp. Format your responses for WhatsApp:
- Use *bold* for emphasis (renders correctly)
- Use numbered lists (1. 2. 3.) instead of markdown tables
- Keep responses concise - WhatsApp has a 4096 character limit per message
- NO markdown tables - they don't render properly
- NO headers with # - use *bold text* instead
- NO markdown links [text](url) - just write the text

Example format for lists:
1. *Item Name* (Status, Priority)
   Brief description here...

2. *Another Item* (Status, Priority)
   Another description...`;

      // Get conversation history for context
      const conversation = session.conversations.get(jid);
      const history = conversation?.history ?? [];

      // Add current user message to history
      history.push({ role: 'user', content: text });

      // Trim history if too long (keep most recent messages)
      while (history.length > MAX_HISTORY_MESSAGES) {
        history.shift();
      }

      // Build messages array with system context + conversation history
      const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = [
        { role: 'system', content: whatsappSystemContext },
        ...history
      ];

      logger.debug(`📝 [${INSTANCE_ID}] Sending ${history.length} history messages to agent`);

      try {
        // First attempt with current token
        response = await agent.generate(
          messages,
          { requestContext: createRequestContext(authToken) }
        );
      } catch (error) {
        // Check if this is an auth error
        if (this.isUnauthorizedError(error)) {
          logger.warn(`⚠️ [${INSTANCE_ID}] Auth error detected, attempting token refresh...`);
          const newToken = await this.refreshAuthToken(session);
          if (newToken) {
            authToken = newToken;
            // Retry with new token
            response = await agent.generate(
              messages,
              { requestContext: createRequestContext(authToken) }
            );
          } else {
            throw error; // Re-throw if refresh failed
          }
        } else {
          throw error;
        }
      }

      const agentResponse = response.text;

      if (agentResponse) {
        // Add assistant response to conversation history
        history.push({ role: 'assistant', content: agentResponse });

        // Trim history again if needed after adding response
        while (history.length > MAX_HISTORY_MESSAGES) {
          history.shift();
        }

        // In private mode, prefix with context about which chat the question was from
        let finalResponse = agentResponse;
        if (PRIVATE_RESPONSE_MODE && !isSelfChat) {
          const chatContext = jidToE164(jid) || jid.split('@')[0];
          finalResponse = `[Re: ${chatContext}]\n\n${agentResponse}`;
        }

        const sentMsg = await this.sendLongMessage(session, responseJid, finalResponse);

        // Update conversation with agent's message ID and updated history
        const conversationState = session.conversations.get(jid);
        if (conversationState) {
          conversationState.lastAgentMessageId = sentMsg?.key?.id;
          conversationState.history = history;
          conversationState.lastInteraction = Date.now();
        }

        logger.info(`✅ [${INSTANCE_ID}] Sent response to ${jidToE164(responseJid)} in session ${session.id} (history: ${history.length} msgs)`);
      } else {
        await session.sock?.sendMessage(responseJid, {
          text: "Sorry, I couldn't process your request. Please try again."
        });
      }

    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error processing message in session ${session.id}:`, error);

      // Capture to Sentry with context
      captureException(error, {
        userId: session.userId,
        sessionId: session.id,
        operation: 'processMessage',
        extra: { agentId, jid, textPreview: text.substring(0, 100) },
      });

      // For errors, we may not have responseJid calculated yet, so use jid as fallback
      const errorJid = jid;
      await session.sock?.sendMessage(errorJid, {
        text: "Sorry, I encountered an error. Please try again later."
      });
    }
  }

  private async sendLongMessage(
    session: WhatsAppSession,
    jid: string,
    message: string
  ): Promise<proto.WebMessageInfo | undefined> {
    // Add invisible bot signature to all outgoing messages for cross-instance deduplication
    const signedMessage = message + BOT_SIGNATURE;

    if (signedMessage.length <= MAX_MESSAGE_LENGTH) {
      const sent = await session.sock?.sendMessage(jid, { text: signedMessage });
      // Track sent message ID to avoid feedback loops
      if (sent?.key?.id) {
        session.sentMessageIds.add(sent.key.id);
        // Limit set size to prevent memory growth
        if (session.sentMessageIds.size > 1000) {
          const oldest = session.sentMessageIds.values().next().value;
          if (oldest) session.sentMessageIds.delete(oldest);
        }
      }
      return sent;
    }

    const chunks = this.splitMessage(message, MAX_MESSAGE_LENGTH - BOT_SIGNATURE.length);
    let lastSentMessage: proto.WebMessageInfo | undefined;

    for (let i = 0; i < chunks.length; i++) {
      const prefix = i === 0 ? '' : `(${i + 1}/${chunks.length}) `;
      // Add bot signature to each chunk for cross-instance deduplication
      const sent = await session.sock?.sendMessage(jid, { text: prefix + chunks[i] + BOT_SIGNATURE });

      // Track sent message ID to avoid feedback loops
      if (sent?.key?.id) {
        session.sentMessageIds.add(sent.key.id);
        if (session.sentMessageIds.size > 1000) {
          const oldest = session.sentMessageIds.values().next().value;
          if (oldest) session.sentMessageIds.delete(oldest);
        }
      }
      lastSentMessage = sent;

      // Small delay between chunks
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }

    return lastSentMessage;
  }

  private splitMessage(message: string, maxLength: number): string[] {
    const chunks: string[] = [];
    const lines = message.split('\n');
    let currentChunk = '';

    for (const line of lines) {
      if (line.length > maxLength) {
        if (currentChunk.trim()) {
          chunks.push(currentChunk.trim());
          currentChunk = '';
        }
        // Split long line
        for (let i = 0; i < line.length; i += maxLength) {
          chunks.push(line.substring(i, i + maxLength));
        }
      } else {
        const testChunk = currentChunk + '\n' + line;
        if (testChunk.length > maxLength) {
          if (currentChunk.trim()) {
            chunks.push(currentChunk.trim());
          }
          currentChunk = line;
        } else {
          currentChunk = testChunk;
        }
      }
    }

    if (currentChunk.trim()) {
      chunks.push(currentChunk.trim());
    }

    return chunks;
  }

  // HTTP Server
  private startHttpServer(): void {
    this.httpServer = createServer(async (req, res) => {
      // Enable CORS
      res.setHeader('Access-Control-Allow-Origin', '*');
      res.setHeader('Access-Control-Allow-Methods', 'GET, POST, DELETE, OPTIONS');
      res.setHeader('Access-Control-Allow-Headers', 'Content-Type, Authorization');

      if (req.method === 'OPTIONS') {
        res.writeHead(204);
        res.end();
        return;
      }

      try {
        await this.handleRequest(req, res);
      } catch (error: any) {
        logger.error(`❌ [${INSTANCE_ID}] HTTP error:`, error);
        res.writeHead(500, { 'Content-Type': 'application/json' });
        res.end(JSON.stringify({ error: error.message || 'Internal server error' }));
      }
    });

    this.httpServer.listen(GATEWAY_PORT, () => {
      logger.info(`🌐 [${INSTANCE_ID}] WhatsApp Gateway HTTP server running at http://localhost:${GATEWAY_PORT}`);
      logger.info(`📱 [${INSTANCE_ID}] Endpoints:`);
      logger.info(`   POST /login - Start login flow`);
      logger.info(`   GET  /login/{sessionId}/qr - Get QR code`);
      logger.info(`   GET  /login/{sessionId}/status - Get connection status`);
      logger.info(`   GET  /sessions - List your sessions`);
      logger.info(`   DELETE /sessions/{sessionId} - Remove session`);
    });
  }

  private async handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
    const url = new URL(req.url || '/', `http://localhost:${GATEWAY_PORT}`);
    const pathname = url.pathname;

    // Extract auth token
    const authHeader = req.headers.authorization;
    const authToken = authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : null;

    if (!authToken) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Authorization header required' }));
      return;
    }

    // Route handling
    if (req.method === 'POST' && pathname === '/login') {
      await this.handleLogin(authToken, res);
    } else if (req.method === 'GET' && pathname.match(/^\/login\/[^/]+\/qr$/)) {
      const sessionId = pathname.split('/')[2];
      await this.handleGetQr(sessionId, authToken, res);
    } else if (req.method === 'GET' && pathname.match(/^\/login\/[^/]+\/status$/)) {
      const sessionId = pathname.split('/')[2];
      await this.handleGetStatus(sessionId, authToken, res);
    } else if (req.method === 'GET' && pathname === '/sessions') {
      await this.handleListSessions(authToken, res);
    } else if (req.method === 'DELETE' && pathname.match(/^\/sessions\/[^/]+$/)) {
      const sessionId = pathname.split('/')[2];
      await this.handleDeleteSession(sessionId, authToken, res);
    } else {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Not found' }));
    }
  }

  private async handleLogin(authToken: string, res: ServerResponse): Promise<void> {
    try {
      const sessionId = await this.createSession(authToken);
      res.writeHead(200, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ sessionId }));
    } catch (error: any) {
      if (error instanceof GatewayError) {
        // JWT/auth errors should return 401
        if (
          error.code === 'TOKEN_EXPIRED' ||
          error.code === 'TOKEN_INVALID' ||
          error.code === 'TOKEN_MISSING_USERID' ||
          error.code === 'AUTH_SECRET_NOT_CONFIGURED'
        ) {
          res.writeHead(401, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
        // Max sessions reached should return 409
        if (error.code === 'MAX_SESSIONS_REACHED') {
          res.writeHead(409, { 'Content-Type': 'application/json' });
          res.end(JSON.stringify({ error: error.message }));
          return;
        }
      }
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  private async handleGetQr(sessionId: string, authToken: string, res: ServerResponse): Promise<void> {
    let session: WhatsAppSession | null;
    try {
      session = this.getSession(sessionId, authToken);
    } catch (error: any) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }

    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found or not authorized' }));
      return;
    }

    if (session.isConnected) {
      res.writeHead(200, { 'Content-Type': 'text/plain' });
      res.end('Already connected to WhatsApp');
      return;
    }

    if (!session.currentQr) {
      res.writeHead(503, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'QR code not yet available. Try again in a few seconds.' }));
      return;
    }

    try {
      const qrBuffer = await QRCode.toBuffer(session.currentQr);
      res.writeHead(200, { 'Content-Type': 'image/png' });
      res.end(qrBuffer);
    } catch (error: any) {
      res.writeHead(500, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Failed to generate QR code' }));
    }
  }

  private async handleGetStatus(sessionId: string, authToken: string, res: ServerResponse): Promise<void> {
    let session: WhatsAppSession | null;
    try {
      session = this.getSession(sessionId, authToken);
    } catch (error: any) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }

    if (!session) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found or not authorized' }));
      return;
    }

    const status: ConnectionStatus = {
      connected: session.isConnected,
      phoneNumber: session.phoneNumber,
      qrAvailable: !!session.currentQr && !session.isConnected,
    };

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify(status));
  }

  private async handleListSessions(authToken: string, res: ServerResponse): Promise<void> {
    // Verify JWT and extract userId
    let userId: string;
    try {
      userId = verifyAndExtractUserId(authToken);
    } catch (error: any) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }

    const userSessions: Array<{ sessionId: string; phoneNumber: string | null; connected: boolean }> = [];

    for (const [sessionId, session] of this.sessions) {
      if (session.userId === userId) {
        userSessions.push({
          sessionId,
          phoneNumber: session.phoneNumber,
          connected: session.isConnected,
        });
      }
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ sessions: userSessions }));
  }

  private async handleDeleteSession(sessionId: string, authToken: string, res: ServerResponse): Promise<void> {
    let success: boolean;
    try {
      success = await this.destroySession(sessionId, authToken);
    } catch (error: any) {
      res.writeHead(401, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
      return;
    }

    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found or not authorized' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
  }

  // Message caching for context retrieval
  private static readonly MAX_CACHED_MESSAGES_PER_CONTACT = 50;

  private cacheMessage(session: WhatsAppSession, contactJid: string, message: CachedMessage): void {
    let messages = session.messageCache.get(contactJid);
    if (!messages) {
      messages = [];
      session.messageCache.set(contactJid, messages);
    }

    // Avoid duplicates
    if (messages.some(m => m.messageId === message.messageId)) {
      return;
    }

    messages.push(message);

    // Keep only the most recent messages
    if (messages.length > WhatsAppGateway.MAX_CACHED_MESSAGES_PER_CONTACT) {
      messages.shift(); // Remove oldest
    }

    // Sort by timestamp (most recent last)
    messages.sort((a, b) => a.timestamp.getTime() - b.timestamp.getTime());
  }

  /**
   * Fetch recent messages with a contact from the cache.
   * Returns messages that have been received/sent since the gateway connected.
   *
   * @param sessionId - The WhatsApp session ID
   * @param phoneNumber - Phone number in international format (e.g., +1234567890)
   * @param limit - Maximum number of messages to return (default: 20)
   * @returns Array of cached messages or error info
   */
  fetchRecentMessages(
    sessionId: string,
    phoneNumber: string,
    limit: number = 20
  ): {
    found: boolean;
    messages?: Array<{ timestamp: string; fromMe: boolean; text: string }>;
    error?: string;
  } {
    const session = this.sessions.get(sessionId);
    if (!session) {
      return { found: false, error: 'Session not found' };
    }

    if (!session.isConnected) {
      return { found: false, error: 'Session not connected' };
    }

    // Convert phone number to JID format
    // Remove '+' and any non-digit characters, then add @s.whatsapp.net
    const normalizedPhone = phoneNumber.replace(/[^\d]/g, '');
    const contactJid = `${normalizedPhone}@s.whatsapp.net`;

    logger.info(`📨 [${INSTANCE_ID}] Fetching cached messages for ${contactJid} (limit: ${limit})`);

    const cachedMessages = session.messageCache.get(contactJid);
    if (!cachedMessages || cachedMessages.length === 0) {
      logger.info(`📭 [${INSTANCE_ID}] No cached messages found for ${contactJid}`);
      return {
        found: false,
        error: 'No cached messages found. Messages are only available after the WhatsApp gateway connects.',
      };
    }

    // Get the most recent N messages
    const recentMessages = cachedMessages
      .slice(-limit)
      .map(msg => ({
        timestamp: msg.timestamp.toISOString(),
        fromMe: msg.fromMe,
        text: msg.text,
      }));

    logger.info(`✅ [${INSTANCE_ID}] Found ${recentMessages.length} cached messages for ${contactJid}`);

    return {
      found: true,
      messages: recentMessages,
    };
  }

  /**
   * Get a session by ID (for use by tools)
   */
  getSession(sessionId: string): WhatsAppSession | undefined {
    return this.sessions.get(sessionId);
  }

  // Cleanup
  async shutdown(): Promise<void> {
    logger.info(`🛑 [${INSTANCE_ID}] Shutting down WhatsApp Gateway...`);

    // Close all sockets
    for (const [sessionId, session] of this.sessions) {
      try {
        if (session.sock) {
          session.sock.ws?.close();
        }
        logger.info(`✅ [${INSTANCE_ID}] Closed session ${sessionId}`);
      } catch (error) {
        logger.error(`❌ [${INSTANCE_ID}] Error closing session ${sessionId}:`, error);
      }
    }

    // Close HTTP server
    if (this.httpServer) {
      await new Promise<void>((resolve) => {
        this.httpServer!.close(() => resolve());
      });
    }

    logger.info(`✅ [${INSTANCE_ID}] WhatsApp Gateway shutdown complete`);
  }
}

// Global instance
let globalGateway: WhatsAppGateway | null = null;

export function createWhatsAppGateway(): WhatsAppGateway | null {
  if (globalGateway) {
    logger.info(`♻️ [${INSTANCE_ID}] WhatsApp Gateway already exists, reusing instance`);
    return globalGateway;
  }

  try {
    globalGateway = new WhatsAppGateway();
    globalGateway.initialize().catch(err => {
      logger.error(`❌ [${INSTANCE_ID}] Failed to initialize WhatsApp Gateway:`, err);
      globalGateway = null;
    });
    return globalGateway;
  } catch (error) {
    logger.error(`❌ [${INSTANCE_ID}] Failed to create WhatsApp Gateway:`, error);
    return null;
  }
}

export async function cleanupWhatsAppGateway(): Promise<void> {
  if (globalGateway) {
    await globalGateway.shutdown();
    globalGateway = null;
  }
}

export function getWhatsAppGateway(): WhatsAppGateway | null {
  return globalGateway;
}
