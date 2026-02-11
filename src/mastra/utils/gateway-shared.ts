import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { createLogger } from '@mastra/core/logger';

const logger = createLogger({
  name: 'GatewayShared',
  level: 'info',
});

// ─── Error types ────────────────────────────────────────────────────────────

export type GatewayErrorCode =
  | 'AUTH_SECRET_NOT_CONFIGURED'
  | 'TOKEN_EXPIRED'
  | 'TOKEN_INVALID'
  | 'TOKEN_MISSING_USERID'
  | 'MAX_SESSIONS_REACHED';

export class GatewayError extends Error {
  code: GatewayErrorCode;

  constructor(code: GatewayErrorCode, message: string) {
    super(message);
    this.code = code;
    this.name = 'GatewayError';
  }
}

// ─── JWT types & verification ───────────────────────────────────────────────

export interface JWTPayload {
  userId: string;
  sub: string;
  email?: string | null;
  name?: string | null;
  tokenType: string;
  aud: string;
  iss: string;
}

export function verifyAndExtractUserId(token: string): string {
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

// ─── Token encryption ───────────────────────────────────────────────────────

const ENCRYPTION_ALGORITHM = 'aes-256-gcm';

export function encryptToken(token: string, secret: string): string {
  const salt = crypto.randomBytes(16);
  const key = crypto.scryptSync(secret, salt, 32);
  const iv = crypto.randomBytes(16);
  const cipher = crypto.createCipheriv(ENCRYPTION_ALGORITHM, key, iv);

  let encrypted = cipher.update(token, 'utf8', 'hex');
  encrypted += cipher.final('hex');
  const authTag = cipher.getAuthTag();

  return `${salt.toString('hex')}:${iv.toString('hex')}:${authTag.toString('hex')}:${encrypted}`;
}

export function decryptToken(encrypted: string, secret: string): string | null {
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

// ─── Agent routing ──────────────────────────────────────────────────────────

export type AgentIdentifier = 'weather' | 'pierre' | 'ash' | 'paddy' | 'zoe' | 'assistant';

export interface ParsedMessage {
  text: string;
  agent: AgentIdentifier | null;
}

const AGENT_ALIASES: Record<string, AgentIdentifier> = {
  'weather': 'weather',
  'pierre': 'pierre',
  'ash': 'ash',
  'paddy': 'paddy',
  'zoe': 'zoe',
  'assistant': 'assistant',
};

export function parseMessageForMention(text: string): ParsedMessage {
  const match = text.match(/^@(\w+)\s*/i);
  if (!match) {
    return { text, agent: null };
  }

  const mention = match[1].toLowerCase();
  const agent = AGENT_ALIASES[mention] || null;
  const cleanText = text.substring(match[0].length).trim();

  return { text: cleanText || text, agent };
}

// ─── Message splitting ──────────────────────────────────────────────────────

export function splitMessage(message: string, maxLength: number): string[] {
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

// ─── HTTP helpers ───────────────────────────────────────────────────────────

export function sendJsonResponse(res: any, statusCode: number, body: unknown): void {
  res.writeHead(statusCode, { 'Content-Type': 'application/json' });
  res.end(JSON.stringify(body));
}

export function handleGatewayError(error: unknown, res: any): void {
  if (error instanceof GatewayError) {
    if (
      error.code === 'TOKEN_EXPIRED' ||
      error.code === 'TOKEN_INVALID' ||
      error.code === 'TOKEN_MISSING_USERID' ||
      error.code === 'AUTH_SECRET_NOT_CONFIGURED'
    ) {
      sendJsonResponse(res, 401, { error: error.message });
      return;
    }
    if (error.code === 'MAX_SESSIONS_REACHED') {
      sendJsonResponse(res, 409, { error: error.message });
      return;
    }
  }
  const message = error instanceof Error ? error.message : 'Internal server error';
  sendJsonResponse(res, 400, { error: message });
}
