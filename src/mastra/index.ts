import { Mastra } from '@mastra/core/mastra';
import { createLogger } from '@mastra/core/logger';
import { weatherAgent, ashAgent, pierreAgent, projectManagerAgent, zoeAgent, expoAgent, assistantAgent } from './agents';
import { memory } from './memory/index.js';
import { createTelegramBot, cleanupTelegramBot } from './bots/ostrom-telegram.js';
import { createWhatsAppGateway, cleanupWhatsAppGateway } from './bots/whatsapp-gateway.js';
import { initSentry, captureException, flushSentry } from './utils/sentry.js';

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
    middleware: [
      {
        handler: async (c: any, next: any) => {
          const requestContext = c.get('requestContext');

          // Use auth header if present; in dev only, fall back to TODO_APP_API_KEY
          const authHeader = c.req.header('Authorization');
          const token = authHeader?.replace('Bearer ', '')
            || (isDev ? process.env.TODO_APP_API_KEY : undefined);

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
            if (process.env.DEV_WORKSPACE_ID && !requestContext.get('workspaceId')) {
              requestContext.set('workspaceId', process.env.DEV_WORKSPACE_ID);
            }
            if (process.env.DEV_PROJECT_ID && !requestContext.get('projectId')) {
              requestContext.set('projectId', process.env.DEV_PROJECT_ID);
            }
          }

          await next();
        },
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

// Initialize WhatsApp gateway
export const whatsAppGateway = createWhatsAppGateway();

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
    await cleanupWhatsAppGateway();

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
