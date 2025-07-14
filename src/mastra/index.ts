
import { Mastra } from '@mastra/core/mastra';
import { createLogger } from '@mastra/core/logger';
import { weatherAgent, ashAgent, pierreAgent, projectManagerAgent } from './agents';

export const mastra = new Mastra({
  agents: { weatherAgent, ashAgent, pierreAgent, projectManagerAgent },
  logger: createLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
