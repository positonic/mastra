import { describe, it, expect, vi } from 'vitest';
import { Agent } from '@mastra/core/agent';
import { MockLanguageModelV3 } from 'ai/test';

/**
 * "Exactly one ending" is structural: the run loop stops on the step that
 * calls ask-owner or finish-run, even when the model wants to keep going.
 * Drives a real Mastra Agent with the run's default options and a mock model
 * that calls the given tool on every step.
 */
vi.mock('@ai-sdk/anthropic', () => {
  const provider = (() => ({ modelId: 'stub' })) as unknown as Record<string, unknown>;
  provider.tools = {
    webSearch_20250305: () => ({ id: 'web-search' }),
    webFetch_20250910: () => ({ id: 'web-fetch' }),
    toolSearchBm25_20251119: () => ({ id: 'tool-search' }),
  };
  return { anthropic: provider };
});
vi.mock('../../memory/index.js', () => ({ memory: {}, storage: {} }));
vi.mock('../../utils/anthropic-prompt-cache.js', () => ({
  withAnthropicPromptCache: (m: unknown) => m,
}));
vi.mock('../../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: vi.fn().mockResolvedValue({ data: {} }),
  authenticatedTrpcQuery: vi.fn().mockResolvedValue({ data: {} }),
}));

const { assistantRunDefaultOptions } = await import('../assistant-run-agent.js');
const { runTools } = await import('../../tools/run-tools.js');

const usage = {
  inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 },
  outputTokens: { total: 1, text: 1, reasoning: 0 },
};

function modelCalling(toolName: string, input: Record<string, unknown>) {
  let calls = 0;
  const model = new MockLanguageModelV3({
    doStream: async () => {
      calls++;
      const chunks = [
        { type: 'stream-start', warnings: [] },
        { type: 'tool-call', toolCallId: `call-${calls}`, toolName, input: JSON.stringify(input) },
        { type: 'finish', finishReason: { unified: 'tool-calls', raw: 'tool_use' }, usage },
      ];
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const chunk of chunks) controller.enqueue(chunk);
            controller.close();
          },
        }),
      } as never;
    },
  });
  return { model, calls: () => calls };
}

async function runWith(toolName: string, input: Record<string, unknown>) {
  const { model, calls } = modelCalling(toolName, input);
  const agent = new Agent({
    id: 'assistantRunAgentStopProbe',
    name: 'stop probe',
    instructions: 'probe',
    model,
    tools: runTools,
    defaultOptions: assistantRunDefaultOptions,
  });
  const requestContext = new Map([['authToken', 'run-jwt']]);
  const result = await agent.stream('go', { requestContext } as never);
  await result.text;
  return calls();
}

describe('assistantRunAgent endings stop the loop', () => {
  it('stops after the step that calls ask-owner', async () => {
    expect(await runWith('askOwnerTool', { question: 'q' })).toBe(1);
  });

  it('stops after the step that calls finish-run', async () => {
    expect(await runWith('finishRunTool', { summary: 's', readyToClose: false })).toBe(1);
  });

  it('is otherwise bounded at 12 steps', async () => {
    expect(await runWith('reportProgressTool', { text: 'still going' })).toBe(12);
  });

  it('sets no maxSteps — Mastra would replace stopWhen with it', () => {
    expect(assistantRunDefaultOptions).not.toHaveProperty('maxSteps');
  });
});
