/**
 * Signal Gateway (Multi-Tenant)
 *
 * Connects to signal-cli running in JSON-RPC daemon mode.
 * Follows the same patterns as telegram-gateway.ts and whatsapp-gateway.ts.
 *
 * Architecture:
 * - signal-cli runs as a daemon (auto-spawned or external)
 * - Gateway connects via HTTP JSON-RPC for sending
 * - Gateway listens via SSE for incoming messages
 * - Each Exponential user pairs their Signal account
 * - Messages route to their configured agent
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { spawn, ChildProcess } from 'child_process';
import { promises as fs } from 'fs';
import path from 'path';
import os from 'os';
import crypto from 'crypto';
import http from 'http';

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
import { captureException } from '../utils/sentry.js';

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
  name: 'SignalGateway',
  level: 'info',
});

const INSTANCE_ID = `signal-gateway-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;

// Configuration
const GATEWAY_PORT = parseInt(process.env.SIGNAL_GATEWAY_PORT || '4114', 10);
const SIGNAL_CLI_PATH = process.env.SIGNAL_CLI_PATH || 'signal-cli';
const SIGNAL_ACCOUNT = process.env.SIGNAL_ACCOUNT || ''; // E.164 bot number
const SIGNAL_CLI_HTTP_URL = process.env.SIGNAL_CLI_HTTP_URL || ''; // External daemon URL
const AUTO_START_DAEMON = process.env.SIGNAL_AUTO_START !== 'false';
const SESSIONS_DIR = process.env.SIGNAL_SESSIONS_DIR || path.join(os.homedir(), '.mastra', 'signal-sessions');
const MAPPINGS_FILE = path.join(SESSIONS_DIR, 'signal-mappings.json');
const MAX_MESSAGE_LENGTH = 4000;
const CONVERSATION_TIMEOUT_MS = 3 * 60 * 1000; // 3 minutes
const PAIRING_CODE_TTL_MS = 10 * 60 * 1000; // 10 minutes
const MAX_HISTORY_MESSAGES = 10;

// ─── Types ──────────────────────────────────────────────────

interface SignalMapping {
  userId: string;
  signalNumber: string; // E.164 or UUID
  agentId: AgentIdentifier;
  encryptedToken: string;
  pairedAt: string;
  lastActive: string;
}

interface PairingRequest {
  code: string;
  userId: string;
  agentId: AgentIdentifier;
  encryptedToken: string;
  createdAt: number;
}

interface ConversationEntry {
  role: 'user' | 'assistant';
  content: string;
  timestamp: number;
}

interface SignalInboundMessage {
  envelope: {
    source?: string;
    sourceNumber?: string;
    sourceUuid?: string;
    sourceName?: string;
    timestamp: number;
    dataMessage?: {
      message?: string;
      timestamp: number;
      groupInfo?: {
        groupId: string;
        type: string;
      };
    };
    syncMessage?: {
      sentMessage?: {
        message?: string;
        destination?: string;
        destinationNumber?: string;
        timestamp: number;
      };
    };
  };
  account?: string;
}

// ─── State ──────────────────────────────────────────────────

let signalDaemon: ChildProcess | null = null;
let signalDaemonUrl = '';
let mappings: Map<string, SignalMapping> = new Map(); // signalNumber -> mapping
let pairingCodes: Map<string, PairingRequest> = new Map();
let conversations: Map<string, ConversationEntry[]> = new Map();
let processingMessages: Set<string> = new Set();
let sseAbortController: AbortController | null = null;
let server: Server | null = null;

// ─── Daemon management ──────────────────────────────────────

async function startDaemon(): Promise<string> {
  if (SIGNAL_CLI_HTTP_URL) {
    logger.info(`📡 [Signal] Using external daemon at ${SIGNAL_CLI_HTTP_URL}`);
    return SIGNAL_CLI_HTTP_URL;
  }

  if (!AUTO_START_DAEMON) {
    throw new Error('Signal daemon not configured. Set SIGNAL_CLI_HTTP_URL or enable auto-start.');
  }

  if (!SIGNAL_ACCOUNT) {
    throw new Error('SIGNAL_ACCOUNT (E.164 bot number) is required for auto-start.');
  }

  const daemonPort = GATEWAY_PORT + 100; // e.g., 4214
  const url = `http://127.0.0.1:${daemonPort}`;

  logger.info(`🚀 [Signal] Starting signal-cli daemon on port ${daemonPort}...`);

  const args = [
    '--output=json',
    '-a', SIGNAL_ACCOUNT,
    'daemon',
    '--http', `127.0.0.1:${daemonPort}`,
    '--receive-mode=on-connection',
  ];

  signalDaemon = spawn(SIGNAL_CLI_PATH, args, {
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: false,
  });

  signalDaemon.stdout?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) logger.debug(`[signal-cli stdout] ${line}`);
  });

  signalDaemon.stderr?.on('data', (data: Buffer) => {
    const line = data.toString().trim();
    if (line) logger.debug(`[signal-cli stderr] ${line}`);
  });

  signalDaemon.on('exit', (code, signal) => {
    logger.warn(`⚠️ [Signal] signal-cli daemon exited (code=${code}, signal=${signal})`);
    signalDaemon = null;
  });

  // Wait for daemon to become ready
  const startTime = Date.now();
  const timeout = 30000;
  while (Date.now() - startTime < timeout) {
    try {
      await jsonRpc(url, 'version', {});
      logger.info(`✅ [Signal] Daemon ready at ${url}`);
      return url;
    } catch {
      await new Promise(r => setTimeout(r, 500));
    }
  }

  throw new Error(`Signal daemon failed to start within ${timeout / 1000}s`);
}

// ─── JSON-RPC helpers ───────────────────────────────────────

async function jsonRpc(baseUrl: string, method: string, params: Record<string, unknown>): Promise<unknown> {
  const body = JSON.stringify({
    jsonrpc: '2.0',
    method,
    params,
    id: crypto.randomUUID(),
  });

  const response = await fetch(`${baseUrl}/api/v1/rpc`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body,
  });

  const result = await response.json() as { result?: unknown; error?: { code: number; message: string } };
  if (result.error) {
    throw new Error(`JSON-RPC error: ${result.error.message} (code ${result.error.code})`);
  }
  return result.result;
}

async function sendSignalMessage(recipient: string, message: string): Promise<void> {
  const chunks = splitMessage(message, MAX_MESSAGE_LENGTH);

  for (const chunk of chunks) {
    const params: Record<string, unknown> = {
      message: chunk,
      account: SIGNAL_ACCOUNT,
    };

    // Determine if recipient is a phone number, UUID, or group
    if (recipient.startsWith('group:')) {
      params.groupId = recipient.replace('group:', '');
    } else if (recipient.includes('-') && !recipient.startsWith('+')) {
      // UUID format
      params.recipients = [recipient];
    } else {
      params.recipients = [recipient];
    }

    await jsonRpc(signalDaemonUrl, 'send', params);
  }
}

// ─── SSE listener ───────────────────────────────────────────

function startSSEListener(): void {
  const sseUrl = `${signalDaemonUrl}/api/v1/events?account=${encodeURIComponent(SIGNAL_ACCOUNT)}`;
  logger.info(`📡 [Signal] Connecting SSE: ${sseUrl}`);

  sseAbortController = new AbortController();

  connectSSE(sseUrl, sseAbortController.signal);
}

async function connectSSE(url: string, signal: AbortSignal): Promise<void> {
  while (!signal.aborted) {
    try {
      const response = await fetch(url, {
        headers: { 'Accept': 'text/event-stream' },
        signal,
      });

      if (!response.ok || !response.body) {
        logger.warn(`⚠️ [Signal] SSE connection failed: ${response.status}`);
        await new Promise(r => setTimeout(r, 5000));
        continue;
      }

      const reader = response.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';

        let currentData = '';
        for (const line of lines) {
          if (line.startsWith('data:')) {
            currentData += line.slice(5).trim();
          } else if (line.trim() === '' && currentData) {
            try {
              const event = JSON.parse(currentData) as SignalInboundMessage;
              handleInboundMessage(event).catch(err => {
                logger.error(`❌ [Signal] Error handling message:`, err);
                captureException(err);
              });
            } catch {
              // Ignore malformed events
            }
            currentData = '';
          }
        }
      }
    } catch (err: unknown) {
      if (signal.aborted) break;
      const errMsg = err instanceof Error ? err.message : String(err);
      logger.warn(`⚠️ [Signal] SSE disconnected: ${errMsg}. Reconnecting in 5s...`);
      await new Promise(r => setTimeout(r, 5000));
    }
  }
}

// ─── Message handling ───────────────────────────────────────

async function handleInboundMessage(event: SignalInboundMessage): Promise<void> {
  const envelope = event.envelope;
  if (!envelope) return;

  // Extract message text and sender
  let messageText: string | undefined;
  let sender: string | undefined;

  if (envelope.dataMessage?.message) {
    messageText = envelope.dataMessage.message;
    sender = envelope.sourceNumber || envelope.sourceUuid || envelope.source;
  }

  // Skip group messages for now (DM only in v1)
  if (envelope.dataMessage?.groupInfo) {
    logger.debug(`[Signal] Skipping group message`);
    return;
  }

  // Skip messages from self
  if (sender === SIGNAL_ACCOUNT) return;

  if (!messageText || !sender) return;

  // Deduplicate
  const msgKey = `${sender}:${envelope.timestamp}`;
  if (processingMessages.has(msgKey)) return;
  processingMessages.add(msgKey);
  setTimeout(() => processingMessages.delete(msgKey), 60000);

  logger.info(`📥 [Signal] Message from ${sender}: "${messageText.substring(0, 50)}..."`);

  // Handle commands
  if (messageText.startsWith('/')) {
    await handleCommand(sender, messageText);
    return;
  }

  // Look up mapping
  const mapping = mappings.get(sender);
  if (!mapping) {
    // Check if this is a pairing attempt
    const trimmed = messageText.trim().toUpperCase();
    const pairingRequest = pairingCodes.get(trimmed);
    if (pairingRequest) {
      await completePairing(sender, pairingRequest);
      return;
    }

    await sendSignalMessage(sender, '🔒 Your Signal account is not linked. Please pair through the Exponential app first.');
    return;
  }

  // Route to agent
  await routeToAgent(sender, messageText, mapping);
}

async function handleCommand(sender: string, text: string): Promise<void> {
  const parts = text.trim().split(/\s+/);
  const command = parts[0]?.toLowerCase();

  switch (command) {
    case '/start': {
      const code = parts[1]?.toUpperCase();
      if (!code) {
        await sendSignalMessage(sender, 'Usage: /start <PAIRING_CODE>');
        return;
      }
      const request = pairingCodes.get(code);
      if (!request) {
        await sendSignalMessage(sender, '❌ Invalid or expired pairing code.');
        return;
      }
      await completePairing(sender, request);
      break;
    }

    case '/disconnect': {
      const mapping = mappings.get(sender);
      if (!mapping) {
        await sendSignalMessage(sender, 'You are not connected.');
        return;
      }
      mappings.delete(sender);
      conversations.delete(sender);
      await saveMappings();
      await sendSignalMessage(sender, '✅ Disconnected. Your Signal account is unlinked.');
      logger.info(`🔓 [Signal] User ${mapping.userId} disconnected`);
      break;
    }

    case '/agent': {
      const mapping = mappings.get(sender);
      if (!mapping) {
        await sendSignalMessage(sender, '🔒 Not connected. Pair first.');
        return;
      }
      const agentName = parts[1]?.toLowerCase() as AgentIdentifier;
      if (!agentName || !getAgentByIdentifier(agentName)) {
        const available = ['assistant', 'zoe', 'paddy', 'pierre', 'ash', 'weather'];
        await sendSignalMessage(sender, `Available agents: ${available.join(', ')}\nUsage: /agent <name>`);
        return;
      }
      mapping.agentId = agentName;
      await saveMappings();
      await sendSignalMessage(sender, `✅ Switched to ${agentName}`);
      break;
    }

    case '/help': {
      await sendSignalMessage(sender,
        '📖 Commands:\n' +
        '/start <CODE> — Complete account pairing\n' +
        '/disconnect — Unlink Signal account\n' +
        '/agent <name> — Switch agent (assistant, zoe, paddy, pierre, ash, weather)\n' +
        '/help — Show this message\n\n' +
        'You can also @mention an agent inline: @paddy what are my tasks?'
      );
      break;
    }

    default:
      await sendSignalMessage(sender, 'Unknown command. Type /help for available commands.');
  }
}

async function completePairing(signalNumber: string, request: PairingRequest): Promise<void> {
  // Check expiry
  if (Date.now() - request.createdAt > PAIRING_CODE_TTL_MS) {
    pairingCodes.delete(request.code);
    await sendSignalMessage(signalNumber, '❌ Pairing code expired. Please generate a new one from the app.');
    return;
  }

  // Remove any existing mapping for this user
  for (const [key, m] of mappings) {
    if (m.userId === request.userId) {
      mappings.delete(key);
      break;
    }
  }

  const mapping: SignalMapping = {
    userId: request.userId,
    signalNumber,
    agentId: request.agentId,
    encryptedToken: request.encryptedToken,
    pairedAt: new Date().toISOString(),
    lastActive: new Date().toISOString(),
  };

  mappings.set(signalNumber, mapping);
  pairingCodes.delete(request.code);
  await saveMappings();

  await sendSignalMessage(signalNumber, `✅ Paired! You're now connected to ${request.agentId}. Type /help for commands.`);
  logger.info(`🔗 [Signal] Paired user ${request.userId} ↔ ${signalNumber}`);
}

// ─── Agent routing ──────────────────────────────────────────

async function routeToAgent(sender: string, text: string, mapping: SignalMapping): Promise<void> {
  // Check for @mention to route to specific agent
  let agentId = mapping.agentId;
  let cleanText = text;

  const mentionResult = parseMessageForMention(text);
  if (mentionResult.agent) {
    agentId = mentionResult.agent;
    cleanText = mentionResult.text;
  }

  const agent = getAgentByIdentifier(agentId);
  if (!agent) {
    await sendSignalMessage(sender, `❌ Agent "${agentId}" not available.`);
    return;
  }

  // Update last active
  mapping.lastActive = new Date().toISOString();

  // Build conversation history
  const history = conversations.get(sender) || [];
  history.push({ role: 'user', content: cleanText, timestamp: Date.now() });

  // Trim old entries
  const cutoff = Date.now() - CONVERSATION_TIMEOUT_MS;
  const recentHistory = history.filter(h => h.timestamp > cutoff).slice(-MAX_HISTORY_MESSAGES);
  conversations.set(sender, recentHistory);

  // Build messages for agent
  const messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }> = recentHistory.map(h => ({
    role: h.role as 'user' | 'assistant',
    content: h.content,
  }));

  try {
    // Decrypt auth token for runtimeContext
    const secret = process.env.AUTH_SECRET;
    if (!secret) throw new Error('AUTH_SECRET not configured');
    const authToken = decryptToken(mapping.encryptedToken, secret);

    const requestContext = new RequestContext();
    requestContext.set('authToken', authToken);
    requestContext.set('userId', mapping.userId);
    requestContext.set('channel', 'signal');

    const result = await agent.generate(messages, {
      requestContext,
    });

    const responseText = result.text || '(No response)';

    // Store in history
    recentHistory.push({ role: 'assistant', content: responseText, timestamp: Date.now() });
    conversations.set(sender, recentHistory);

    // Send reply
    await sendSignalMessage(sender, responseText);

    logger.info(`📤 [Signal] Reply to ${sender} via ${agentId} (${responseText.length} chars)`);
  } catch (err) {
    logger.error(`❌ [Signal] Agent error for ${sender}:`, err);
    captureException(err);
    await sendSignalMessage(sender, '⚠️ Something went wrong processing your message. Please try again.').catch(() => {});
  }
}

// ─── Persistence ────────────────────────────────────────────

async function loadMappings(): Promise<void> {
  try {
    await fs.mkdir(SESSIONS_DIR, { recursive: true });
    const data = await fs.readFile(MAPPINGS_FILE, 'utf-8');
    const parsed = JSON.parse(data) as SignalMapping[];
    mappings = new Map(parsed.map(m => [m.signalNumber, m]));
    logger.info(`📂 [Signal] Loaded ${mappings.size} mappings`);
  } catch {
    mappings = new Map();
    logger.info(`📂 [Signal] No existing mappings, starting fresh`);
  }
}

async function saveMappings(): Promise<void> {
  await fs.mkdir(SESSIONS_DIR, { recursive: true });
  const data = JSON.stringify(Array.from(mappings.values()), null, 2);
  await fs.writeFile(MAPPINGS_FILE, data, 'utf-8');
}

// ─── HTTP API ───────────────────────────────────────────────

function handleRequest(req: IncomingMessage, res: ServerResponse): void {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${GATEWAY_PORT}`);
  const pathname = url.pathname;

  // Health check
  if (pathname === '/health' && req.method === 'GET') {
    sendJsonResponse(res, 200, {
      status: 'ok',
      instance: INSTANCE_ID,
      account: SIGNAL_ACCOUNT,
      mappings: mappings.size,
      daemonConnected: !!signalDaemonUrl,
    });
    return;
  }

  // All other endpoints require auth
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    sendJsonResponse(res, 401, { error: 'Missing authorization header' });
    return;
  }

  const token = authHeader.slice(7);
  let userId: string;
  try {
    userId = verifyAndExtractUserId(token);
  } catch (err) {
    handleGatewayError(err, res);
    return;
  }

  // POST /pair — Generate pairing code
  if (pathname === '/pair' && req.method === 'POST') {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const input = body ? JSON.parse(body) : {};
        const agentId = (input.agentId || 'assistant') as AgentIdentifier;

        const code = crypto.randomBytes(3).toString('hex').toUpperCase(); // 6 char code
        const secret = process.env.AUTH_SECRET;
        if (!secret) {
          sendJsonResponse(res, 500, { error: 'AUTH_SECRET not configured' });
          return;
        }
        const encryptedToken = encryptToken(token, secret);

        pairingCodes.set(code, {
          code,
          userId,
          agentId,
          encryptedToken,
          createdAt: Date.now(),
        });

        // Clean expired codes
        const now = Date.now();
        for (const [c, req] of pairingCodes) {
          if (now - req.createdAt > PAIRING_CODE_TTL_MS) {
            pairingCodes.delete(c);
          }
        }

        logger.info(`🔑 [Signal] Pairing code generated for user ${userId}: ${code}`);

        sendJsonResponse(res, 200, {
          pairingCode: code,
          botNumber: SIGNAL_ACCOUNT,
          instructions: `Send this code to ${SIGNAL_ACCOUNT} on Signal, or type: /start ${code}`,
          expiresIn: PAIRING_CODE_TTL_MS / 1000,
        });
      } catch (err) {
        handleGatewayError(err, res);
      }
    });
    return;
  }

  // DELETE /pair — Unpair
  if (pathname === '/pair' && req.method === 'DELETE') {
    let found = false;
    for (const [key, m] of mappings) {
      if (m.userId === userId) {
        mappings.delete(key);
        conversations.delete(key);
        found = true;
        break;
      }
    }
    saveMappings().catch(err => logger.error('Failed to save after unpair:', err));

    sendJsonResponse(res, 200, { unpaired: found });
    return;
  }

  // GET /status — Check pairing status
  if (pathname === '/status' && req.method === 'GET') {
    let paired = false;
    let signalNumber: string | undefined;
    let agentId: string | undefined;
    let lastActive: string | undefined;

    for (const m of mappings.values()) {
      if (m.userId === userId) {
        paired = true;
        signalNumber = m.signalNumber;
        agentId = m.agentId;
        lastActive = m.lastActive;
        break;
      }
    }

    sendJsonResponse(res, 200, { paired, signalNumber, agentId, lastActive });
    return;
  }

  // PUT /settings — Update agent
  if (pathname === '/settings' && req.method === 'PUT') {
    let body = '';
    req.on('data', (chunk: Buffer) => { body += chunk.toString(); });
    req.on('end', async () => {
      try {
        const input = JSON.parse(body);

        for (const m of mappings.values()) {
          if (m.userId === userId) {
            if (input.agentId) m.agentId = input.agentId as AgentIdentifier;
            await saveMappings();
            sendJsonResponse(res, 200, { updated: true, agentId: m.agentId });
            return;
          }
        }

        sendJsonResponse(res, 404, { error: 'No Signal account paired for this user' });
      } catch (err) {
        handleGatewayError(err, res);
      }
    });
    return;
  }

  sendJsonResponse(res, 404, { error: 'Not found' });
}

// ─── Lifecycle ──────────────────────────────────────────────

let gatewayInstance: { server: Server; shutdown: () => Promise<void> } | null = null;

export async function startSignalGateway(): Promise<{ server: Server; shutdown: () => Promise<void> }> {
  logger.info(`🚀 [Signal] Starting gateway (${INSTANCE_ID})...`);

  // Load persisted mappings
  await loadMappings();

  // Start or connect to signal-cli daemon
  signalDaemonUrl = await startDaemon();

  // Start SSE listener for incoming messages
  startSSEListener();

  // Start HTTP API server
  server = createServer(handleRequest);

  await new Promise<void>((resolve, reject) => {
    server!.listen(GATEWAY_PORT, '0.0.0.0', () => {
      logger.info(`✅ [Signal] Gateway listening on port ${GATEWAY_PORT}`);
      resolve();
    });
    server!.on('error', reject);
  });

  const shutdown = async () => {
    logger.info('🛑 [Signal] Shutting down...');

    // Stop SSE
    sseAbortController?.abort();

    // Stop HTTP server
    if (server) {
      await new Promise<void>(resolve => server!.close(() => resolve()));
    }

    // Kill daemon if we started it
    if (signalDaemon) {
      signalDaemon.kill('SIGTERM');
      signalDaemon = null;
    }

    // Save state
    await saveMappings();

    logger.info('✅ [Signal] Gateway shut down');
  };

  gatewayInstance = { server, shutdown };
  return gatewayInstance;
}

export function getSignalGateway() {
  return gatewayInstance;
}
