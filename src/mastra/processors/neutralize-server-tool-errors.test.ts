import { describe, it, expect } from 'vitest';
import type { MastraDBMessage } from '@mastra/core/agent/message-list';
import {
  neutralizeServerToolErrors,
  NeutralizeServerToolErrorsProcessor,
} from './neutralize-server-tool-errors.js';

/**
 * Tests for ADR-0002: server-tool error results must be flattened to a text
 * note before the provider's request conversion, for ALL server tools, with
 * surrounding content preserved and idempotent behaviour.
 *
 * The V2 message shapes here were captured empirically by feeding an AI SDK v6
 * provider-executed tool result through Mastra's MessageList (see the module
 * doc comment for the recorded shape).
 */

let idCounter = 0;
const nextId = () => `m${++idCounter}`;

/** Assistant message carrying one server-tool result part (errored or not). */
function assistantWithToolResult(opts: {
  toolName: string;
  resultType: string;
  errorCode?: string;
  url?: string;
  leadingText?: string;
  successResult?: Record<string, unknown>;
}): MastraDBMessage {
  const invocation = {
    toolCallId: 'tc_1',
    toolName: opts.toolName,
    args: opts.url ? { url: opts.url } : {},
    state: 'result' as const,
    result: opts.successResult ?? {
      type: opts.resultType,
      ...(opts.errorCode ? { errorCode: opts.errorCode } : {}),
    },
  };
  const parts: MastraDBMessage['content']['parts'] = [];
  if (opts.leadingText) parts.push({ type: 'text', text: opts.leadingText });
  parts.push({ type: 'tool-invocation', toolInvocation: invocation } as never);
  return {
    id: nextId(),
    role: 'assistant',
    createdAt: new Date(),
    content: {
      format: 2,
      parts,
      // Mirrors that MessageList maintains alongside `parts`.
      toolInvocations: [invocation] as never,
      content: opts.leadingText ?? '',
    },
  };
}

const userMessage = (text: string): MastraDBMessage => ({
  id: nextId(),
  role: 'user',
  createdAt: new Date(),
  content: { format: 2, parts: [{ type: 'text', text }], content: text },
});

/** Count remaining `*_tool_result_error` blocks anywhere in the history. */
function countErrorBlocks(messages: MastraDBMessage[]): number {
  let n = 0;
  for (const m of messages) {
    for (const p of m.content?.parts ?? []) {
      if (
        p.type === 'tool-invocation' &&
        typeof (p as { toolInvocation?: { result?: { type?: unknown } } })
          .toolInvocation?.result?.type === 'string' &&
        (
          p as { toolInvocation: { result: { type: string } } }
        ).toolInvocation.result.type.endsWith('_tool_result_error')
      ) {
        n++;
      }
    }
    for (const inv of (m.content?.toolInvocations ?? []) as Array<{
      result?: { type?: unknown };
    }>) {
      if (
        typeof inv.result?.type === 'string' &&
        inv.result.type.endsWith('_tool_result_error')
      ) {
        n++;
      }
    }
  }
  return n;
}

const firstTextPart = (m: MastraDBMessage): string | undefined => {
  const p = m.content.parts.find((x) => x.type === 'text');
  return p && p.type === 'text' ? p.text : undefined;
};

describe('neutralizeServerToolErrors', () => {
  it('flattens a web_fetch error to a text note (URL + errorCode preserved)', () => {
    const history = [
      assistantWithToolResult({
        toolName: 'web_fetch',
        resultType: 'web_fetch_tool_result_error',
        errorCode: 'url_not_in_prior_context',
        url: 'https://example.com/x',
        leadingText: 'Let me fetch that.',
      }),
      userMessage('thanks, now what?'),
    ];

    const out = neutralizeServerToolErrors(history);

    expect(countErrorBlocks(out)).toBe(0);
    const note = out[0].content.parts.find(
      (p) => p.type === 'text' && p.text.includes('Attempted'),
    );
    expect(note && note.type === 'text' && note.text).toBe(
      '(Attempted web_fetch of https://example.com/x — failed: url_not_in_prior_context.)',
    );
    // leading assistant text preserved
    expect(firstTextPart(out[0])).toBe('Let me fetch that.');
    // tool-invocation part is gone (replaced by text)
    expect(out[0].content.parts.some((p) => p.type === 'tool-invocation')).toBe(
      false,
    );
  });

  it('flattens a web_search error', () => {
    const out = neutralizeServerToolErrors([
      assistantWithToolResult({
        toolName: 'web_search',
        resultType: 'web_search_tool_result_error',
        errorCode: 'max_uses_exceeded',
      }),
    ]);
    expect(countErrorBlocks(out)).toBe(0);
    expect(firstTextPart(out[0])).toBe(
      '(Attempted web_search — failed: max_uses_exceeded.)',
    );
  });

  it('flattens a code-execution error', () => {
    const out = neutralizeServerToolErrors([
      assistantWithToolResult({
        toolName: 'code_execution',
        resultType: 'code_execution_tool_result_error',
        errorCode: 'unavailable',
      }),
    ]);
    expect(countErrorBlocks(out)).toBe(0);
    expect(firstTextPart(out[0])).toBe(
      '(Attempted code_execution — failed: unavailable.)',
    );
  });

  it('handles snake_case error_code as well as camelCase errorCode', () => {
    const msg = assistantWithToolResult({
      toolName: 'web_fetch',
      resultType: 'web_fetch_tool_result_error',
      url: 'https://x.com',
      successResult: {
        type: 'web_fetch_tool_result_error',
        error_code: 'unavailable',
      },
    });
    const out = neutralizeServerToolErrors([msg]);
    expect(firstTextPart(out[0])).toBe(
      '(Attempted web_fetch of https://x.com — failed: unavailable.)',
    );
  });

  it('preserves a SUCCESSFUL server-tool result untouched', () => {
    const success = assistantWithToolResult({
      toolName: 'web_fetch',
      resultType: 'web_fetch_result',
      url: 'https://x.com',
      successResult: { type: 'web_fetch_result', url: 'https://x.com' },
    });
    const input = [success];
    const out = neutralizeServerToolErrors(input);
    // returned reference unchanged (nothing to neutralize)
    expect(out).toBe(input);
    expect(out[0].content.parts.some((p) => p.type === 'tool-invocation')).toBe(
      true,
    );
    expect(countErrorBlocks(out)).toBe(0);
  });

  it('preserves unrelated user/assistant messages and their order', () => {
    const history = [
      userMessage('hi'),
      assistantWithToolResult({
        toolName: 'web_fetch',
        resultType: 'web_fetch_tool_result_error',
        errorCode: 'url_not_in_prior_context',
        url: 'https://a.com',
        leadingText: 'fetching',
      }),
      userMessage('and then'),
    ];
    const out = neutralizeServerToolErrors(history);
    expect(out).toHaveLength(3);
    expect(out[0]).toBe(history[0]); // untouched message kept by reference
    expect(out[2]).toBe(history[2]);
    expect(firstTextPart(out[0])).toBe('hi');
    expect(firstTextPart(out[2])).toBe('and then');
  });

  it('strips the stale parallel toolInvocations[] mirror for errored results', () => {
    const out = neutralizeServerToolErrors([
      assistantWithToolResult({
        toolName: 'web_fetch',
        resultType: 'web_fetch_tool_result_error',
        errorCode: 'url_not_in_prior_context',
        url: 'https://x.com',
      }),
    ]);
    expect(out[0].content.toolInvocations).toEqual([]);
  });

  it('returns a clean history unchanged (same reference)', () => {
    const history = [userMessage('hi'), userMessage('there')];
    expect(neutralizeServerToolErrors(history)).toBe(history);
  });

  it('returns an empty history unchanged', () => {
    const empty: MastraDBMessage[] = [];
    expect(neutralizeServerToolErrors(empty)).toBe(empty);
  });

  it('is idempotent: running twice equals running once', () => {
    const history = [
      assistantWithToolResult({
        toolName: 'web_fetch',
        resultType: 'web_fetch_tool_result_error',
        errorCode: 'url_not_in_prior_context',
        url: 'https://x.com',
        leadingText: 'one',
      }),
      assistantWithToolResult({
        toolName: 'web_search',
        resultType: 'web_search_tool_result_error',
        errorCode: 'max_uses_exceeded',
      }),
    ];
    const once = neutralizeServerToolErrors(history);
    const twice = neutralizeServerToolErrors(once);
    expect(countErrorBlocks(twice)).toBe(0);
    expect(JSON.stringify(twice)).toBe(JSON.stringify(once));
    // second pass is a structural no-op: same reference returned
    expect(neutralizeServerToolErrors(once)).toBe(once);
  });

  it('handles multiple errored parts within a single message', () => {
    const inv = (toolName: string, type: string, code: string) => ({
      toolCallId: `tc_${toolName}`,
      toolName,
      args: {},
      state: 'result' as const,
      result: { type, errorCode: code },
    });
    const msg: MastraDBMessage = {
      id: nextId(),
      role: 'assistant',
      createdAt: new Date(),
      content: {
        format: 2,
        parts: [
          { type: 'text', text: 'trying things' },
          {
            type: 'tool-invocation',
            toolInvocation: inv(
              'web_fetch',
              'web_fetch_tool_result_error',
              'url_not_in_prior_context',
            ),
          } as never,
          {
            type: 'tool-invocation',
            toolInvocation: inv(
              'web_search',
              'web_search_tool_result_error',
              'max_uses_exceeded',
            ),
          } as never,
        ],
      },
    };
    const out = neutralizeServerToolErrors([msg]);
    expect(countErrorBlocks(out)).toBe(0);
    const noteTexts = out[0].content.parts
      .filter((p) => p.type === 'text')
      .map((p) => (p.type === 'text' ? p.text : ''));
    expect(noteTexts).toContain('trying things');
    expect(noteTexts.some((t) => t.includes('web_fetch'))).toBe(true);
    expect(noteTexts.some((t) => t.includes('web_search'))).toBe(true);
  });
});

describe('NeutralizeServerToolErrorsProcessor', () => {
  it('processInput delegates to the pure function', () => {
    const processor = new NeutralizeServerToolErrorsProcessor();
    const history = [
      assistantWithToolResult({
        toolName: 'web_fetch',
        resultType: 'web_fetch_tool_result_error',
        errorCode: 'url_not_in_prior_context',
        url: 'https://x.com',
      }),
    ];
    // Only `messages` is read by the processor.
    const out = processor.processInput({
      messages: history,
    } as never) as MastraDBMessage[];
    expect(countErrorBlocks(out)).toBe(0);
    expect(processor.id).toBe('neutralize-server-tool-errors');
  });
});
