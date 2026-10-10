import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { casesFileSchema, buildFrozenPrefix } from './replay.js';

/**
 * Eval cases for routing by Remit (Exponential ADR-0068, Agent PRD D9): clear
 * match, no match, ambiguity, "action these" with a matching Assistant, with
 * only the requester's own Assistant, and with none — plus the Madrid
 * transcript that motivated the feature as the regression case.
 *
 * Feed them to the live runner with
 *   npm run eval-replay -- src/mastra/evals/fixtures/routing-cases.json
 * This test is the deterministic, CI-safe guard: the fixture stays
 * schema-valid, the expectations pin the ROUTING_POLICY outcomes, and the
 * routing tools are registered on BOTH chat agents (tool map and
 * instructions). Agents are read as source text: importing them boots the
 * memory store.
 */
const raw = readFileSync(new URL('./fixtures/routing-cases.json', import.meta.url), 'utf8');
const { cases } = casesFileSchema.parse(JSON.parse(raw));
const byId = (id: string) => {
  const c = cases.find((x) => x.id === id);
  expect(c, `missing case ${id}`).toBeDefined();
  return c!;
};

describe('routing eval cases', () => {
  it('is a schema-valid cases file the replay runner can consume', () => {
    expect(casesFileSchema.safeParse(JSON.parse(raw)).success).toBe(true);
  });

  it('covers every routing outcome plus the Madrid regression', () => {
    expect(cases.map((c) => c.id).sort()).toEqual(
      [
        'routing-action-these-matching-assistant',
        'routing-action-these-no-assistant',
        'routing-action-these-requesters-own-assistant',
        'routing-ambiguity-name-alternative',
        'routing-clear-match-assign-holder',
        'routing-madrid-regression',
        'routing-no-match-assign-requester',
      ].sort(),
    );
    for (const c of cases) expect(c.lane).toBe('routing');
  });

  it('clear match assigns the holder in the same turn and names holder and Position', () => {
    const c = byId('routing-clear-match-assign-holder');
    expect(c.expectation).toMatch(/list-assignable-members[\s\S]*quick-create-action[\s\S]*assign-action/);
    expect(c.expectation).toMatch(/assigned to Aria, who holds Travel researcher/);
    expect(c.expectation).toMatch(/must NOT ask who/i);
  });

  it('no match assigns the requester', () => {
    const c = byId('routing-no-match-assign-requester');
    expect(c.expectation).toMatch(/assign-action with the requester's own id \(the member with isRequester\)/);
    expect(c.expectation).toMatch(/must NOT leave the action unassigned/);
  });

  it('ambiguity assigns one and names the alternative in the same reply', () => {
    const c = byId('routing-ambiguity-name-alternative');
    expect(c.expectation).toMatch(/name the alternative in the same reply/);
    expect(c.expectation).toMatch(/must NOT stop to ask before assigning/);
  });

  it.each([
    'routing-action-these-matching-assistant',
    'routing-action-these-requesters-own-assistant',
    'routing-madrid-regression',
  ])('%s demands the one-line research-and-ask, no-book-or-send statement', (id) => {
    const c = byId(id);
    expect(c.expectation).toMatch(/ONE[- ]line/);
    expect(c.expectation).toMatch(/will not book, buy, send email or change calendars/);
    expect(c.expectation).toMatch(/assign-action/);
  });

  it('"action these" never completes the actions or claims a booking', () => {
    const c = byId('routing-action-these-matching-assistant');
    expect(c.expectation).toMatch(/must NOT claim anything was booked/);
    expect(c.expectation).toMatch(/must NOT call update-action to complete/);
    expect(c.expectation).toMatch(/agentRunsQueued is 0/);
  });

  it('falls back to the requester\'s own Assistant, and never to a human when there is none', () => {
    expect(byId('routing-action-these-requesters-own-assistant').expectation).toMatch(/isRequestersAssistant/);
    const none = byId('routing-action-these-no-assistant');
    expect(none.expectation).toMatch(/must NOT assign a human/);
    expect(none.expectation).toMatch(/offer to set one up/);
  });

  it('the Madrid regression forbids the list of limitations and the closing question', () => {
    const c = byId('routing-madrid-regression');
    expect(c.transcript[0]!.toolsUsed).toEqual([]);
    expect(c.expectation).toMatch(/must NOT reply with a list of what it cannot see/);
    expect(c.expectation).toMatch(/must NOT end by asking who should take each one/);
  });

  it('frozen prefix ends on the user turn the candidate must answer', () => {
    for (const c of cases) {
      const prefix = buildFrozenPrefix(c);
      expect(prefix.at(-1)!.role).toBe('user');
      expect(prefix.at(-1)!.content).toBe(c.transcript[c.violatingTurnIndex]!.userMessage);
    }
  });

  it.each(['assistant-agent.ts', 'zoe-agent.ts'])(
    '%s registers the routing tools in its tool map and its instructions',
    (file) => {
      const source = readFileSync(new URL(`../agents/${file}`, import.meta.url), 'utf8');
      for (const exportName of ['listAssignableMembersTool', 'assignActionTool']) {
        // Once in the import list, once in the tool map.
        expect(source.match(new RegExp(`\\b${exportName}\\b`, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(2);
      }
      for (const id of ['list-assignable-members', 'assign-action']) {
        expect(source).toMatch(new RegExp(`\\*\\*${id}\\*\\*`));
      }
    },
  );
});
