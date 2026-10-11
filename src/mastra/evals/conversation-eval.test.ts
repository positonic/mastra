import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { casesFileSchema, buildFrozenPrefix } from './replay.js';
import { CONVERSATION_POLICY } from '../agents/conversation-policy.js';

// The Assistant constructs Anthropic provider tools and the memory store at
// import, so it is loaded with both stubbed (as routing-eval.test.ts does)
// to read its real, built INSTRUCTIONS.
vi.mock('@ai-sdk/anthropic', () => {
  const provider = (() => ({ modelId: 'stub' })) as unknown as Record<string, unknown>;
  provider.tools = {
    webSearch_20250305: () => ({ id: 'web-search' }),
    webFetch_20250910: () => ({ id: 'web-fetch' }),
    toolSearchBm25_20251119: () => ({ id: 'tool-search' }),
  };
  return { anthropic: provider };
});
vi.mock('../memory/index.js', () => ({ memory: {}, storage: {} }));
vi.mock('../utils/anthropic-prompt-cache.js', () => ({
  withAnthropicPromptCache: (m: unknown) => m,
}));

const { INSTRUCTIONS } = await import('../agents/assistant-agent.js');
const { RUN_CONTRACT, assistantRunInstructions } = await import('../agents/assistant-run-agent.js');

/**
 * Eval cases for the chat conversation policy (Exponential ticket
 * clear.flame): a date that conflicts with the calendar, two stated dates
 * that disagree, a repeated create for the same name, a reply that ends in a
 * menu of offers, and logistics written into a title without a lookup.
 *
 * Feed them to the live runner with
 *   npm run eval-replay -- src/mastra/evals/fixtures/conversation-cases.json
 * This test is the deterministic, CI-safe guard: the fixture stays
 * schema-valid and the expectations pin the CONVERSATION_POLICY outcomes.
 */
const raw = readFileSync(new URL('./fixtures/conversation-cases.json', import.meta.url), 'utf8');
const { cases } = casesFileSchema.parse(JSON.parse(raw));
const byId = (id: string) => {
  const c = cases.find((x) => x.id === id);
  expect(c, `missing case ${id}`).toBeDefined();
  return c!;
};

describe('conversation eval cases', () => {
  it('is a schema-valid cases file the replay runner can consume', () => {
    expect(casesFileSchema.safeParse(JSON.parse(raw)).success).toBe(true);
  });

  it('covers every conversation rule', () => {
    expect(cases.map((c) => c.id).sort()).toEqual(
      [
        'conversation-date-conflict-calendar',
        'conversation-date-conflict-stated',
        'conversation-hedged-logistics',
        'conversation-one-next-step',
        'conversation-repeated-create-show-me',
      ].sort(),
    );
    for (const c of cases) expect(c.lane).toBe('conversation');
  });

  it.each(['conversation-date-conflict-calendar', 'conversation-date-conflict-stated'])(
    '%s says the conflict in one line and creates nothing until answered',
    (id) => {
      const c = byId(id);
      expect(c.expectation).toMatch(/say the conflict in ONE line and ask which/);
      expect(c.expectation).toMatch(/must NOT call [^.]*quick-create-action[^.]*in this turn/);
      expect(c.expectation).toMatch(/must NOT pick one[^.]* silently/);
    },
  );

  it('the calendar conflict keeps both dates out of titles', () => {
    const c = byId('conversation-date-conflict-calendar');
    expect(c.transcript[0]!.toolsUsed).toContain('get-calendar-events-in-range');
    expect(c.expectation).toMatch(/must NOT put either date in a title/);
  });

  it('a repeated create re-links the existing item, checks for a duplicate, no joke', () => {
    const c = byId('conversation-repeated-create-show-me');
    expect(c.transcript[0]!.userMessage).toMatch(/Madrid offsite/);
    expect(c.transcript[1]!.userMessage).toMatch(/Madrid offsite/);
    expect(c.expectation).toMatch(/treat it as "show me"/);
    expect(c.expectation).toMatch(/point to the existing "Madrid offsite" project \(name and link\)/);
    expect(c.expectation).toMatch(/get-all-projects to check no duplicate exists/);
    expect(c.expectation).toMatch(/must NOT call create-project again/);
    expect(c.expectation).toMatch(/must NOT joke, celebrate/);
  });

  it('a create reply ends with at most one next step, never a menu', () => {
    const c = byId('conversation-one-next-step');
    expect(c.expectation).toMatch(/at most ONE next step/);
    expect(c.expectation).toMatch(/must NOT end with a menu or list of several offers/);
  });

  it('logistics nobody looked up are hedged and kept out of the title', () => {
    const c = byId('conversation-hedged-logistics');
    expect(c.expectation).toMatch(/No tool in this conversation returned/);
    expect(c.expectation).toMatch(/MUST be hedged/);
    expect(c.expectation).toMatch(/must NOT write opening hours[^.]* into the action title as constraints/);
  });

  it('frozen prefix ends on the user turn the candidate must answer', () => {
    for (const c of cases) {
      const prefix = buildFrozenPrefix(c);
      expect(prefix.at(-1)!.role).toBe('user');
      expect(prefix.at(-1)!.content).toBe(c.transcript[c.violatingTurnIndex]!.userMessage);
    }
  });

  it('the built Assistant prompt carries the block; the run agent prompt does not', () => {
    expect(INSTRUCTIONS).toContain(CONVERSATION_POLICY);
    expect(RUN_CONTRACT).not.toContain(CONVERSATION_POLICY);
    expect(assistantRunInstructions()).not.toContain(CONVERSATION_POLICY);
  });
});
