import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { casesFileSchema, buildFrozenPrefix } from './replay.js';

/**
 * Eval cases for the Agent run contract (Exponential ADR-0067, Agent PRD D5):
 * an unattended run never claims an outbound action it has no tool for, and
 * a question only the owner can answer ends the run with ask-owner — and
 * nothing after it.
 *
 * Committed as a fixture so the live runner can replay it against a
 * candidate `assistantRunAgent` prompt:
 *   npm run eval-replay -- src/mastra/evals/fixtures/agent-run-cases.json
 * This test is the deterministic, CI-safe guard: it keeps the fixture
 * schema-valid and pins the expectations so the contract cannot silently rot.
 */
const raw = readFileSync(new URL('./fixtures/agent-run-cases.json', import.meta.url), 'utf8');

describe('agent-run eval cases', () => {
  it('is a schema-valid cases file the replay runner can consume', () => {
    expect(casesFileSchema.safeParse(JSON.parse(raw)).success).toBe(true);
  });

  it('the email case forbids send-email and completing the action, and requires ask-owner or a draft in the summary', () => {
    const { cases } = casesFileSchema.parse(JSON.parse(raw));
    const c = cases.find((x) => x.id === 'agent-run-email-needed-ask-owner-not-send')!;
    expect(c).toBeDefined();
    expect(c.expectation).toMatch(/must NOT call send-email/i);
    expect(c.expectation).toMatch(/must NOT set the action to completed/i);
    expect(c.expectation).toMatch(/ask-owner/);
    expect(c.expectation).toMatch(/finish-run/);
  });

  it('the decision case requires ask-owner and forbids any call after it', () => {
    const { cases } = casesFileSchema.parse(JSON.parse(raw));
    const c = cases.find((x) => x.id === 'agent-run-owner-decision-ask-owner-then-stop')!;
    expect(c).toBeDefined();
    expect(c.expectation).toMatch(/ask-owner/);
    expect(c.expectation).toMatch(/no finish-run/i);
    expect(c.expectation).toMatch(/no further tool calls/i);
  });

  it('frozen prefix ends on the assignment brief for the candidate to act on', () => {
    const { cases } = casesFileSchema.parse(JSON.parse(raw));
    for (const c of cases) {
      const prefix = buildFrozenPrefix(c);
      expect(prefix.at(-1)!.role).toBe('user');
      expect(prefix.at(-1)!.content).toMatch(/assigned the action/i);
    }
  });
});
