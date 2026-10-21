import { describe, it, expect, vi } from 'vitest';
import { anthropic, createAnthropic } from '@ai-sdk/anthropic';
import { generateText, type ModelMessage } from 'ai';
import { withAnthropicPromptCache } from './anthropic-prompt-cache.js';
import { repairMisroutedServerToolCalls } from './misrouted-server-tool-calls.js';

vi.mock('./logger.js', () => ({
  createLogger: () => ({ info: vi.fn(), debug: vi.fn(), warn: vi.fn(), error: vi.fn() }),
}));

// Production, 2026-10-15 (Zoe, "prep for a call with Paul Wong"): the model
// emitted an ordinary `tool_use` named `web_search`. Mastra's
// findProviderToolByName matched it to the Anthropic provider tool and
// inferProviderExecuted marked it provider-executed, so the next step replayed
// it as `server_tool_use` with its `toolu_` id. Anthropic only accepts
// `srvtoolu_` ids there and rejected the whole request:
//   messages.7.content.1.server_tool_use.id: String should match pattern '^srvtoolu_[a-zA-Z0-9_]+$'

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
        usage: { input_tokens: 10, output_tokens: 2 },
      }),
      { status: 200, headers: { 'content-type': 'application/json' } },
    );
  });
  const model = withAnthropicPromptCache(
    createAnthropic({ apiKey: 'test', fetch: fetch as never })('claude-sonnet-4-5-20250929'),
  );
  return { model, bodies };
}

const tools = { webSearch: anthropic.tools.webSearch_20250305({ maxUses: 5 }) };

const misroutedTurn: ModelMessage[] = [
  { role: 'user', content: 'Help me prep for a call with Paul Wong' },
  {
    role: 'assistant',
    content: [
      { type: 'text', text: 'Let me search for context:' },
      {
        type: 'tool-call',
        toolCallId: 'toolu_01XXWemsbgDa3c9Sdg5aGrw3',
        toolName: 'web_search',
        input: { query: 'Stellar Disbursement Platform Paul Wong' },
        providerExecuted: true,
      },
      {
        type: 'tool-call',
        toolCallId: 'toolu_01JFb5aQicVQCZsUWLZ1QNnH',
        toolName: 'web_search',
        input: { query: 'Stellar Disbursement Platform documentation' },
        providerExecuted: true,
      },
    ],
  },
];

const allBlocks = (body: Record<string, any>) =>
  (body.messages as Array<{ content: Array<Record<string, any>> | string }>).flatMap((m) =>
    Array.isArray(m.content) ? m.content : [],
  );

describe('repairMisroutedServerToolCalls (through the real provider)', () => {
  it('never sends a server_tool_use whose id is not srvtoolu_', async () => {
    const { model, bodies } = captureRequestBody();
    await generateText({ model, tools, messages: misroutedTurn });

    const serverToolUses = allBlocks(bodies[0]!).filter((b) => b.type === 'server_tool_use');
    for (const block of serverToolUses) {
      expect(block.id).toMatch(/^srvtoolu_/);
    }
  });

  it('keeps a note of what the model tried, and ends on a user turn', async () => {
    const { model, bodies } = captureRequestBody();
    await generateText({ model, tools, messages: misroutedTurn });

    const messages = bodies[0]!.messages as Array<{ role: string; content: any }>;
    const text = JSON.stringify(messages);
    expect(text).toContain('Stellar Disbursement Platform Paul Wong');
    expect(text).toContain('did not run');
    // Ending on the repaired assistant message would make it a prefill, which
    // newer models reject; the repair hands the turn back to the model.
    expect(messages.at(-1)!.role).toBe('user');
  });

  it('leaves a genuine server tool call (srvtoolu_ id) and its result alone', async () => {
    const { model, bodies } = captureRequestBody();
    await generateText({
      model,
      tools,
      messages: [
        { role: 'user', content: 'search something' },
        {
          role: 'assistant',
          content: [
            {
              type: 'tool-call',
              toolCallId: 'srvtoolu_01ABC',
              toolName: 'web_search',
              input: { query: 'q' },
              providerExecuted: true,
            },
            {
              type: 'tool-result',
              toolCallId: 'srvtoolu_01ABC',
              toolName: 'web_search',
              output: {
                type: 'json',
                value: [
                  {
                    url: 'https://example.com',
                    title: 'Example',
                    pageAge: null,
                    encryptedContent: 'enc',
                    type: 'web_search_result',
                  },
                ],
              },
            },
          ],
        },
        { role: 'user', content: 'thanks' },
      ],
    });

    const blocks = allBlocks(bodies[0]!);
    expect(blocks.find((b) => b.type === 'server_tool_use')?.id).toBe('srvtoolu_01ABC');
    expect(blocks.some((b) => b.type === 'web_search_tool_result')).toBe(true);
  });
});

describe('repairMisroutedServerToolCalls (pure)', () => {
  it('returns the same prompt reference when nothing is misrouted', () => {
    const prompt = [{ role: 'user', content: [{ type: 'text', text: 'hi' }] }];
    expect(repairMisroutedServerToolCalls(prompt)).toBe(prompt);
  });

  it('drops results paired with a misrouted call, wherever they sit', () => {
    const prompt = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          {
            type: 'tool-call',
            toolCallId: 'toolu_1',
            toolName: 'web_fetch',
            input: { url: 'https://example.com' },
            providerExecuted: true,
          },
        ],
      },
      {
        role: 'tool',
        content: [{ type: 'tool-result', toolCallId: 'toolu_1', toolName: 'web_fetch', output: {} }],
      },
      { role: 'user', content: [{ type: 'text', text: 'and?' }] },
    ];

    const repaired = repairMisroutedServerToolCalls(prompt) as Array<{ role: string; content: any[] }>;

    expect(repaired.map((m) => m.role)).toEqual(['user', 'assistant', 'user']);
    expect(repaired[1]!.content).toEqual([
      { type: 'text', text: '(Attempted web_fetch of https://example.com — the call was malformed and did not run.)' },
    ]);
  });

  it('is idempotent', () => {
    const once = repairMisroutedServerToolCalls([
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [
          { type: 'tool-call', toolCallId: 'toolu_1', toolName: 'web_search', input: { query: 'q' }, providerExecuted: true },
        ],
      },
    ]);
    expect(repairMisroutedServerToolCalls(once)).toBe(once);
  });

  it('does not touch client tool calls (providerExecuted unset)', () => {
    const prompt = [
      { role: 'user', content: [{ type: 'text', text: 'go' }] },
      {
        role: 'assistant',
        content: [{ type: 'tool-call', toolCallId: 'toolu_1', toolName: 'getProjectContextTool', input: {} }],
      },
    ];
    expect(repairMisroutedServerToolCalls(prompt)).toBe(prompt);
  });
});
