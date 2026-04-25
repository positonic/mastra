import { Mastra } from '@mastra/core/mastra';
import { MASTRA_RESOURCE_ID_KEY } from '@mastra/core/request-context';
import { weatherAgent, ashAgent, pierreAgent, projectManagerAgent, zoeAgent, expoAgent, assistantAgent, platformAgent, one2bAgent } from './agents';
import { memory } from './memory/index.js';
import { createLogger } from './utils/logger.js';
import { createTelegramBot, cleanupTelegramBot } from './bots/ostrom-telegram.js';
import { createTelegramGateway, cleanupTelegramGateway } from './bots/telegram-gateway.js';
import { createWhatsAppGateway, cleanupWhatsAppGateway } from './bots/whatsapp-gateway.js';
import { startSignalGateway, getSignalGateway } from './bots/signal-gateway.js';
import { startVoiceGateway, cleanupVoiceGateway } from './bots/voice-gateway.js';
import { initSentry, captureException, flushSentry } from './utils/sentry.js';
import { assertAgentsValid } from './utils/validate-agents.js';
import { startScheduler, stopScheduler, triggerCheck, deliverWhatsAppBriefings } from './proactive/index.js';
import jwt from 'jsonwebtoken';
import { createHmac, timingSafeEqual } from 'crypto';

// Initialize Sentry first (before anything else)
initSentry();

const logger = createLogger({
  name: 'Mastra',
  level: 'info',
});

const isDev = process.env.NODE_ENV !== 'production';

const agents = { zoeAgent, weatherAgent, ashAgent, pierreAgent, projectManagerAgent, expoAgent, assistantAgent, platformAgent, one2bAgent };

// Fail fast if any agent's system prompt is missing or malformed.
// Protects against the class of bug where instructions are assigned a
// non-string value and silently break downstream consumers.
assertAgentsValid(agents, logger);

export const mastra = new Mastra({
  agents,
  memory: { default: memory },
  logger: logger.raw,
  server: {
    port: parseInt(process.env.PORT || '4111', 10),
    host: '0.0.0.0', // Required for Railway deployment
    apiRoutes: [
      {
        path: '/api/proactive/trigger',
        method: 'POST',
        createHandler: async () => async (c: any) => {
          const expectedSecret = process.env.PROACTIVE_TRIGGER_SECRET;
          
          if (!expectedSecret) {
            logger.error('PROACTIVE_TRIGGER_SECRET not configured');
            return c.json({ error: 'Endpoint not configured' }, 503);
          }
          
          const secret = c.req.header('X-Trigger-Secret');
          // Use constant-time comparison to prevent timing attacks
          const hmacKey = process.env.HMAC_KEY || 'mastra-default-hmac-key';
          const h1 = createHmac('sha256', hmacKey).update(secret || '').digest();
          const h2 = createHmac('sha256', hmacKey).update(expectedSecret).digest();
          const match = timingSafeEqual(h1, h2);
          if (!match) {
            return c.json({ error: 'Unauthorized' }, 401);
          }
          
          try {
            const body = await c.req.json().catch(() => ({}));
            const type = body.type || 'evening';

            if (type === 'whatsapp-briefing') {
              const stats = await deliverWhatsAppBriefings();
              return c.json({ success: true, message: 'WhatsApp briefing delivery complete', stats });
            }

            await triggerCheck(type);

            // Also deliver WhatsApp briefings for morning triggers
            let whatsappStats = null;
            if (type === 'morning') {
              whatsappStats = await deliverWhatsAppBriefings();
            }

            return c.json({
              success: true,
              message: 'Proactive check completed',
              whatsappBriefings: whatsappStats,
            });
          } catch (error) {
            logger.error('Proactive trigger failed:', error);
            return c.json({ error: 'Check failed' }, 500);
          }
        },
      },
    ],
    middleware: [
      async (c: any, next: any) => {
          const requestContext = c.get('requestContext');

          // Use auth header if present; in dev only, fall back to test JWT
          const authHeader = c.req.header('Authorization');
          const token = authHeader?.replace('Bearer ', '')
            || (isDev ? process.env.EXPONENTIAL_TEST_JWT : undefined);

          if (token) {
            requestContext.set('authToken', token);

            // Verify JWT and extract userId. When AUTH_SECRET is available,
            // we cryptographically verify the token instead of blindly trusting it.
            // This prevents forged JWTs from accessing another user's memory scope.
            const authSecret = process.env.AUTH_SECRET;
            try {
              if (authSecret) {
                const payload = jwt.verify(token, authSecret, {
                  audience: process.env.JWT_AUDIENCE ?? 'mastra-agents',
                  issuer: process.env.JWT_ISSUER ?? 'todo-app',
                }) as { userId?: string; sub?: string };
                const userId = payload.userId || payload.sub;
                if (userId) {
                  requestContext.set('userId', userId);
                  requestContext.set(MASTRA_RESOURCE_ID_KEY, userId);
                }
              } else {
                // No AUTH_SECRET — decode without verification (dev/legacy fallback)
                logger.warn(
                  'JWT decoded WITHOUT VERIFICATION (AUTH_SECRET not set)',
                  { env: process.env.NODE_ENV, hasToken: true }
                );
                const payload = JSON.parse(atob(token.split('.')[1]));
                const fallbackUserId = payload.userId || payload.sub;
                if (fallbackUserId) {
                  requestContext.set('userId', fallbackUserId);
                  requestContext.set(MASTRA_RESOURCE_ID_KEY, fallbackUserId);
                }
              }
            } catch {
              // Token verification/decode failed — authToken still set for tool-level auth
            }
          }

          // In dev, inject page context that Exponential normally sends
          if (isDev) {
            if (process.env.EXPONENTIAL_TEST_WORKSPACE_ID && !requestContext.get('workspaceId')) {
              requestContext.set('workspaceId', process.env.EXPONENTIAL_TEST_WORKSPACE_ID);
            }
            if (process.env.EXPONENTIAL_TEST_PROJECT_ID && !requestContext.get('projectId')) {
              requestContext.set('projectId', process.env.EXPONENTIAL_TEST_PROJECT_ID);
            }
          }

          await next();
      },
    ],
  },
});

// Initialize Telegram bot (disabled by default locally to avoid conflicts with production)
const enableTelegram = process.env.ENABLE_TELEGRAM_BOT === 'true';
export const telegramBot = enableTelegram ? createTelegramBot() : null;
if (!enableTelegram) {
  logger.info('📵 [MAIN] Telegram bot disabled (set ENABLE_TELEGRAM_BOT=true to enable)');
}

// Initialize Telegram gateway (multi-tenant, for Exponential app users)
const enableTelegramGateway = process.env.ENABLE_TELEGRAM_GATEWAY === 'true';
export const telegramGateway = enableTelegramGateway ? createTelegramGateway() : null;
if (!enableTelegramGateway) {
  logger.info('📵 [MAIN] Telegram gateway disabled (set ENABLE_TELEGRAM_GATEWAY=true to enable)');
}

// Initialize WhatsApp gateway
export const whatsAppGateway = createWhatsAppGateway();

// Initialize Signal gateway
const enableSignalGateway = process.env.ENABLE_SIGNAL_GATEWAY === 'true';
if (enableSignalGateway) {
  startSignalGateway().catch(err => {
    logger.error('❌ [MAIN] Failed to start Signal gateway:', err);
  });
} else {
  logger.info('📵 [MAIN] Signal gateway disabled (set ENABLE_SIGNAL_GATEWAY=true to enable)');
}

// Initialize Voice gateway (Vapi + ElevenLabs for One2b)
startVoiceGateway().catch(err => {
  logger.error('❌ [MAIN] Failed to start Voice gateway:', err);
});

// Start proactive scheduler (checks projects and notifies users)
const enableProactive = process.env.ENABLE_PROACTIVE_SCHEDULER !== 'false';
if (enableProactive) {
  startScheduler();
} else {
  logger.info('📵 [MAIN] Proactive scheduler disabled (set ENABLE_PROACTIVE_SCHEDULER=true to enable)');
}

// Add graceful shutdown handling
const shutdown = async (signal: string, error?: Error) => {
  logger.info(`🛑 [MAIN] Received ${signal}, starting graceful shutdown...`);

  try {
    // Capture error to Sentry if provided
    if (error) {
      captureException(error, { operation: `shutdown:${signal}` });
    }

    // Cleanup bots and gateways
    if (enableTelegram) {
      await cleanupTelegramBot();
    }
    if (enableTelegramGateway) {
      await cleanupTelegramGateway();
    }
    await cleanupWhatsAppGateway();
    await cleanupVoiceGateway();

    // Cleanup Signal gateway
    const signalGw = getSignalGateway();
    if (signalGw) {
      await signalGw.shutdown();
    }
    
    // Stop proactive scheduler
    stopScheduler();

    // Flush Sentry events before exit
    await flushSentry();

    logger.info(`✅ [MAIN] Graceful shutdown completed`);
    process.exit(error ? 1 : 0);
  } catch (shutdownError) {
    logger.error('🚨 [MAIN] Error during shutdown:', shutdownError);
    captureException(shutdownError, { operation: 'shutdown:error' });
    await flushSentry();
    process.exit(1);
  }
};

// Register shutdown handlers
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  logger.error('🚨 [MAIN] Uncaught exception:', error);
  captureException(error, { operation: 'uncaughtException' });
  shutdown('UNCAUGHT_EXCEPTION', error);
});
process.on('unhandledRejection', (reason, promise) => {
  logger.error('🚨 [MAIN] Unhandled rejection', { promise, reason });
  const error = reason instanceof Error ? reason : new Error(String(reason));
  captureException(error, { operation: 'unhandledRejection' });
  shutdown('UNHANDLED_REJECTION', error);
});

logger.info(`🚀 [MAIN] Mastra initialized with PID ${process.pid}`);
