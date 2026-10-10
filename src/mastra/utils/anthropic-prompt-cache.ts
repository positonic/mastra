import { wrapLanguageModel } from 'ai';
import { createLogger, type AppLogger } from './logger.js';

/**
 * Applies Anthropic prompt-cache breakpoints AND defers loading of custom
 * tool schemas on every request.
 *
 * Three independent optimisations:
 *
 * 1. **`cacheControl: ephemeral` on the first system message** (the static
 *    agent instructions). See the comment in `transformParams` for why the
 *    memory-injected system messages are left untagged.
 *
 * 2. **`cacheControl: ephemeral` on the last non-system message** — a
 *    rolling breakpoint over the conversation. Without it only the system
 *    prompt is cached, and every step of a tool loop (tool search → tool
 *    call → answer) re-sends the memory system messages, up to 40 history
 *    messages and the loaded tool definitions at full price. With it, each
 *    step reads everything up to the previous step from cache. Uses 2 of
 *    Anthropic's 4 breakpoints.
 *
 * 3. **`deferLoading: true` on every custom (function) tool.** Anthropic's
 *    deferred-loading feature keeps tool definitions out of the prompt
 *    until the model retrieves them via the `tool_search_tool_bm25` (or
 *    `_regex`) provider tool. With ~63 tools (~25K tokens of schemas) on
 *    Zoe, deferring drops a "hi" turn from ~80K to ~15-20K input tokens.
 *    Provider tools (`anthropic.tool_search_bm25_*`,
 *    `anthropic.web_search_*`, etc.) are NOT deferred — `tool.type ===
 *    "function"` is the discriminator. The agent must include
 *    `anthropic.tools.toolSearchBm25_20251119()` in its tools so the model
 *    can discover deferred tools at runtime.
 *
 * Implemented as middleware (rather than stashing message objects in
 * Agent.instructions or per-tool overrides) so that Agent.instructions
 * remains a plain string — keeping agent listing, similarity-based
 * routing, and every other consumer of the field working correctly — and
 * so that no tool definition file needs editing.
 */
export const anthropicPromptCacheMiddleware = {
  specificationVersion: 'v3' as const,
  transformParams: async ({
    params,
  }: {
    params: { prompt: readonly unknown[]; tools?: readonly unknown[] };
  }) => {
    const withAnthropicProviderOption = <K extends string, V>(
      msg: Record<string, unknown>,
      key: K,
      value: V,
    ): Record<string, unknown> => {
      const existing = (msg.providerOptions as Record<string, unknown> | undefined) ?? {};
      const existingAnthropic =
        (existing.anthropic as Record<string, unknown> | undefined) ?? {};
      return {
        ...msg,
        providerOptions: {
          ...existing,
          anthropic: {
            ...existingAnthropic,
            [key]: value,
          },
        },
      };
    };

    // Tag ONLY the first system message. Mastra's memory layer
    // (@mastra/core: messageList.addSystem(..., 'memory')) injects
    // additional system messages every turn with semantic-recall results
    // — those are volatile per turn. If we mark them with cache_control,
    // the cached prefix includes volatile content and busts on every
    // turn (observed in production: cache_creation = 11,815 on every
    // turn, cache_read = 0). Marking only the first system message
    // (agent SOUL — static const string) keeps the cached prefix stable.
    // Memory-injected system messages still ship in the prompt; they
    // just sit after the cache breakpoint and don't affect matching.
    let firstSystemTagged = false;
    const prompt = (params.prompt as Array<Record<string, unknown>>).map((msg) => {
      if ((msg as { role?: string }).role !== 'system') return msg;
      if (firstSystemTagged) return msg;
      firstSystemTagged = true;
      return withAnthropicProviderOption(msg, 'cacheControl', { type: 'ephemeral' as const });
    });

    // Rolling breakpoint on the last non-system message. The provider puts a
    // message-level cacheControl on that message's last content part (user
    // text, tool result, or assistant text), so the whole prefix through the
    // newest turn is written and the next step in the loop reads it back.
    let lastIndex = prompt.length - 1;
    while (lastIndex >= 0 && (prompt[lastIndex] as { role?: string }).role === 'system') {
      lastIndex--;
    }
    if (lastIndex >= 0) {
      prompt[lastIndex] = withAnthropicProviderOption(prompt[lastIndex], 'cacheControl', {
        type: 'ephemeral' as const,
      });
    }

    let tools = params.tools;
    let providerOptions = (params as { providerOptions?: Record<string, unknown> })
      .providerOptions;
    if (Array.isArray(tools) && tools.length > 0) {
      // Only defer custom tools when the agent ALSO registers an
      // Anthropic tool-search provider tool. Without one, deferred tools
      // are unfindable and the agent breaks. This makes the middleware
      // safe to apply to agents with no tool-search wiring.
      const hasToolSearch = (tools as Array<Record<string, unknown>>).some(
        (t) =>
          (t as { type?: string }).type === 'provider' &&
          typeof (t as { id?: string }).id === 'string' &&
          ((t as { id: string }).id.includes('tool_search_bm25') ||
            (t as { id: string }).id.includes('tool_search_regex')),
      );
      if (hasToolSearch) {
        tools = (tools as Array<Record<string, unknown>>).map((tool) =>
          (tool as { type?: string }).type === 'function'
            ? withAnthropicProviderOption(tool, 'deferLoading', true)
            : tool,
        );

        // tool_search_bm25/regex requires the `advanced-tool-use-2025-11-20`
        // beta header. As of @ai-sdk/anthropic 3.0.71 the provider does NOT
        // auto-add this beta (compare web_search_*, which does). Without it
        // Anthropic 400s the request server-side; Mastra surfaces no error
        // and the client stream stalls until idle timeout.
        // See: https://platform.claude.com/docs/en/agents-and-tools/tool-use/tool-search-tool
        const existingTop = providerOptions ?? {};
        const existingAnthropic =
          (existingTop.anthropic as Record<string, unknown> | undefined) ?? {};
        const existingBetas =
          (existingAnthropic.anthropicBeta as string[] | undefined) ?? [];
        const required = 'advanced-tool-use-2025-11-20';
        if (!existingBetas.includes(required)) {
          providerOptions = {
            ...existingTop,
            anthropic: {
              ...existingAnthropic,
              anthropicBeta: [...existingBetas, required],
            },
          };
        }
      }
    }

    return { ...params, prompt, tools, providerOptions };
  },
};

/**
 * Strips `topP` when `temperature` is also set. Anthropic rejects both
 * together, and Mastra's playground sends both by default.
 */
export const stripTopPWhenTemperatureSetMiddleware = {
  specificationVersion: 'v3' as const,
  transformParams: async ({
    params,
  }: {
    params: { temperature?: number | null; topP?: number | null };
  }) => {
    if (params.temperature != null && params.topP != null) {
      const { topP: _topP, ...rest } = params;
      return rest;
    }
    return params;
  },
};

type InputUsage = {
  total?: number;
  noCache?: number;
  cacheRead?: number;
  cacheWrite?: number;
};

const cacheLogger = createLogger({ name: 'PromptCache', level: 'info' });

/**
 * Logs one line per model call with the cache split of its input tokens, so
 * the hit rate can be measured from Railway logs (`grep "prompt-cache usage"`).
 * `hitRate` = cacheRead / total input.
 */
export function logPromptCacheUsage(
  modelId: string,
  inputTokens: InputUsage | undefined,
  log: Pick<AppLogger, 'info'> = cacheLogger,
): void {
  if (!inputTokens) return;
  const total = inputTokens.total ?? 0;
  const cacheRead = inputTokens.cacheRead ?? 0;
  log.info('prompt-cache usage', {
    modelId,
    inputTotal: total,
    noCache: inputTokens.noCache ?? 0,
    cacheRead,
    cacheWrite: inputTokens.cacheWrite ?? 0,
    hitRate: total > 0 ? Number((cacheRead / total).toFixed(3)) : 0,
  });
}

/** Middleware that reports per-call cache usage via `logPromptCacheUsage`. */
export const promptCacheUsageLoggingMiddleware = {
  specificationVersion: 'v3' as const,
  wrapGenerate: async ({
    doGenerate,
    model,
  }: {
    doGenerate: () => PromiseLike<{ usage?: { inputTokens?: InputUsage } }>;
    model: { modelId: string };
  }) => {
    const result = await doGenerate();
    logPromptCacheUsage(model.modelId, result.usage?.inputTokens);
    return result;
  },
  wrapStream: async ({
    doStream,
    model,
  }: {
    doStream: () => PromiseLike<{ stream: ReadableStream<{ type: string }> }>;
    model: { modelId: string };
  }) => {
    const result = await doStream();
    const stream = result.stream.pipeThrough(
      new TransformStream<{ type: string }, { type: string }>({
        transform(chunk, controller) {
          if (chunk.type === 'finish') {
            const usage = (chunk as { usage?: { inputTokens?: InputUsage } }).usage;
            logPromptCacheUsage(model.modelId, usage?.inputTokens);
          }
          controller.enqueue(chunk);
        },
      }),
    );
    return { ...result, stream };
  },
};

/**
 * Wraps an Anthropic language model with the project-standard middleware
 * stack: strip topP conflicts, apply prompt caching (system prompt + rolling
 * conversation breakpoint), and log per-call cache usage. Use for every Anthropic-backed agent with a long static prompt.
 *
 * Return type is intentionally inferred — the `ai` SDK's V3 types and
 * Mastra's V2 types are structurally compatible but nominally distinct;
 * letting the compiler infer avoids a cross-package V2↔V3 mismatch.
 */
export function withAnthropicPromptCache<M>(model: M): M {
  return wrapLanguageModel({
    model: model as never,
    middleware: [
      stripTopPWhenTemperatureSetMiddleware as never,
      anthropicPromptCacheMiddleware as never,
      promptCacheUsageLoggingMiddleware as never,
    ],
  }) as unknown as M;
}
