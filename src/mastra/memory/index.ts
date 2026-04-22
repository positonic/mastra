import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';

export const memory = new Memory({
  storage: new PostgresStore({
    id: 'memory',
    connectionString: process.env.DATABASE_URL!,
    schemaName: 'mastra',
  }),
  options: {
    observationalMemory: {
      scope: 'resource',
      model: 'anthropic/claude-haiku-4-5-20251001',
      observation: {
        messageTokens: 30_000,
      },
      reflection: {
        observationTokens: 40_000,
      },
    },
  },
});
