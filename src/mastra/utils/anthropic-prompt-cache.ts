import { wrapLanguageModel } from 'ai';

/**
 * Applies Anthropic ephemeral prompt-cache breakpoints on every request.
 *
 * Anthropic caches the request prefix up to each `cache_control` marker.
 * In canonical request order Anthropic processes tools → system → messages,
 * so a single marker on system *should* cover tools too — but in practice
 * we observed cache hit rates of only ~37% on Zoe (Sonnet 4.5), with tools
 * (~25K tokens, 63 schemas) sitting outside the cached prefix and
 * `cache_creation_input_tokens` reported as 0. To force tools into the
 * cache, we also tag the last tool with cache_control, which creates a
 * second breakpoint that explicitly covers the full tool array.
 *
 * Anthropic supports up to 4 cache_control breakpoints per request; we use
 * 2 here (tools + system), leaving headroom.
 *
 * Implemented as middleware (rather than stashing message objects in
 * Agent.instructions) so that Agent.instructions remains a plain string —
 * keeping agent listing, similarity-based routing, and every other
 * consumer of the field working correctly.
 */
export const anthropicPromptCacheMiddleware = {
  specificationVersion: 'v3' as const,
  transformParams: async ({
    params,
  }: {
    params: { prompt: readonly unknown[]; tools?: readonly unknown[] };
  }) => {
    const withAnthropicCacheControl = (
      msg: Record<string, unknown>,
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
            cacheControl: { type: 'ephemeral' as const },
          },
        },
      };
    };

    // Tag every system message. Mastra's memory layer can inject additional
    // system messages (observational memory, working memory) after the
    // initial instructions, so we mark all of them rather than only the
    // first.
    const prompt = (params.prompt as Array<Record<string, unknown>>).map((msg) =>
      (msg as { role?: string }).role === 'system' ? withAnthropicCacheControl(msg) : msg,
    );

    // Tag the LAST tool to create a cache breakpoint that covers the full
    // tool array. Marking only the last tool uses one breakpoint regardless
    // of tool count.
    let tools = params.tools;
    if (Array.isArray(tools) && tools.length > 0) {
      const next = (tools as Array<Record<string, unknown>>).slice();
      const lastIdx = next.length - 1;
      next[lastIdx] = withAnthropicCacheControl(next[lastIdx]!);
      tools = next;
    }

    return { ...params, prompt, tools };
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
