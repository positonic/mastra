import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { createHash, randomUUID } from 'crypto';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';

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

import { projectManagerAgent } from '../agents/index.js';

const logger = createLogger({
  name: 'WhatsAppGateway',
  level: 'info',
});

// Generate unique instance ID for logging
const INSTANCE_ID = `wa-gateway-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Configuration
const GATEWAY_PORT = parseInt(process.env.WHATSAPP_GATEWAY_PORT || '4112', 10);
const SESSIONS_DIR = path.join(os.homedir(), '.mastra', 'whatsapp-sessions');
const SESSIONS_FILE = path.join(SESSIONS_DIR, 'sessions.json');
const MAX_SESSIONS = parseInt(process.env.WHATSAPP_MAX_SESSIONS || '10', 10);
const MAX_MESSAGE_LENGTH = 4096;

// Types
interface SessionMetadata {
  ownerAuthTokenHash: string;
  phoneNumber: string | null;
  createdAt: string;
  lastConnected: string | null;
}

interface SessionsFile {
  [sessionId: string]: SessionMetadata;
}

interface WhatsAppSession {
  id: string;
  ownerAuthTokenHash: string;
  sock: WASocket | null;
  currentQr: string | null;
  isConnected: boolean;
  phoneNumber: string | null;
  createdAt: Date;
  credentialsPath: string;
  reconnectAttempts: number;
  maxReconnectAttempts: number;
}

interface ConnectionStatus {
  connected: boolean;
  phoneNumber: string | null;
  qrAvailable: boolean;
}

// Utility functions
function hashToken(token: string): string {
  return createHash('sha256').update(token).digest('hex');
}

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
      await fs.writeFile(SESSIONS_FILE, JSON.stringify(this.sessionsMetadata, null, 2));
    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error saving sessions metadata:`, error);
    }
  }

  private async reconnectExistingSessions(): Promise<void> {
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

        const session: WhatsAppSession = {
          id: sessionId,
          ownerAuthTokenHash: metadata.ownerAuthTokenHash,
          sock: null,
          currentQr: null,
          isConnected: false,
          phoneNumber: metadata.phoneNumber,
          createdAt: new Date(metadata.createdAt),
          credentialsPath,
          reconnectAttempts: 0,
          maxReconnectAttempts: 5,
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
    if (this.sessions.size >= MAX_SESSIONS) {
      throw new Error(`Maximum sessions (${MAX_SESSIONS}) reached`);
    }

    const authTokenHash = hashToken(authToken);

    // Check if user already has a session
    for (const [existingId, session] of this.sessions) {
      if (session.ownerAuthTokenHash === authTokenHash) {
        logger.info(`♻️ [${INSTANCE_ID}] User already has session ${existingId}`);
        return existingId;
      }
    }

    const sessionId = randomUUID().slice(0, 8);
    const credentialsPath = path.join(SESSIONS_DIR, sessionId);

    await ensureDir(credentialsPath);

    const session: WhatsAppSession = {
      id: sessionId,
      ownerAuthTokenHash: authTokenHash,
      sock: null,
      currentQr: null,
      isConnected: false,
      phoneNumber: null,
      createdAt: new Date(),
      credentialsPath,
      reconnectAttempts: 0,
      maxReconnectAttempts: 5,
    };

    this.sessions.set(sessionId, session);

    // Save metadata
    this.sessionsMetadata[sessionId] = {
      ownerAuthTokenHash: authTokenHash,
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

    const authTokenHash = hashToken(authToken);
    if (session.ownerAuthTokenHash !== authTokenHash) {
      return null; // Not authorized to access this session
    }

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

        // Skip messages from self
        if (msg.key.fromMe) continue;

        // Extract text
        const text = extractText(msg.message);
        if (!text) continue;

        // Get sender
        const senderE164 = jidToE164(remoteJid);
        if (!senderE164) continue;

        // Only process messages from session owner
        if (senderE164 !== session.phoneNumber) {
          logger.info(`📨 [${INSTANCE_ID}] Ignoring message from ${senderE164} (not session owner ${session.phoneNumber})`);
          continue;
        }

        logger.info(`📨 [${INSTANCE_ID}] Received message from ${senderE164} in session ${session.id}: ${text.substring(0, 50)}...`);

        // Mark as read
        await session.sock?.readMessages([{ remoteJid, id: msg.key.id!, participant: undefined, fromMe: false }]);

        // Process with agent
        await this.processMessage(session, remoteJid, text);

      } catch (error) {
        logger.error(`❌ [${INSTANCE_ID}] Error processing message in session ${session.id}:`, error);
      }
    }
  }

  private async processMessage(session: WhatsAppSession, jid: string, text: string): Promise<void> {
    try {
      // Send typing indicator
      await session.sock?.sendPresenceUpdate('composing', jid);

      // Find the original authToken from the hash
      // Note: We can't reverse the hash, but we have the hash stored
      // The agent will use runtimeContext with a placeholder that the TODO app validates

      // Route to projectManagerAgent with session context
      const response = await projectManagerAgent.generate(
        [{ role: 'user', content: text }],
        {
          runtimeContext: new Map([
            ['authToken', session.ownerAuthTokenHash], // TODO app should accept hashed tokens
            ['whatsappSession', session.id],
            ['whatsappPhone', session.phoneNumber || ''],
          ])
        }
      );

      const agentResponse = response.text;

      if (agentResponse) {
        await this.sendLongMessage(session, jid, agentResponse);
        logger.info(`✅ [${INSTANCE_ID}] Sent response to ${jidToE164(jid)} in session ${session.id}`);
      } else {
        await session.sock?.sendMessage(jid, {
          text: "Sorry, I couldn't process your request. Please try again."
        });
      }

    } catch (error) {
      logger.error(`❌ [${INSTANCE_ID}] Error processing message in session ${session.id}:`, error);
      await session.sock?.sendMessage(jid, {
        text: "Sorry, I encountered an error. Please try again later."
      });
    }
  }

  private async sendLongMessage(session: WhatsAppSession, jid: string, message: string): Promise<void> {
    if (message.length <= MAX_MESSAGE_LENGTH) {
      await session.sock?.sendMessage(jid, { text: message });
      return;
    }

    const chunks = this.splitMessage(message, MAX_MESSAGE_LENGTH);
    for (let i = 0; i < chunks.length; i++) {
      const prefix = i === 0 ? '' : `(${i + 1}/${chunks.length}) `;
      await session.sock?.sendMessage(jid, { text: prefix + chunks[i] });

      // Small delay between chunks
      if (i < chunks.length - 1) {
        await new Promise(resolve => setTimeout(resolve, 100));
      }
    }
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
      res.writeHead(400, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: error.message }));
    }
  }

  private async handleGetQr(sessionId: string, authToken: string, res: ServerResponse): Promise<void> {
    const session = this.getSession(sessionId, authToken);

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
    const session = this.getSession(sessionId, authToken);

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
    const authTokenHash = hashToken(authToken);
    const userSessions: Array<{ sessionId: string; phoneNumber: string | null; connected: boolean }> = [];

    for (const [sessionId, session] of this.sessions) {
      if (session.ownerAuthTokenHash === authTokenHash) {
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
    const success = await this.destroySession(sessionId, authToken);

    if (!success) {
      res.writeHead(404, { 'Content-Type': 'application/json' });
      res.end(JSON.stringify({ error: 'Session not found or not authorized' }));
      return;
    }

    res.writeHead(200, { 'Content-Type': 'application/json' });
    res.end(JSON.stringify({ success: true }));
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
