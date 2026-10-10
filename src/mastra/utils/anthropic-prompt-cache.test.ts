import { describe, it, expect, vi } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { generateText, type ModelMessage } from 'ai';
import {
  withAnthropicPromptCache,
  logPromptCacheUsage,
  promptCacheUsageLoggingMiddleware,
} from './anthropic-prompt-cache.js';

const loggedInfo = vi.hoisted(() => vi.fn());
vi.mock('./logger.js', () => ({
  createLogger: () => ({ info: loggedInfo, debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Drives the real @ai-sdk/anthropic provider through the middleware with a
// stubbed fetch, and asserts on the request body Anthropic would receive —
// where `cache_control` actually lands is the thing that decides the hit rate.

function captureRequestBody() {
  const bodies: Array<Record<string, any>> = [];
  const fetch = vi.fn(async (_url: unknown, init?: { body?: unknown }) => {
    bodies.push(JSON.parse(String(init?.body)));
    return new Response(
      JSON.stringify({
        id: 'msg_test',
        type: 'message',
        role: 'assistant',
        model: 'claude-sonnet-4-5-20250929',
        content: [{ type: 'text', text: 'ok' }],
        stop_reason: 'end_turn',
        stop_sequence: null,
        usage: {
          input_tokens: 100,
          output_tokens: 5,
          cache_creation_input_tokens: 400,
          cache_read_input_tokens: 9500,
        },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  const model = withAnthropicPromptCache(
    createAnthropic({ apiKey: 'test', fetch: fetch as never })('claude-sonnet-4-5-20250929'),
  );
  return { model, bodies };
}

const cacheControlsIn = (blocks: Array<Record<string, any>> | undefined) =>
  (blocks ?? []).filter((b) => b.cache_control).length;

describe('anthropicPromptCacheMiddleware', () => {
  it('tags the static system prompt but not memory-injected system messages', async () => {
    const { model, bodies } = captureRequestBody();
    await generateText({
      model,
      messages: [
        { role: 'system', content: 'SOUL — static agent instructions' },
        { role: 'system', content: 'observational memory — volatile per turn' },
        { role: 'user', content: 'hi' },
      ],
    });

    const system = bodies[0].system as Array<Record<string, any>>;
    expect(system[0].cache_control).toEqual({ type: 'ephemeral' });
    expect(system[1].cache_control).toBeUndefined();
  });

  it('puts a rolling breakpoint on the last message of a tool loop', async () => {
    const { model, bodies } = captureRequestBody();
    const messages: ModelMessage[] = [
      { role: 'system', content: 'SOUL' },
      { role: 'user', content: 'create an action called Ship it' },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 't1', toolName: 'createAction', input: { name: 'Ship it' } },
        ],
      },
      {
        role: 'tool',
        content: [
          {
            type: 'tool-result',
            toolCallId: 't1',
            toolName: 'createAction',
            output: { type: 'json', value: { id: 'a1' } },
          },
        ],
      },
    ];
    await generateText({ model, messages });

    const sent = bodies[0].messages as Array<{ role: string; content: Array<Record<string, any>> }>;
    const last = sent[sent.length - 1];
    expect(last.content[last.content.length - 1].cache_control).toEqual({ type: 'ephemeral' });
    // Earlier history carries no breakpoint — exactly 2 in total (system + rolling).
    const total =
      cacheControlsIn(bodies[0].system) +
      sent.reduce((n, m) => n + cacheControlsIn(m.content), 0);
    expect(total).toBe(2);
  });

  it('tags the user message on a first turn', async () => {
    const { model, bodies } = captureRequestBody();
    await generateText({
      model,
      messages: [
        { role: 'system', content: 'SOUL' },
        { role: 'user', content: 'hi' },
      ],
    });

    const sent = bodies[0].messages as Array<{ content: Array<Record<string, any>> }>;
    expect(sent[0].content[0].cache_control).toEqual({ type: 'ephemeral' });
  });
});

describe('logPromptCacheUsage', () => {
  it('logs the cache split and hit rate', () => {
    const info = vi.fn();
    logPromptCacheUsage(
      'claude-sonnet-4-5-20250929',
      { total: 10_000, noCache: 100, cacheRead: 9_500, cacheWrite: 400 },
      { info },
    );
    expect(info).toHaveBeenCalledWith('prompt-cache usage', {
      modelId: 'claude-sonnet-4-5-20250929',
      inputTotal: 10_000,
      noCache: 100,
      cacheRead: 9_500,
      cacheWrite: 400,
      hitRate: 0.95,
    });
  });

  it('logs from the finish chunk of a stream (the path Mastra agents use)', async () => {
    loggedInfo.mockClear();
    const chunks = [
      { type: 'text-delta', id: '0', delta: 'ok' },
      {
        type: 'finish',
        finishReason: 'stop',
        usage: { inputTokens: { total: 2_000, noCache: 50, cacheRead: 1_900, cacheWrite: 50 } },
      },
    ];
    const { stream } = await promptCacheUsageLoggingMiddleware.wrapStream({
      doStream: async () => ({
        stream: new ReadableStream({
          start(c) {
            chunks.forEach((chunk) => c.enqueue(chunk));
            c.close();
          },
        }),
      }),
      model: { modelId: 'claude-haiku-4-5-20251001' },
    });

    const seen: unknown[] = [];
    for await (const chunk of stream as unknown as AsyncIterable<unknown>) seen.push(chunk);

    expect(seen).toEqual(chunks); // passes every chunk through untouched
    expect(loggedInfo).toHaveBeenCalledTimes(1);
    expect(loggedInfo).toHaveBeenCalledWith(
      'prompt-cache usage',
      expect.objectContaining({ modelId: 'claude-haiku-4-5-20251001', cacheRead: 1_900, hitRate: 0.95 }),
    );
  });
});
