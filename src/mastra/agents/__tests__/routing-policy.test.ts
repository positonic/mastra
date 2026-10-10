import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { ROUTING_POLICY } from '../routing-policy.js';

/**
 * The shared routing block (Exponential ADR-0068, Agent PRD D9). The agents
 * are checked as source text rather than imported: importing them boots the
 * memory store (same approach as toolsets.test.ts and decisions-eval.test.ts).
 */
const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('ROUTING_POLICY', () => {
  it('looks up the roster once before routing', () => {
    expect(ROUTING_POLICY).toMatch(/list-assignable-members\*\*[^\n]*once per turn for each project/);
    expect(ROUTING_POLICY).toMatch(/never reuse one project's roster for another/);
  });

  it('clear match: assigns a holder in the same turn and names holder and Position', () => {
    expect(ROUTING_POLICY).toMatch(/\*\*Clear match\*\*[\s\S]*assign-action\*\* a holder of that Position in the same turn/);
    expect(ROUTING_POLICY).toMatch(/"assigned to \{holder\}, who holds \{Position\}"/);
    expect(ROUTING_POLICY).toMatch(/not accountable for"[^.]*negative signal/);
    expect(ROUTING_POLICY).toMatch(/agent with no Position matches on its `agentDescription`/);
  });

  it('no match: assigns the requester', () => {
    expect(ROUTING_POLICY).toMatch(/\*\*No match\*\*[^\n]*assign the requester[^\n]*`isRequester`/);
  });

  it('ambiguity: assigns one and names the alternative in the same reply', () => {
    expect(ROUTING_POLICY).toMatch(/\*\*Ambiguity\*\*[^\n]*pick the best one, assign, and name the alternative in the same reply/);
  });

  it('"action these": hands existing actions to the matching Assistant, else the requester\'s own', () => {
    expect(ROUTING_POLICY).toMatch(/\*\*"Action these" \/ "handle this"\*\*/);
    expect(ROUTING_POLICY).toMatch(/Assistant\*\* — a member with an `assistantOwner` — whose Position or `agentDescription` fits/);
    expect(ROUTING_POLICY).toMatch(/else to the requester's own Assistant \(`isRequestersAssistant`\)/);
  });

  it('"action these": one honest line — researches and asks, never books or sends', () => {
    expect(ROUTING_POLICY).toMatch(/say in ONE line/);
    expect(ROUTING_POLICY).toMatch(/post what it finds as a comment, and ask you when it needs a decision/);
    expect(ROUTING_POLICY).toMatch(/won't book, buy, send email or change your calendar/);
  });

  it('"action these": reports a run that did not start, and never substitutes a human', () => {
    expect(ROUTING_POLICY).toMatch(/`agentRunsQueued`[^\n]*0 means no run started — say why/);
    expect(ROUTING_POLICY).toMatch(/null means you cannot confirm a run started/);
    expect(ROUTING_POLICY).toMatch(/no Assistant in this workspace[^\n]*do not assign a human instead/);
    expect(ROUTING_POLICY).toMatch(/Never complete the actions yourself/);
  });

  it('never invents ids and never retries a NOT_FOUND with someone else', () => {
    expect(ROUTING_POLICY).toMatch(/Never invent a member id/);
    expect(ROUTING_POLICY).toMatch(/NOT_FOUND[^\n]*do not retry with a different person/);
  });

  it.each(['zoe-agent.ts', 'assistant-agent.ts'])(
    '%s appends it to the Action & Task Management section and lists both tools',
    (file) => {
      const src = source(file);
      const section = src.slice(
        src.indexOf('### Action & Task Management'),
        src.indexOf('### Project Intelligence'),
      );
      expect(section).toContain('${ROUTING_POLICY}');
      expect(section).toMatch(/\*\*list-assignable-members\*\*/);
      expect(section).toMatch(/\*\*assign-action\*\*/);
      expect(src).toMatch(/import \{ ROUTING_POLICY \} from '\.\/routing-policy\.js'/);
    },
  );

  it('is not in the run agent prompt (the run delegates through reassign-action)', () => {
    expect(source('assistant-run-agent.ts')).not.toContain('ROUTING_POLICY');
  });
});
