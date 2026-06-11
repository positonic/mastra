import { describe, it, expect } from 'vitest';
import { createTool } from '@mastra/core/tools';
import { z } from 'zod';
import {
  buildFrozenPrefix,
  casesFileSchema,
  createIntentCapturingTools,
  INTENT_STUB_RESULT,
  type ReplayCase,
  type ToolIntent,
} from './replay.js';

const turn = (userMessage: string, aiResponse: string) => ({
  userMessage,
  aiResponse,
  toolsUsed: [],
  hadError: false,
});

const baseCase: ReplayCase = {
  id: 'case-1',
  transcript: [
    turn('add milk to my list', 'Done — created the Action "buy milk".'),
    turn('what is on my list?', 'You should check your own list.'),
  ],
  violatingTurnIndex: 1,
  expectation: 'must not deflect; should have called get-project-actions',
};

describe('buildFrozenPrefix', () => {
  it('feeds full pairs before the violating turn, then its user message unanswered', () => {
    expect(buildFrozenPrefix(baseCase)).toEqual([
      { role: 'user', content: 'add milk to my list' },
      { role: 'assistant', content: 'Done — created the Action "buy milk".' },
      { role: 'user', content: 'what is on my list?' },
    ]);
  });

  it('violating turn 0 yields just that user message', () => {
    expect(buildFrozenPrefix({ ...baseCase, violatingTurnIndex: 0 })).toEqual([
      { role: 'user', content: 'add milk to my list' },
    ]);
  });

  it('never includes the original violating response (that is what gets regenerated)', () => {
    const messages = buildFrozenPrefix(baseCase);
    expect(messages.some((m) => m.content.includes('check your own list'))).toBe(false);
    expect(messages[messages.length - 1].role).toBe('user');
  });

  it('rejects an out-of-bounds violatingTurnIndex', () => {
    expect(() => buildFrozenPrefix({ ...baseCase, violatingTurnIndex: 2 })).toThrow(/out of bounds/);
  });
});

describe('casesFileSchema', () => {
  it('accepts the exported shape and rejects garbage', () => {
    expect(casesFileSchema.safeParse({ cases: [baseCase] }).success).toBe(true);
    expect(casesFileSchema.safeParse({ cases: [] }).success).toBe(false);
    expect(casesFileSchema.safeParse({ cases: [{ id: 'x' }] }).success).toBe(false);
  });
});

describe('createIntentCapturingTools', () => {
  const makeTools = () => {
    let executed = 0;
    const realTool = createTool({
      id: 'create-project',
      description: 'Creates a project (side effects!)',
      inputSchema: z.object({ name: z.string() }),
      outputSchema: z.object({ project: z.object({ id: z.string() }) }),
      execute: async () => {
        executed += 1;
        return { project: { id: 'real-side-effect' } };
      },
    });
    return { realTool, executedCount: () => executed };
  };

  it('records the intent and returns the stub without executing the original', async () => {
    const { realTool, executedCount } = makeTools();
    const intents: ToolIntent[] = [];
    const wrapped = createIntentCapturingTools({ createProjectTool: realTool }, (i) => intents.push(i));

    const wrappedTool = wrapped.createProjectTool as {
      execute: (input: unknown, ctx?: unknown) => Promise<unknown>;
    };
    const result = await wrappedTool.execute({ name: 'Evil Prod Mutation' });

    expect(result).toEqual(INTENT_STUB_RESULT);
    expect(intents).toEqual([{ toolName: 'create-project', args: { name: 'Evil Prod Mutation' } }]);
    expect(executedCount()).toBe(0); // the safety property: original never ran
  });

  it('preserves id, description, and input schema so the model sees the production tool surface', () => {
    const { realTool } = makeTools();
    const wrapped = createIntentCapturingTools({ createProjectTool: realTool }, () => undefined);
    const wrappedTool = wrapped.createProjectTool as {
      id: string;
      description: string;
      inputSchema: unknown;
    };
    expect(wrappedTool.id).toBe('create-project');
    expect(wrappedTool.description).toBe('Creates a project (side effects!)');
    expect(wrappedTool.inputSchema).toBe(realTool.inputSchema);
  });

  it('passes provider-defined tools (no local executor) through unchanged', () => {
    const providerTool = { type: 'provider-defined', id: 'anthropic.web_search_20250305', args: {} };
    const wrapped = createIntentCapturingTools({ webSearch: providerTool }, () => undefined);
    expect(wrapped.webSearch).toBe(providerTool);
  });

  it('captures every call when the model invokes multiple tools', async () => {
    const { realTool } = makeTools();
    const intents: ToolIntent[] = [];
    const wrapped = createIntentCapturingTools({ createProjectTool: realTool }, (i) => intents.push(i));
    const wrappedTool = wrapped.createProjectTool as {
      execute: (input: unknown, ctx?: unknown) => Promise<unknown>;
    };
    await wrappedTool.execute({ name: 'one' });
    await wrappedTool.execute({ name: 'two' });
    expect(intents.map((i) => (i.args as { name: string }).name)).toEqual(['one', 'two']);
  });
});
