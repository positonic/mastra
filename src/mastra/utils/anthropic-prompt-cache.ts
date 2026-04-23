import { wrapLanguageModel } from 'ai';

/**
 * Applies Anthropic's ephemeral prompt-cache breakpoint to the system
 * message on every request. Anthropic caches everything up to and
 * including the breakpoint (tools + system), so subsequent calls within
 * the ~5-minute TTL bill the prefix as cache_read_input_tokens (~10% of
 * base input rate).
 *
 * This is implemented as middleware (rather than stashing message objects
 * in Agent.instructions) so that Agent.instructions remains a plain string
 * — keeping agent listing, similarity-based routing, and every other
 * consumer of the field working correctly.
 */
export const anthropicPromptCacheMiddleware = {
  specificationVersion: 'v3' as const,
  transformParams: async ({ params }: { params: { prompt: readonly unknown[] } }) => {
    const prompt = (params.prompt as Array<Record<string, unknown>>).map((msg) => {
      if ((msg as { role?: string }).role !== 'system') return msg;
      const existing = (msg.providerOptions as Record<string, unknown> | undefined) ?? {};
      const existingAnthropic =
        (existing.anthropic as Record<string, unknown> | undefined) ?? {};
      return {
        ...msg,
        providerOptions: {
          ...existing,
          anthropic: {
            ...existingAnthropic,
            cacheControl: { type: 'ephemeral' as const },
          },
        },
      };
    });
    return { ...params, prompt };
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

/**
 * Wraps an Anthropic language model with the project-standard middleware
 * stack: strip topP conflicts, then apply prompt caching on the system
 * message. Use for every Anthropic-backed agent with a long static prompt.
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
    ],
  }) as unknown as M;
}
