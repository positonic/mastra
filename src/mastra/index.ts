
import { Mastra } from '@mastra/core/mastra';
import { createLogger } from '@mastra/core/logger';
import { weatherWorkflow } from './workflows';
import { weatherAgent, ashAgent } from './agents';

export const mastra = new Mastra({
  workflows: { weatherWorkflow },
  agents: { weatherAgent, ashAgent },
  logger: createLogger({
    name: 'Mastra',
    level: 'info',
  }),
});
