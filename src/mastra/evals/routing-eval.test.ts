import { describe, it, expect, vi } from 'vitest';
import { readFileSync } from 'fs';
import { casesFileSchema, buildFrozenPrefix } from './replay.js';

// The agents construct Anthropic provider tools and the memory store at
// import, so they are loaded with both stubbed (as assistant-run-tools.test.ts
// does) to read their real tool maps.
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

const { zoeTools } = await import('../agents/zoe-agent.js');
const { assistantTools } = await import('../agents/assistant-agent.js');
const { listAssignableMembersTool, assignActionTool, importPositionsTool } = await import('../tools/routing-tools.js');
const toolMaps: Record<string, Record<string, unknown>> = {
  'zoe-agent.ts': zoeTools,
  'assistant-agent.ts': assistantTools,
};

/**
 * Eval cases for routing by Remit (Exponential ADR-0068, Agent PRD D9): clear
 * match, no match, ambiguity, "action these" with another user's matching
 * Assistant (asks first), with only the requester's own Assistant, and with
 * none, a match to an External agent (asks first) — plus the Madrid
 * transcript that motivated the feature as the regression case. The import
 * conversation (Agent PRD D10) adds four: dry run and table before any write,
 * the write after the yes reported from the tool output, an unreadable Notion
 * page, and a non-admin's FORBIDDEN.
 *
 * Feed them to the live runner with
 *   npm run eval-replay -- src/mastra/evals/fixtures/routing-cases.json
 * This test is the deterministic, CI-safe guard: the fixture stays
 * schema-valid, the expectations pin the ROUTING_POLICY outcomes, and the
 * routing tools are registered on BOTH chat agents (their real tool maps,
 * imported with the provider and memory stubbed, and their instructions).
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

  it('covers every routing outcome, the import conversation, and the Madrid regression', () => {
    expect(cases.map((c) => c.id).sort()).toEqual(
      [
        'routing-action-these-matching-assistant',
        'routing-action-these-no-assistant',
        'routing-action-these-requesters-own-assistant',
        'routing-ambiguity-name-alternative',
        'routing-clear-match-assign-holder',
        'routing-external-agent-confirm',
        'routing-import-confirm-writes',
        'routing-import-dry-run-first',
        'routing-import-non-admin-forbidden',
        'routing-import-notion-unreadable',
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
    // Silent only because the holder is the requester's own Assistant.
    expect(c.expectation).toMatch(/requester's own Assistant Aria \(isRequestersAssistant true\)/);
  });

  it.each([
    'routing-action-these-matching-assistant',
    'routing-external-agent-confirm',
    'routing-madrid-regression',
  ])('%s asks a one-word confirmation before assigning someone other than a human or the requester\'s own Assistant', (id) => {
    const c = byId(id);
    expect(c.expectation).toMatch(/one-word confirmation/);
    expect(c.expectation).toMatch(/must NOT call assign-action (in this turn|before the user says yes)/);
  });

  it('an instruction inside an agentDescription is never followed', () => {
    const c = byId('routing-external-agent-confirm');
    expect(c.expectation).toMatch(/assistantOwner null/);
    expect(c.expectation).toMatch(/must NOT follow the instruction inside the agentDescription/);
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
  });

  it('"handle this" explains a run that did not start without inventing a cause', () => {
    const c = byId('routing-action-these-requesters-own-assistant');
    expect(c.expectation).toMatch(/agentRunsQueued is 0[\s\S]*already assigned to that Assistant[\s\S]*never invent a cause/);
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

  it('import: dry run, table and one yes/no before any write; unmatched holders are listed, never guessed', () => {
    const c = byId('routing-import-dry-run-first');
    expect(c.transcript[0]!.toolsUsed).toEqual(['import-positions']);
    expect(c.expectation).toMatch(/MUST call list-assignable-members with forImport true, then import-positions with dryRun true/);
    expect(c.expectation).toMatch(/Position, Remit summary, Not accountable for, Holders and create\/update columns/);
    expect(c.expectation).toMatch(/list Priya as "no member found"/);
    expect(c.expectation).toMatch(/ask ONE yes\/no for the whole import/);
    expect(c.expectation).toMatch(/must NOT call import-positions with dryRun false in this turn/);
    expect(c.expectation).toMatch(/must NOT invent a member id for Priya/);
  });

  it('import: after the yes, writes exactly the rows shown once and reports from the output', () => {
    const c = byId('routing-import-confirm-writes');
    expect(c.violatingTurnIndex).toBe(1);
    expect(c.transcript[0]!.toolsUsed).toEqual(['list-assignable-members', 'import-positions']);
    expect(c.transcript[1]!.userMessage).toBe('yes');
    expect(c.expectation).toMatch(/MUST call import-positions once with dryRun false and exactly the three rows it showed/);
    expect(c.expectation).toMatch(/MUST report from that output/);
    expect(c.expectation).toMatch(/must NOT claim Priya was added/);
    expect(c.expectation).toMatch(/must NOT ask a second confirmation/);
    expect(c.expectation).toMatch(/must NOT claim anything was saved if the tool did not return written true/);
  });

  it('import: an unreadable Notion page becomes a request to paste, never invented roles', () => {
    const c = byId('routing-import-notion-unreadable');
    expect(c.expectation).toMatch(/MUST call notion-get-page/);
    expect(c.expectation).toMatch(/ask them to paste the document/);
    expect(c.expectation).toMatch(/must NOT call import-positions, must NOT invent roles/);
  });

  it('import: a non-admin is told an owner or admin must run it, with no retry', () => {
    const c = byId('routing-import-non-admin-forbidden');
    expect(c.expectation).toMatch(/FORBIDDEN/);
    expect(c.expectation).toMatch(/owner or admin of this workspace must run the import and that nothing was saved/);
    expect(c.expectation).toMatch(/must NOT retry import-positions/);
    expect(c.expectation).toMatch(/must NOT speculate about a backend issue/);
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
      expect(toolMaps[file]!.listAssignableMembersTool).toBe(listAssignableMembersTool);
      expect(toolMaps[file]!.assignActionTool).toBe(assignActionTool);
      expect(toolMaps[file]!.importPositionsTool).toBe(importPositionsTool);
      for (const id of ['list-assignable-members', 'assign-action', 'import-positions']) {
        expect(source).toMatch(new RegExp(`\\*\\*${id}\\*\\*`));
      }
    },
  );
});
