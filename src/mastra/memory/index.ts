import { Memory } from '@mastra/memory';
import { PostgresStore } from '@mastra/pg';

// Shared store: Memory persistence AND the Mastra instance's top-level
// storage (required by the observability MastraStorageExporter so AI
// tracing spans land in mastra.mastra_ai_spans).
export const storage = new PostgresStore({
  id: 'memory',
  connectionString: process.env.DATABASE_URL!,
  schemaName: 'mastra',
});

export const memory = new Memory({
  storage,
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
