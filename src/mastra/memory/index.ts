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
    },
  },
});
