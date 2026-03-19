/**
 * Voice Gateway — Vapi.ai + ElevenLabs integration
 *
 * Handles inbound/outbound voice calls via Vapi's custom LLM server URL mode.
 * Vapi handles telephony, STT, and TTS (ElevenLabs). This gateway receives
 * transcribed text, routes it to the One2b agent, and returns text for synthesis.
 *
 * Port: 4115 (VOICE_GATEWAY_PORT)
 *
 * Endpoints:
 *   POST /vapi/webhook     — Vapi webhook/server URL handler
 *   POST /call/initiate    — Trigger an outbound call
 *   GET  /call/:id/status  — Check call status
 *   GET  /calls            — List recent calls
 */

import { createServer, IncomingMessage, ServerResponse, Server } from 'http';
import { randomUUID } from 'crypto';
import { createLogger } from '@mastra/core/logger';
import { RequestContext } from '@mastra/core/di';

import {
  GatewayError,
  verifyAndExtractUserId,
  sendJsonResponse,
  handleGatewayError,
  setCorsHeaders,
} from '../utils/gateway-shared.js';
import { one2bAgent } from '../agents/one2b-agent.js';
import { captureException } from '../utils/sentry.js';

const logger = createLogger({
  name: 'VoiceGateway',
  level: 'info',
});

const GATEWAY_PORT = parseInt(process.env.VOICE_GATEWAY_PORT || '4115', 10);
const VAPI_API_KEY = process.env.VAPI_API_KEY;
const VAPI_PHONE_NUMBER_ID = process.env.VAPI_PHONE_NUMBER_ID;
const INSTANCE_ID = randomUUID().slice(0, 8);

// ─── Types ────────────────────────────────────────────────────────────────────

interface VapiMessage {
  role: 'system' | 'user' | 'assistant' | 'function';
  content: string;
  name?: string;
}

interface VapiWebhookPayload {
  type: string;
  // For 'conversation-update' / custom LLM server URL mode
  messages?: VapiMessage[];
  call?: {
    id: string;
    phoneNumber?: { number: string };
    customer?: { number: string; name?: string };
    metadata?: Record<string, string>;
  };
  // For 'function-call'
  functionCall?: {
    name: string;
    parameters: Record<string, unknown>;
  };
  // For 'end-of-call-report'
  summary?: string;
  transcript?: string;
  recordingUrl?: string;
  endedReason?: string;
}

interface CallRecord {
  id: string;
  vapiCallId?: string;
  contactName: string;
  contactPhone?: string;
  direction: 'inbound' | 'outbound';
  status: 'initiated' | 'in_progress' | 'completed' | 'failed';
  startedAt: string;
  endedAt?: string;
  summary?: string;
  metadata?: Record<string, string>;
}

// In-memory call tracking (production: move to database)
const activeCalls = new Map<string, CallRecord>();

// ─── HTTP helpers ──────────────────────────────────────────────────────────

async function readBody(req: IncomingMessage): Promise<string> {
  return new Promise((resolve, reject) => {
    let data = '';
    req.on('data', (chunk: Buffer) => { data += chunk.toString(); });
    req.on('end', () => resolve(data));
    req.on('error', reject);
  });
}

function extractAuthToken(req: IncomingMessage): string {
  const authHeader = req.headers.authorization;
  if (!authHeader?.startsWith('Bearer ')) {
    throw new GatewayError('TOKEN_INVALID', 'Missing or invalid Authorization header');
  }
  return authHeader.slice(7);
}

// ─── Vapi webhook handler ──────────────────────────────────────────────────

async function handleVapiWebhook(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const body = await readBody(req);
  let payload: VapiWebhookPayload;

  try {
    payload = JSON.parse(body);
  } catch {
    sendJsonResponse(res, 400, { error: 'Invalid JSON' });
    return;
  }

  const callId = payload.call?.id;
  logger.info(`📞 [${INSTANCE_ID}] Vapi webhook: type=${payload.type}, callId=${callId}`);

  switch (payload.type) {
    case 'assistant-request': {
      // Vapi is requesting our assistant config — return it
      // This is used in "server URL" mode where Vapi calls us for every turn
      sendJsonResponse(res, 200, {
        assistant: {
          firstMessage: '', // We generate the greeting dynamically
          model: {
            provider: 'custom-llm',
            url: `http://localhost:${GATEWAY_PORT}/vapi/webhook`,
            model: 'one2b-agent',
          },
          voice: {
            provider: 'elevenlabs',
            voiceId: process.env.ELEVENLABS_VOICE_ID || 'default',
          },
        },
      });
      return;
    }

    case 'conversation-update':
    case 'model-output': {
      // Custom LLM mode: Vapi sends conversation, we respond
      const messages = payload.messages || [];

      if (messages.length === 0) {
        sendJsonResponse(res, 200, { output: { content: '' } });
        return;
      }

      try {
        // Build request context with call metadata
        const requestContext = new RequestContext();
        requestContext.set('channel', 'voice');
        if (callId) requestContext.set('callId', callId);
        if (payload.call?.metadata?.userId) {
          requestContext.set('userId', payload.call.metadata.userId);
        }
        if (payload.call?.metadata?.authToken) {
          requestContext.set('authToken', payload.call.metadata.authToken);
        }

        // Convert Vapi messages to Mastra message format
        const agentMessages = messages
          .filter(m => m.role === 'user' || m.role === 'assistant' || m.role === 'system')
          .map(m => ({
            role: m.role as 'user' | 'assistant' | 'system',
            content: m.content,
          }));

        // If this is the first message (no user messages yet), generate a greeting
        const hasUserMessage = agentMessages.some(m => m.role === 'user');
        if (!hasUserMessage) {
          // Add contact context if available from call metadata
          const contactName = payload.call?.metadata?.contactName || payload.call?.customer?.name;
          if (contactName) {
            agentMessages.push({
              role: 'system' as const,
              content: `A new call has connected. The contact's name is ${contactName}. ` +
                `Use the research-contact tool to look them up, then greet them warmly and personally.`,
            });
          } else {
            agentMessages.push({
              role: 'system' as const,
              content: 'A new call has connected. Greet the caller warmly and ask who you are speaking with.',
            });
          }
        }

        const result = await one2bAgent.generate(agentMessages, { requestContext });
        const responseText = typeof result.text === 'string' ? result.text : '';

        // Update call record
        if (callId && activeCalls.has(callId)) {
          const call = activeCalls.get(callId)!;
          call.status = 'in_progress';
        }

        // Return in Vapi's expected format for custom LLM
        sendJsonResponse(res, 200, {
          output: {
            content: responseText,
          },
        });
      } catch (error) {
        logger.error(`❌ [${INSTANCE_ID}] Agent error:`, error);
        captureException(error as Error);
        sendJsonResponse(res, 200, {
          output: {
            content: "I apologize, I'm having a brief technical issue. Could you repeat that?",
          },
        });
      }
      return;
    }

    case 'function-call': {
      // Vapi detected a function call from the LLM — execute it
      // Note: In custom LLM mode, tool calls are handled internally by the agent
      // This is for Vapi's native function-calling mode
      logger.info(`🔧 [${INSTANCE_ID}] Function call: ${payload.functionCall?.name}`);
      sendJsonResponse(res, 200, { result: 'Function calls handled internally by agent' });
      return;
    }

    case 'end-of-call-report': {
      // Call ended — persist summary
      logger.info(`📋 [${INSTANCE_ID}] Call ended: ${callId}, reason: ${payload.endedReason}`);

      if (callId && activeCalls.has(callId)) {
        const call = activeCalls.get(callId)!;
        call.status = 'completed';
        call.endedAt = new Date().toISOString();
        call.summary = payload.summary;
      }

      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    case 'hang': {
      // Call was hung up
      if (callId && activeCalls.has(callId)) {
        const call = activeCalls.get(callId)!;
        call.status = 'completed';
        call.endedAt = new Date().toISOString();
      }
      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    case 'status-update': {
      // Call status changed
      logger.info(`📊 [${INSTANCE_ID}] Call status update: ${callId}`);
      sendJsonResponse(res, 200, { ok: true });
      return;
    }

    default: {
      logger.warn(`⚠️ [${INSTANCE_ID}] Unknown Vapi webhook type: ${payload.type}`);
      sendJsonResponse(res, 200, { ok: true });
      return;
    }
  }
}

// ─── Outbound call initiation ──────────────────────────────────────────────

async function handleInitiateCall(req: IncomingMessage, res: ServerResponse): Promise<void> {
  const authToken = extractAuthToken(req);
  const userId = verifyAndExtractUserId(authToken);

  const body = JSON.parse(await readBody(req));
  const { contactName, contactPhone, company, linkedinUrl, metadata } = body;

  if (!contactPhone) {
    sendJsonResponse(res, 400, { error: 'contactPhone is required' });
    return;
  }

  if (!VAPI_API_KEY) {
    sendJsonResponse(res, 503, { error: 'VAPI_API_KEY not configured' });
    return;
  }

  if (!VAPI_PHONE_NUMBER_ID) {
    sendJsonResponse(res, 503, { error: 'VAPI_PHONE_NUMBER_ID not configured' });
    return;
  }

  const callId = randomUUID();
  logger.info(`📞 [${INSTANCE_ID}] Initiating outbound call to ${contactName || contactPhone}`);

  // Create call record
  const callRecord: CallRecord = {
    id: callId,
    contactName: contactName || 'Unknown',
    contactPhone,
    direction: 'outbound',
    status: 'initiated',
    startedAt: new Date().toISOString(),
    metadata: {
      ...metadata,
      userId,
      contactName,
      company,
      linkedinUrl,
      authToken,
    },
  };
  activeCalls.set(callId, callRecord);

  try {
    // Initiate call via Vapi API
    const vapiResponse = await fetch('https://api.vapi.ai/call/phone', {
      method: 'POST',
      headers: {
        'Authorization': `Bearer ${VAPI_API_KEY}`,
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        phoneNumberId: VAPI_PHONE_NUMBER_ID,
        customer: {
          number: contactPhone,
          name: contactName,
        },
        assistant: {
          model: {
            provider: 'custom-llm',
            url: `${process.env.VOICE_GATEWAY_PUBLIC_URL || `http://localhost:${GATEWAY_PORT}`}/vapi/webhook`,
            model: 'one2b-agent',
          },
          voice: {
            provider: 'elevenlabs',
            voiceId: process.env.ELEVENLABS_VOICE_ID || 'default',
          },
          firstMessage: '', // Agent generates the greeting
          metadata: callRecord.metadata,
        },
      }),
    });

    if (!vapiResponse.ok) {
      const errorText = await vapiResponse.text();
      logger.error(`❌ [${INSTANCE_ID}] Vapi call initiation failed: ${vapiResponse.status} - ${errorText}`);
      callRecord.status = 'failed';
      sendJsonResponse(res, 502, { error: 'Failed to initiate call', details: errorText });
      return;
    }

    const vapiData = (await vapiResponse.json()) as { id: string };
    callRecord.vapiCallId = vapiData.id;

    logger.info(`✅ [${INSTANCE_ID}] Call initiated: ${callId} (vapi: ${vapiData.id})`);
    sendJsonResponse(res, 200, {
      callId,
      vapiCallId: vapiData.id,
      status: 'initiated',
      message: `Calling ${contactName || contactPhone}...`,
    });
  } catch (error) {
    logger.error(`❌ [${INSTANCE_ID}] Call initiation error:`, error);
    callRecord.status = 'failed';
    captureException(error as Error);
    sendJsonResponse(res, 500, { error: 'Failed to initiate call' });
  }
}

// ─── Call status & listing ──────────────────────────────────────────────────

function handleCallStatus(req: IncomingMessage, res: ServerResponse, callId: string): void {
  const call = activeCalls.get(callId);
  if (!call) {
    sendJsonResponse(res, 404, { error: 'Call not found' });
    return;
  }
  sendJsonResponse(res, 200, call);
}

function handleListCalls(req: IncomingMessage, res: ServerResponse): void {
  const calls = Array.from(activeCalls.values())
    .sort((a, b) => new Date(b.startedAt).getTime() - new Date(a.startedAt).getTime())
    .slice(0, 50);
  sendJsonResponse(res, 200, { calls });
}

// ─── HTTP server ────────────────────────────────────────────────────────────

let httpServer: Server | null = null;

async function handleRequest(req: IncomingMessage, res: ServerResponse): Promise<void> {
  setCorsHeaders(req, res);

  if (req.method === 'OPTIONS') {
    res.writeHead(204);
    res.end();
    return;
  }

  const url = new URL(req.url || '/', `http://localhost:${GATEWAY_PORT}`);
  const pathname = url.pathname;

  try {
    // Vapi webhook — no JWT auth (Vapi authenticates via its own mechanism)
    if (pathname === '/vapi/webhook' && req.method === 'POST') {
      await handleVapiWebhook(req, res);
      return;
    }

    // All other endpoints require JWT auth
    if (pathname === '/call/initiate' && req.method === 'POST') {
      await handleInitiateCall(req, res);
      return;
    }

    // GET /call/:id/status
    const callStatusMatch = pathname.match(/^\/call\/([^/]+)\/status$/);
    if (callStatusMatch && req.method === 'GET') {
      handleCallStatus(req, res, callStatusMatch[1]);
      return;
    }

    // GET /calls
    if (pathname === '/calls' && req.method === 'GET') {
      handleListCalls(req, res);
      return;
    }

    sendJsonResponse(res, 404, { error: 'Not found' });
  } catch (error) {
    handleGatewayError(error, res);
  }
}

export async function startVoiceGateway(): Promise<void> {
  if (!process.env.ENABLE_VOICE_GATEWAY || process.env.ENABLE_VOICE_GATEWAY !== 'true') {
    logger.info('🔇 Voice gateway disabled (set ENABLE_VOICE_GATEWAY=true to enable)');
    return;
  }

  if (!VAPI_API_KEY) {
    logger.warn('⚠️ VAPI_API_KEY not configured — outbound calls will not work');
  }

  httpServer = createServer(handleRequest);

  return new Promise((resolve) => {
    httpServer!.listen(GATEWAY_PORT, '0.0.0.0', () => {
      logger.info(`🎙️ [${INSTANCE_ID}] Voice Gateway running at http://localhost:${GATEWAY_PORT}`);
      logger.info(`   POST   /vapi/webhook     — Vapi webhook handler`);
      logger.info(`   POST   /call/initiate    — Initiate outbound call`);
      logger.info(`   GET    /call/:id/status  — Check call status`);
      logger.info(`   GET    /calls            — List recent calls`);
      resolve();
    });
  });
}

export async function cleanupVoiceGateway(): Promise<void> {
  if (httpServer) {
    return new Promise((resolve) => {
      httpServer!.close(() => {
        logger.info(`🔇 [${INSTANCE_ID}] Voice Gateway shut down`);
        resolve();
      });
    });
  }
}
