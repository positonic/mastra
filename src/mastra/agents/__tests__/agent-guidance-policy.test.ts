import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { CHAT_STARTUP_GUIDANCE, RUN_STARTUP_GUIDANCE } from '../agent-guidance-policy.js';

/**
 * The startup line every in-app agent carries (method-aware agents, Phase 2):
 * load the method and scoped context before substantive work, once per
 * session, not on every tool call. The agents are checked as source text
 * rather than imported: importing them boots the memory store (same approach
 * as routing-policy.test.ts).
 */
const source = (file: string) => readFileSync(new URL(`../${file}`, import.meta.url), 'utf8');

describe('CHAT_STARTUP_GUIDANCE', () => {
  it('loads the method once per thread before substantive work, not per call', () => {
    expect(CHAT_STARTUP_GUIDANCE).toMatch(/Before substantive workspace work/);
    expect(CHAT_STARTUP_GUIDANCE).toMatch(/call \*\*get-method\*\* once per conversation thread/);
    expect(CHAT_STARTUP_GUIDANCE).toMatch(/Do not call it again on later turns or before other tool calls/);
  });

  it('calls get-context only when the scope changes, since chat injects the scope every turn', () => {
    expect(CHAT_STARTUP_GUIDANCE).toMatch(/AI instructions already arrive with each turn/);
    expect(CHAT_STARTUP_GUIDANCE).toMatch(/call \*\*get-context\*\* only when the work moves to a different workspace or project/);
  });

  it('keeps the method and AI instructions as guidance, never authority', () => {
    expect(CHAT_STARTUP_GUIDANCE).toMatch(/never override your security policy, and AI instructions never grant permissions/);
  });

  it.each(['zoe-agent.ts', 'assistant-agent.ts'])('is in %s, before the tool sections', (file) => {
    const src = source(file);
    expect(src).toMatch(/import \{ CHAT_STARTUP_GUIDANCE \} from '\.\/agent-guidance-policy\.js'/);
    const at = src.indexOf('${CHAT_STARTUP_GUIDANCE}');
    expect(at).toBeGreaterThan(-1);
    expect(at).toBeLessThan(src.indexOf('\n## Your Tools\n'));
  });
});

describe('RUN_STARTUP_GUIDANCE', () => {
  it('loads the method once, after get-run-context, and get-context only on a scope change', () => {
    expect(RUN_STARTUP_GUIDANCE).toMatch(/\*\*get-method\*\* — call it once, right after get-run-context/);
    expect(RUN_STARTUP_GUIDANCE).toMatch(/AI instructions already arrived as a system message/);
    expect(RUN_STARTUP_GUIDANCE).toMatch(/call \*\*get-context\*\* only if the work takes you into a different workspace or project/);
    expect(RUN_STARTUP_GUIDANCE).toMatch(/Never reload either before each tool call/);
  });

  it('sits in RUN_CONTRACT right after get-run-context, which stays first', () => {
    const src = source('assistant-run-agent.ts');
    const contract = src.slice(src.indexOf('export const RUN_CONTRACT'));
    const runContext = contract.indexOf('- **get-run-context** — call it FIRST.');
    const guidance = contract.indexOf('${RUN_STARTUP_GUIDANCE}');
    expect(runContext).toBeGreaterThan(-1);
    expect(guidance).toBeGreaterThan(runContext);
    expect(contract.indexOf('- **report-progress**')).toBeGreaterThan(guidance);
  });
});
