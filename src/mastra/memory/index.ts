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
      model: 'openai/gpt-4o-mini',
      observation: {
        messageTokens: 30_000,
      },
      reflection: {
        observationTokens: 40_000,
      },
    },
  },
});
