import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';

export const memory = new Memory({
  storage: new PostgresStore({
    id: 'memory',
    connectionString: process.env.DATABASE_URL!,
  }),
  options: {
    observationalMemory: {
      scope: 'resource',
      observation: {
        messageTokens: 1_000, // Low threshold for testing (default: 30_000)
      },
      reflection: {
        observationTokens: 2_000, // Low threshold for testing (default: 40_000)
      },
    },
  },
});
