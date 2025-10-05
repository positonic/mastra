
import { Mastra } from '@mastra/core/mastra';
import { createLogger } from '@mastra/core/logger';
import { weatherAgent, ashAgent, pierreAgent, projectManagerAgent, curationAgent } from './agents';
import { createTelegramBot } from './bots/ostrom-telegram.js';

export const mastra = new Mastra({
  agents: { weatherAgent, ashAgent, pierreAgent, projectManagerAgent, curationAgent },
  logger: createLogger({
    name: 'Mastra',
    level: 'info',
  }),
});

// Initialize Telegram bot
export const telegramBot = createTelegramBot();
