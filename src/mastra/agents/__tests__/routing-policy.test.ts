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
    expect(ROUTING_POLICY).toMatch(/list-assignable-members\*\* once this turn/);
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
