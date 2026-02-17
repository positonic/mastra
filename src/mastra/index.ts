import { Mastra } from '@mastra/core/mastra';
import { createLogger } from '@mastra/core/logger';
import { weatherAgent, ashAgent, pierreAgent, projectManagerAgent, zoeAgent, expoAgent, assistantAgent } from './agents';
import { memory } from './memory/index.js';
import { createTelegramBot, cleanupTelegramBot } from './bots/ostrom-telegram.js';
import { createTelegramGateway, cleanupTelegramGateway } from './bots/telegram-gateway.js';
import { createWhatsAppGateway, cleanupWhatsAppGateway } from './bots/whatsapp-gateway.js';
import { initSentry, captureException, flushSentry } from './utils/sentry.js';
import { startScheduler, stopScheduler, triggerCheck } from './proactive/index.js';

// Initialize Sentry first (before anything else)
initSentry();

const logger = createLogger({
  name: 'Mastra',
  level: 'info',
});

const isDev = process.env.NODE_ENV !== 'production';

export const mastra = new Mastra({
  agents: { zoeAgent, weatherAgent, ashAgent, pierreAgent, projectManagerAgent, expoAgent, assistantAgent },
  memory,
  logger,
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
            console.error('PROACTIVE_TRIGGER_SECRET not configured');
            return c.json({ error: 'Endpoint not configured' }, 503);
          }
          
          const secret = c.req.header('X-Trigger-Secret');
          if (secret !== expectedSecret) {
            return c.json({ error: 'Unauthorized' }, 401);
          }
          
          try {
            await triggerCheck('evening');
            return c.json({ success: true, message: 'Proactive check completed' });
          } catch (error) {
            console.error('Proactive trigger failed:', error);
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

            // Decode JWT payload to extract userId (no verification needed,
            // the Exponential API verifies the token on its end)
            try {
              const payload = JSON.parse(atob(token.split('.')[1]));
              if (payload.userId || payload.sub) {
                requestContext.set('userId', payload.userId || payload.sub);
              }
            } catch {
              // Token decode failed - authToken is still set, tools can try using it
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
  logger.error('🚨 [MAIN] Unhandled rejection at:', promise, 'reason:', reason);
  const error = reason instanceof Error ? reason : new Error(String(reason));
  captureException(error, { operation: 'unhandledRejection' });
  shutdown('UNHANDLED_REJECTION', error);
});

logger.info(`🚀 [MAIN] Mastra initialized with PID ${process.pid}`);
