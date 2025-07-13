
import { Mastra } from '@mastra/core/mastra';
import { createLogger } from '@mastra/core/logger';
import { weatherAgent, ashAgent, pierreAgent } from './agents';

export const mastra = new Mastra({
  agents: { weatherAgent, ashAgent, pierreAgent },
  logger: createLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
