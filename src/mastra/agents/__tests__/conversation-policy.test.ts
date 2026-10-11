import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { CONVERSATION_POLICY } from '../conversation-policy.js';

/**
 * The shared conversation block (Exponential ticket clear.flame): date
 * conflicts, repeated creates, one next step, hedged logistics. The agents
 * are checked as source text rather than imported: importing them boots the
 * memory store (same approach as routing-policy.test.ts).
 */
const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('CONVERSATION_POLICY', () => {
  it('date conflict: one line, asks which is right, writes nothing until answered', () => {
    expect(CONVERSATION_POLICY).toMatch(
      /date the user states conflicts with their calendar or with another date they stated, say the conflict in ONE line and ask which is right/,
    );
    expect(CONVERSATION_POLICY).toMatch(/Do not create, title or date anything that depends on it until they answer/);
    expect(CONVERSATION_POLICY).toMatch(/never pick one silently/);
  });

  it('repeated create: treated as "show me", re-links, checks for a duplicate, no joke', () => {
    expect(CONVERSATION_POLICY).toMatch(/\*\*The same create twice means "show me"\.\*\*/);
    expect(CONVERSATION_POLICY).toMatch(/repeats a create instruction for a name you already created in this conversation, do not create it again/);
    expect(CONVERSATION_POLICY).toMatch(/point to the existing item \(its name and link\)/);
    expect(CONVERSATION_POLICY).toMatch(/look it up to check no duplicate exists/);
    expect(CONVERSATION_POLICY).toMatch(/No joke, no celebration/);
  });

  it('a reply that creates or changes things ends with at most one next step and no menu', () => {
    expect(CONVERSATION_POLICY).toMatch(
      /reply that creates or changes something ends with at most ONE next step — a single question or suggestion — or none/,
    );
    expect(CONVERSATION_POLICY).toMatch(/No trailing menu of offers/);
  });

  it('logistics not looked up are hedged and never written into titles', () => {
    expect(CONVERSATION_POLICY).toMatch(/Logistics facts you did not get from a tool in this conversation/);
    expect(CONVERSATION_POLICY).toMatch(/are hedged \("usually", "worth checking"\)/);
    expect(CONVERSATION_POLICY).toMatch(/never written into an action or project title as a constraint/);
  });

  it('stays short: four numbered rules', () => {
    expect(CONVERSATION_POLICY.match(/^\d\. \*\*/gm)).toHaveLength(4);
  });

  it.each(['zoe-agent.ts', 'assistant-agent.ts'])(
    '%s inserts it once into the How You Work section',
    (file) => {
      const src = source(file);
      const section = src.slice(src.indexOf('## How You Work'), src.indexOf('### Request → Tool Mapping'));
      expect(section).toContain('${CONVERSATION_POLICY}');
      expect(src.split('${CONVERSATION_POLICY}')).toHaveLength(2);
      expect(src).toMatch(/import \{ CONVERSATION_POLICY \} from '\.\/conversation-policy\.js'/);
    },
  );

  it('is not in the run agent prompt (a run has no live user turn to ask)', () => {
    const src = source('assistant-run-agent.ts');
    expect(src).not.toContain('CONVERSATION_POLICY');
    expect(src).not.toContain('conversation-policy');
  });
});
