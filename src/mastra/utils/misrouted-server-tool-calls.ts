import { createLogger } from './logger.js';

/**
 * Repair "misrouted" server-tool calls before a request reaches Anthropic.
 *
 * Anthropic gives every call it runs itself (`web_search`, `web_fetch`, tool
 * search, code execution) a `srvtoolu_` id, and it only accepts that prefix on
 * a `server_tool_use` block. Sometimes the model instead emits an ordinary
 * `tool_use` that happens to be *named* `web_search` — it gets a `toolu_` id
 * and Anthropic never runs it. Mastra then looks the name up with
 * `findProviderToolByName`, finds our provider tool, and `inferProviderExecuted`
 * flags the call as provider-executed because that tool has no `execute`. On
 * the next step the provider converts it to `server_tool_use` with the
 * `toolu_` id, and Anthropic rejects the whole request:
 *
 *   messages.7.content.1.server_tool_use.id: String should match pattern '^srvtoolu_[a-zA-Z0-9_]+$'
 *
 * The user sees "Something went wrong", and because the bad call is stored in
 * the thread, every later turn on that thread dies the same way.
 *
 * The rule is structural, not per-tool (ADR-0001): a provider-executed call
 * whose id lacks `srvtoolu_` was never run by Anthropic, so it is replaced by a
 * short assistant text note — the same shape ADR-0002 uses for failed server
 * tools — and any result paired with it is dropped. If the repaired message
 * ends the prompt, a user turn is appended so the request is not an assistant
 * prefill. Only the outgoing request changes; stored history is untouched, and
 * the repair is re-applied (idempotently) on every step.
 */

const SERVER_TOOL_ID_PREFIX = 'srvtoolu_';

const logger = createLogger({ name: 'MisroutedServerTool', level: 'info' });

type Part = Record<string, unknown> & { type?: unknown };
type PromptMessage = Record<string, unknown> & { role?: unknown; content?: unknown };

function isMisroutedCall(part: Part): boolean {
  return (
    part.type === 'tool-call' &&
    part.providerExecuted === true &&
    typeof part.toolCallId === 'string' &&
    !part.toolCallId.startsWith(SERVER_TOOL_ID_PREFIX)
  );
}

function describeTarget(input: unknown): string {
  if (typeof input !== 'object' || input === null) return '';
  const { query, url } = input as { query?: unknown; url?: unknown };
  if (typeof url === 'string' && url) return ` of ${url}`;
  if (typeof query === 'string' && query) return ` for "${query}"`;
  return '';
}

function noteFor(part: Part): Part {
  const toolName = typeof part.toolName === 'string' ? part.toolName : 'server tool';
  return {
    type: 'text',
    text: `(Attempted ${toolName}${describeTarget(part.input)} — the call was malformed and did not run.)`,
  };
}

/**
 * Pure core: LanguageModelV3 prompt in, prompt out. Returns the same array
 * reference when nothing needed repair.
 */
export function repairMisroutedServerToolCalls<T>(prompt: readonly T[]): readonly T[] {
  const messages = prompt as readonly PromptMessage[];

  const misroutedIds = new Set<string>();
  for (const message of messages) {
    if (message.role !== 'assistant' || !Array.isArray(message.content)) continue;
    for (const part of message.content as Part[]) {
      if (isMisroutedCall(part)) misroutedIds.add(part.toolCallId as string);
    }
  }
  if (misroutedIds.size === 0) return prompt;

  const isPairedResult = (part: Part) =>
    part.type === 'tool-result' &&
    typeof part.toolCallId === 'string' &&
    misroutedIds.has(part.toolCallId);

  const repaired: PromptMessage[] = [];
  for (const message of messages) {
    if (!Array.isArray(message.content)) {
      repaired.push(message);
      continue;
    }
    const parts = message.content as Part[];
    if (!parts.some((p) => isMisroutedCall(p) || isPairedResult(p))) {
      repaired.push(message);
      continue;
    }
    const content = parts
      .filter((p) => !isPairedResult(p))
      .map((p) => (isMisroutedCall(p) ? noteFor(p) : p));
    // A tool message that only carried the dropped result has nothing left.
    if (content.length > 0) repaired.push({ ...message, content });
  }

  if (repaired.at(-1)?.role === 'assistant') {
    repaired.push({
      role: 'user',
      content: [
        {
          type: 'text',
          text: '(The tool call above did not run. Carry on with the reply; you can call the tool again if you still need it.)',
        },
      ],
    });
  }

  logger.warn('repaired misrouted server tool calls', {
    toolCallIds: [...misroutedIds],
  });

  return repaired as unknown as readonly T[];
}

/** Middleware wrapper: applies {@link repairMisroutedServerToolCalls} to every request. */
export const repairMisroutedServerToolCallsMiddleware = {
  specificationVersion: 'v3' as const,
  transformParams: async ({ params }: { params: { prompt: readonly unknown[] } }) => {
    const prompt = repairMisroutedServerToolCalls(params.prompt);
    return prompt === params.prompt ? params : { ...params, prompt };
  },
};
