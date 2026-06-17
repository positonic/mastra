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
    // Conversational recall window. The exponential chat route
    // (src/app/api/chat/stream/route.ts) now sends ONLY the latest user
    // message and relies on thread memory to supply prior turns, replacing a
    // client transcript that was trimmed to ~20k tokens. semanticRecall is NOT
    // enabled here (no vector store/embedder), so `lastMessages` is the ONLY
    // recall path — the Mastra default of 10 is too small to cover a multi-turn
    // planning session and silently drops context the transcript used to carry.
    // 40 restores parity with the prior working set. If this is lowered, the
    // chat route's "prior turns come from thread memory" assumption breaks.
    lastMessages: 40,
    observationalMemory: {
      // Thread scope, NOT resource scope. Async consolidation buffering
      // exists ONLY under thread scope — Mastra's validateBufferConfig throws
      // if buffer fields are set under resource scope, so resource scope is
      // synchronous-only by design. That synchronous consolidation was the
      // ~86s/step tax that made a one-action insert take ~2min (see
      // exponential docs/adr/0015). Under thread scope the framework's default
      // async buffering applies (observation.bufferTokens 0.2 /
      // bufferActivation 0.8, reflection.bufferActivation 0.5) — do NOT
      // hand-set those buffer fields here; setting them is what throws.
      //
      // Trade-off: observations no longer carry across threads (recall WITHIN
      // a thread still works). Cross-conversation memory is deferred to
      // out-of-band consolidation (ADR-0015 / ticket outer.cove).
      scope: 'thread',
      // Flush buffered observations after 5m idle to align with the Anthropic
      // prompt-cache TTL, so a returning user's next turn sees consolidated
      // memory without a blocking in-turn call.
      activateAfterIdle: '5m',
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
