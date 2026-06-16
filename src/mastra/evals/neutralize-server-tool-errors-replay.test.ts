import { describe, it, expect } from 'vitest';
import { createAnthropic } from '@ai-sdk/anthropic';
import { MessageList } from '@mastra/core/agent/message-list';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import { neutralizeServerToolErrors } from '../processors/neutralize-server-tool-errors.js';

/**
 * Eval-replay regression for ADR-0002 (sibling to ADR-0013's frozen-prefix
 * harness): a stored web_fetch error block must NOT survive into the prompt
 * the provider receives on the next turn.
 *
 * This is fully offline.
 *
 * ## What actually happens on @ai-sdk/anthropic 3.0.37 (investigated, not assumed)
 *
 * The headline claim "a stored `web_fetch_tool_result_error` block throws on
 * replay" is NOT reproducible on the installed SDK (3.0.37), and we don't
 * pretend it is:
 *
 *  - A *clean* `web_fetch_tool_result_error` value does NOT throw. The
 *    converter has an explicit branch for it (index.js ~2193) that emits a
 *    `web_fetch_tool_result` / `web_fetch_tool_result_error` block. True both
 *    for a hand-built provider-executed prompt AND through Mastra's own
 *    conversion.
 *  - Mastra's V2→ModelMessage conversion drops `providerExecuted`, so the
 *    stored result is re-emitted as a plain `tool`-role `tool-result`. That
 *    path stringifies the value (no schema validation) — also no throw.
 *  - The ONLY shape that throws `Type validation failed` on 3.0.37 is an
 *    *incomplete / malformed success* (`{ type: 'web_fetch_result', url }`
 *    with no `retrievedAt`/`content`), which falls through to
 *    `validateTypes(webFetch_20250910OutputSchema)`. That is a malformed
 *    provider-tool result shape, NOT the production error variant.
 *
 * So the observed production crash most plausibly came from an OLDER SDK
 * and/or a non-clean provider-tool result shape. The neutralizer's value is
 * therefore two-fold and version-independent:
 *   (i)  forward-compat: it removes the provider-executed tool part entirely,
 *        so no future SDK version / new server tool can reintroduce a
 *        replay-side validation crash from this data; and
 *   (ii) it covers the malformed / unknown provider-tool result shapes that DO
 *        throw today (see the positive control below).
 *
 * The PRIMARY regression below proves de-poisoning through Mastra's REAL
 * MessageList round-trip and its OWN V2→model conversion (the exact layer the
 * agent feeds the provider), not a hand-rolled prompt: after neutralization the
 * converted prompt carries NO provider-executed tool part and NO
 * `*_tool_result_error`, whereas the un-neutralized history still does.
 */

// A stub fetch that returns a minimal valid Anthropic message response, so
// reaching it means request CONVERSION succeeded.
const stubAnthropicFetch: typeof fetch = async () =>
  new Response(
    JSON.stringify({
      id: 'msg_stub',
      type: 'message',
      role: 'assistant',
      model: 'claude-sonnet-4-5',
      content: [{ type: 'text', text: 'ok' }],
      stop_reason: 'end_turn',
      usage: { input_tokens: 1, output_tokens: 1 },
    }),
    { status: 200, headers: { 'content-type': 'application/json' } },
  );

const model = createAnthropic({ apiKey: 'sk-test-offline', fetch: stubAnthropicFetch })(
  'claude-sonnet-4-5',
);
const webFetchTool = [
  {
    type: 'provider-defined' as const,
    id: 'anthropic.web_fetch_20250910',
    name: 'web_fetch',
    args: {},
  },
];

/** The frozen thread: an assistant turn whose web_fetch errored, then a
 * follow-up user message. This is what a poisoned thread looks like in V2. */
function frozenHistoryWithStoredFetchError(): MastraDBMessage[] {
  const invocation = {
    toolCallId: 'tc_1',
    toolName: 'web_fetch',
    args: { url: 'https://example.com/blocked' },
    state: 'result' as const,
    result: {
      type: 'web_fetch_tool_result_error',
      errorCode: 'url_not_in_prior_context',
    },
  };
  return [
    {
      id: 'm1',
      role: 'assistant',
      createdAt: new Date(),
      content: {
        format: 2,
        parts: [
          { type: 'text', text: 'Let me look that up.' },
          { type: 'tool-invocation', toolInvocation: invocation } as never,
        ],
        toolInvocations: [invocation] as never,
        content: 'Let me look that up.',
      },
    },
    {
      id: 'm2',
      role: 'user',
      createdAt: new Date(),
      content: {
        format: 2,
        parts: [{ type: 'text', text: 'ok, what else can you tell me?' }],
        content: 'ok, what else can you tell me?',
      },
    },
  ];
}

/**
 * Re-apply a processor's output to a MessageList EXACTLY the way Mastra's
 * runner does in the `else` branch of `runInputProcessors`
 * (`@mastra/core` chunk-BPT3YHUU.js ~line 1933): for each returned message,
 * `removeByIds([id])` then `add(message, 'input')`. This is the load-bearing
 * round-trip — it proves `MessageList.add()` faithfully ingests our rebuilt V2
 * message and does NOT resurrect tool/error data from a field we didn't
 * rebuild.
 */
function applyProcessorOutputLikeRunner(
  list: MessageList,
  returned: MastraDBMessage[],
): void {
  for (const message of returned) {
    list.removeByIds([message.id]);
    list.add(message, 'input');
  }
}

/** True if any converted model message carries a provider-executed tool part
 * (tool-call / tool-result) — i.e. the poison survived conversion. */
function hasToolPart(modelMessages: { content: unknown }[]): boolean {
  return modelMessages.some((m) =>
    Array.isArray(m.content)
      ? m.content.some(
          (p: { type?: string }) =>
            p.type === 'tool-call' || p.type === 'tool-result',
        )
      : false,
  );
}

describe('ADR-0002 eval-replay regression: stored web_fetch error does not survive replay', () => {
  it('PRIMARY: through Mastra\'s real MessageList + V2→model conversion, neutralization removes the provider-executed tool part and the *_tool_result_error', async () => {
    // Baseline: the poisoned history, ingested by a REAL MessageList and run
    // through Mastra's OWN conversion, still carries the tool part + the poison
    // error shape. (On 3.0.37 this no longer THROWS — see the file docstring —
    // but the provider-executed tool data is unmistakably present.)
    const poisonedList = new MessageList();
    poisonedList.add(frozenHistoryWithStoredFetchError(), 'memory');
    const poisonedModel = poisonedList.get.all.aiV5.model();
    const poisonedJson = JSON.stringify(poisonedModel);
    expect(hasToolPart(poisonedModel)).toBe(true);
    expect(poisonedJson).toContain('web_fetch_tool_result_error');

    // Now de-poison: run the processor, then re-apply its output to a REAL
    // MessageList the way the runner does (removeByIds + add), then use
    // Mastra's OWN V2→model conversion to build the prompt.
    const neutralizedList = new MessageList();
    neutralizedList.add(frozenHistoryWithStoredFetchError(), 'memory');
    const neutralized = neutralizeServerToolErrors(neutralizedList.get.all.db());
    applyProcessorOutputLikeRunner(neutralizedList, neutralized);

    const cleanModel = neutralizedList.get.all.aiV5.model();
    const cleanJson = JSON.stringify(cleanModel);

    // No provider-executed tool part survives, and the poison error shape is
    // gone — replaced by the flattened text note.
    expect(hasToolPart(cleanModel)).toBe(false);
    expect(cleanJson).not.toContain('web_fetch_tool_result_error');
    expect(cleanJson).toContain('Attempted web_fetch');

    // And the SAME holds through the actual prompt the agent feeds the
    // provider (`get.all.aiV5.llmPrompt()` — a LanguageModelV2Prompt).
    const llmPrompt = await neutralizedList.get.all.aiV5.llmPrompt();
    const promptJson = JSON.stringify(llmPrompt);
    expect(promptJson).not.toContain('web_fetch_tool_result_error');
    expect(
      llmPrompt.some(
        (m) =>
          Array.isArray(m.content) &&
          m.content.some(
            (p: { type?: string }) =>
              p.type === 'tool-call' || p.type === 'tool-result',
          ),
      ),
    ).toBe(false);

    // The neutralized prompt converts and reaches the (stubbed) provider
    // without throwing — the thread is de-poisoned end to end.
    const result = await model.doGenerate({
      prompt: llmPrompt as never,
      tools: webFetchTool as never,
    });
    expect(result).toBeDefined();
  });

  it('positive control: a MALFORMED provider-tool result (incomplete success) DOES throw on 3.0.37 — this is the shape class the neutralizer also covers, NOT the clean error variant', async () => {
    // NOTE: this is deliberately an *incomplete success* shape, not the
    // production `web_fetch_tool_result_error` variant. On 3.0.37 the clean
    // error variant does NOT throw (see file docstring); only malformed /
    // unknown provider-tool result shapes fall through to
    // `validateTypes(webFetch_20250910OutputSchema)` and throw. The neutralizer
    // removes ALL provider-executed server-tool results, so it covers this
    // throwing shape as well as the (currently non-throwing but version-fragile)
    // error variant.
    const malformedPrompt = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'fetch it' }] },
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 'tc_1',
            toolName: 'web_fetch',
            input: { url: 'https://example.com/blocked' },
            providerExecuted: true,
          },
          {
            type: 'tool-result' as const,
            toolCallId: 'tc_1',
            toolName: 'web_fetch',
            output: {
              type: 'json' as const,
              // Incomplete success: missing retrievedAt/content -> schema fails.
              value: { type: 'web_fetch_result', url: 'https://example.com/blocked' },
            },
            providerExecuted: true,
          },
        ],
      },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'now what?' }] },
    ];

    await expect(
      model.doGenerate({ prompt: malformedPrompt as never, tools: webFetchTool as never }),
    ).rejects.toThrow(/Type validation failed/);
  });

  it('control: a CLEAN web_fetch_tool_result_error block does NOT throw on 3.0.37 (documents the honest version story)', async () => {
    // Pins the investigated fact: on 3.0.37 the converter handles the clean
    // error variant. If a future SDK bump regresses this, this test flips and
    // the failure is a clear signal to revisit ADR-0002's version narrative.
    const cleanErrorPrompt = [
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'fetch it' }] },
      {
        role: 'assistant' as const,
        content: [
          {
            type: 'tool-call' as const,
            toolCallId: 'tc_1',
            toolName: 'web_fetch',
            input: { url: 'https://example.com/blocked' },
            providerExecuted: true,
          },
          {
            type: 'tool-result' as const,
            toolCallId: 'tc_1',
            toolName: 'web_fetch',
            output: {
              type: 'json' as const,
              value: {
                type: 'web_fetch_tool_result_error',
                errorCode: 'url_not_in_prior_context',
              },
            },
            providerExecuted: true,
          },
        ],
      },
      { role: 'user' as const, content: [{ type: 'text' as const, text: 'now what?' }] },
    ];

    const result = await model.doGenerate({
      prompt: cleanErrorPrompt as never,
      tools: webFetchTool as never,
    });
    expect(result).toBeDefined();
  });
});
