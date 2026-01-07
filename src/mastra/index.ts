
import { Mastra } from '@mastra/core/mastra';
import { createLogger } from '@mastra/core/logger';
import { weatherAgent, ashAgent, pierreAgent, projectManagerAgent } from './agents';
import { createTelegramBot, cleanupTelegramBot } from './bots/ostrom-telegram.js';
import { createWhatsAppGateway, cleanupWhatsAppGateway } from './bots/whatsapp-gateway.js';

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

// Initialize Telegram bot
export const telegramBot = createTelegramBot();

// Initialize WhatsApp gateway
export const whatsAppGateway = createWhatsAppGateway();

// Add graceful shutdown handling
const shutdown = async (signal: string) => {
  logger.info(`🛑 [MAIN] Received ${signal}, starting graceful shutdown...`);
  
  try {
    // Cleanup bots and gateways
    await cleanupTelegramBot();
    await cleanupWhatsAppGateway();

    logger.info(`✅ [MAIN] Graceful shutdown completed`);
    process.exit(0);
  } catch (error) {
    logger.error('🚨 [MAIN] Error during shutdown:', error);
    process.exit(1);
  }
};

// Register shutdown handlers
process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));
process.on('uncaughtException', (error) => {
  logger.error('🚨 [MAIN] Uncaught exception:', error);
  shutdown('UNCAUGHT_EXCEPTION');
});
process.on('unhandledRejection', (reason, promise) => {
  logger.error('🚨 [MAIN] Unhandled rejection at:', promise, 'reason:', reason);
  shutdown('UNHANDLED_REJECTION');
});

logger.info(`🚀 [MAIN] Mastra initialized with PID ${process.pid}`);
