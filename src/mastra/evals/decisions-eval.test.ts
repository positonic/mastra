import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { casesFileSchema, buildFrozenPrefix } from './replay.js';

/**
 * Eval cases for the Decision tools (exponential ADR-0060, ticket royal.ram):
 * "log the decision from the standup" must call log-decision rather than
 * deflect, and "D-0003 is superseded by D-0005" must resolve labels through
 * list-decisions and call update-decision.
 *
 * Feed them to the live runner with
 *   npm run eval-replay -- src/mastra/evals/fixtures/decisions-cases.json
 * This test is the deterministic, CI-safe guard: the fixture stays
 * schema-valid, the expectations name the tools, and the tools are actually
 * registered on BOTH agents — in the tool map AND the instruction tool list
 * (a tool in the map but not the instructions is ignored; one in neither
 * would make the replay's intent capture miss it). The agents are checked as
 * source text rather than imported: importing them boots the memory store.
 */
const raw = readFileSync(
  new URL('./fixtures/decisions-cases.json', import.meta.url),
  'utf8',
);

describe('decisions eval cases', () => {
  it('is a schema-valid cases file the replay runner can consume', () => {
    const parsed = casesFileSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
  });

  it('names the decision tools in the expectations', () => {
    const { cases } = casesFileSchema.parse(JSON.parse(raw));
    const log = cases.find((c) => c.id === 'decisions-log-from-standup-no-deflection')!;
    expect(log.expectation).toMatch(/log-decision/);
    expect(log.expectation).toMatch(/not deflect|must not ask/i);
    const supersede = cases.find((c) => c.id === 'decisions-supersede-by-label')!;
    expect(supersede.expectation).toMatch(/list-decisions/);
    expect(supersede.expectation).toMatch(/update-decision/);
  });

  it.each(['assistant-agent.ts', 'zoe-agent.ts'])(
    '%s registers the decision tools in its tool map and its instructions',
    (file) => {
      const source = readFileSync(new URL(`../agents/${file}`, import.meta.url), 'utf8');
      for (const exportName of ['logDecisionTool', 'updateDecisionTool', 'listDecisionsTool']) {
        // Once in the import list, once in the tool map.
        expect(source.match(new RegExp(`\\b${exportName}\\b`, 'g'))?.length ?? 0).toBeGreaterThanOrEqual(2);
      }
      for (const id of ['log-decision', 'update-decision', 'list-decisions']) {
        expect(source).toMatch(new RegExp(`\\*\\*${id}\\*\\*`));
      }
    },
  );

  it('frozen prefix surfaces the decision request for the candidate to answer', () => {
    const { cases } = casesFileSchema.parse(JSON.parse(raw));
    const prefix = buildFrozenPrefix(cases[0]!);
    expect(prefix.at(-1)!.role).toBe('user');
    expect(prefix.at(-1)!.content).toMatch(/prioritisation/i);
  });
});
