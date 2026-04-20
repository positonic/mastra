import type { CoreSystemMessage } from '@mastra/core/llm';

/**
 * Wrap a static system prompt so @ai-sdk/anthropic emits an ephemeral
 * cache breakpoint on it. Anthropic caches everything up to and
 * including the breakpoint (tools + system), so subsequent turns in the
 * same ~5-minute window bill the prefix as cache_read_input_tokens
 * (~10% of base input rate) instead of full input tokens. Expected
 * savings for long static prompts: 60-80% on input cost.
 *
 * Only use this for content that is byte-identical across requests —
 * any variance breaks the cache entry.
 */
export function cachedSystemPrompt(content: string): CoreSystemMessage[] {
  return [
    {
      role: 'system',
      content,
      providerOptions: {
        anthropic: { cacheControl: { type: 'ephemeral' } },
      },
    },
  ];
}
