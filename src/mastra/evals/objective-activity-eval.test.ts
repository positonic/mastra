import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { casesFileSchema, buildFrozenPrefix } from './replay.js';

/**
 * Eval case for the Zoe objective-activity-writes behaviour: "asked to add a
 * strategy note → posts a comment, not an update" (PRD lean.badger / ticket
 * dusty.honey).
 *
 * The case lives as a committed fixture so it can be fed to the live runner:
 *   npm run eval-replay -- src/mastra/evals/fixtures/objective-activity-cases.json
 * (the contract judge runs exponential-side; the runner only regenerates the
 * turn and records tool intents). This test is the deterministic, CI-safe
 * guard: it keeps the fixture schema-valid and pins the expectation so the
 * choose-comment-vs-update intent can't silently rot.
 */
const raw = readFileSync(
  new URL('./fixtures/objective-activity-cases.json', import.meta.url),
  'utf8',
);

describe('objective-activity eval cases', () => {
  it('is a schema-valid cases file the replay runner can consume', () => {
    const parsed = casesFileSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
  });

  it('encodes "strategy note → comment, not update" as the expectation', () => {
    const { cases } = casesFileSchema.parse(JSON.parse(raw));
    const strategyNote = cases.find(
      (c) => c.id === 'objective-strategy-note-is-a-comment',
    );
    expect(strategyNote).toBeDefined();
    expect(strategyNote!.expectation).toMatch(/add-objective-comment/);
    expect(strategyNote!.expectation).toMatch(/not add-objective-update/i);
  });

  it('frozen prefix surfaces the user request for the candidate to answer', () => {
    const { cases } = casesFileSchema.parse(JSON.parse(raw));
    const prefix = buildFrozenPrefix(cases[0]);
    expect(prefix.at(-1)!.role).toBe('user');
    expect(prefix.at(-1)!.content).toMatch(/strategy/i);
  });
});
