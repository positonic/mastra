import { Mastra } from '@mastra/core/mastra';
import { createLogger } from '@mastra/core/logger';
import { weatherAgent, ashAgent, pierreAgent, projectManagerAgent } from './agents';
import { createTelegramBot, cleanupTelegramBot } from './bots/ostrom-telegram.js';
import { createWhatsAppGateway, cleanupWhatsAppGateway } from './bots/whatsapp-gateway.js';
import { initSentry, captureException, flushSentry } from './utils/sentry.js';

// Initialize Sentry first (before anything else)
initSentry();

const logger = createLogger({
  name: 'Mastra',
  level: 'info',
});

export const mastra = new Mastra({
  agents: { weatherAgent, ashAgent, pierreAgent, projectManagerAgent },
  logger,
  server: {
    port: parseInt(process.env.PORT || '4111', 10),
    host: '0.0.0.0', // Required for Railway deployment
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
