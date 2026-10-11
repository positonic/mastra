import { describe, it, expect, vi, beforeEach } from 'vitest';
import { readFileSync } from 'fs';
import { fileURLToPath } from 'url';
import { dirname, join } from 'path';

import {
  ANTHROPIC_ONLY_TOOL_KEYS,
  TOOL_GROUPS,
  TOOLSET_IDS,
  TOOLSETS_CONTEXT_KEY,
  agentTools,
  createToolsResolver,
  groupTools,
  parseToolsetSelection,
  resetUnknownToolsetWarnings,
  sanitizeToolsetIdForLog,
  selectTools,
} from '../toolsets.js';

const here = dirname(fileURLToPath(import.meta.url));

/**
 * Read the keys of a tool-map object literal straight from the agent source.
 * Importing the agent modules would construct the Postgres-backed memory
 * store, so the coverage check works on source text instead. Handles both
 * shorthand entries (`fooTool,`) and keyed ones (`webSearch: anthropic...`).
 */
function toolKeysFromSource(file: string, constName: string): string[] {
  const src = readFileSync(join(here, '..', file), 'utf8');
  const start = src.indexOf(`const ${constName} = {`);
  expect(start, `${constName} not found in ${file}`).toBeGreaterThan(-1);
  const end = src.indexOf('\n};', start);
  const body = src
    .slice(src.indexOf('{', start) + 1, end)
    .replace(/\/\/.*$/gm, '');
  const keys: string[] = [];
  for (const line of body.split('\n')) {
    const m = /^\s*([A-Za-z_$][\w$]*)\s*(?:[:,]|$)/.exec(line);
    if (m?.[1]) keys.push(m[1]);
  }
  return [...new Set(keys)];
}

const zoeKeys = toolKeysFromSource('zoe-agent.ts', 'zoeTools');
const assistantKeys = toolKeysFromSource('assistant-agent.ts', 'assistantTools');

// Stand-in tool objects: selectTools never inspects them.
const fake = (keys: string[]) => Object.fromEntries(keys.map((k) => [k, { id: k }]));

describe('tool map coverage', () => {
  it('parses a plausible number of tools from each agent', () => {
    expect(zoeKeys.length).toBeGreaterThan(60);
    expect(assistantKeys.length).toBeGreaterThan(60);
    expect(zoeKeys).toContain('toolSearch');
    expect(zoeKeys).toContain('webSearch');
  });

  it.each([
    ['zoeTools', zoeKeys],
    ['assistantTools', assistantKeys],
  ])('assigns every %s key to a group', (_name, keys) => {
    const unassigned = keys.filter((k) => k !== 'toolSearch' && !TOOL_GROUPS[k]);
    expect(unassigned, 'add these to TOOL_GROUPS in toolsets.ts').toEqual([]);
  });

  it('has no stale TOOL_GROUPS entries that neither agent registers', () => {
    const registered = new Set([...zoeKeys, ...assistantKeys]);
    const stale = Object.keys(TOOL_GROUPS).filter((k) => !registered.has(k));
    expect(stale).toEqual([]);
  });

  it('keeps CORE small — the whole point of the split', () => {
    const core = Object.values(TOOL_GROUPS).filter((g) => g === 'core');
    // 11 + the two routing tools (ADR-0068 in exponential): routing a new
    // action happens in the same short turn as creating it.
    expect(core.length).toBeLessThanOrEqual(13);
  });

  it('only uses declared toolset ids', () => {
    const allowed = new Set<string>(['core', ...TOOLSET_IDS]);
    expect(Object.values(TOOL_GROUPS).filter((g) => !allowed.has(g))).toEqual([]);
  });
});

describe('parseToolsetSelection', () => {
  it('distinguishes absent from empty', () => {
    expect(parseToolsetSelection(undefined)).toBeUndefined();
    expect(parseToolsetSelection(null)).toBeUndefined();
    expect(parseToolsetSelection('')).toEqual([]);
  });

  it('parses comma strings and arrays, trims, dedupes, drops unknown ids', () => {
    expect(parseToolsetSelection(' slack, crm ,slack,banana')).toEqual(['slack', 'crm']);
    expect(parseToolsetSelection(['meetings', 'web', 'nope'])).toEqual(['meetings', 'web']);
  });

  it('ignores non-string, non-array values', () => {
    expect(parseToolsetSelection(42)).toBeUndefined();
  });
});

describe('parseToolsetSelection — unknown-id warnings', () => {
  beforeEach(() => {
    resetUnknownToolsetWarnings();
    vi.restoreAllMocks();
  });

  it('warns once per unknown id across calls, and still returns the known subset', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    expect(parseToolsetSelection('crm,contacts')).toEqual(['crm']);
    expect(parseToolsetSelection('contacts,slack')).toEqual(['slack']);
    expect(warn).toHaveBeenCalledTimes(1);
    expect(String(warn.mock.calls[0]?.[0])).toContain('"contacts"');
  });

  it('warns separately for each distinct unknown id', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseToolsetSelection(['banana', 'kiwi', 'banana']);
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('stops remembering (and warning) after 50 distinct unknown ids', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseToolsetSelection(Array.from({ length: 200 }, (_, i) => `junk${i}`));
    expect(warn).toHaveBeenCalledTimes(50);
  });

  it('truncates long ids and strips control characters before logging', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseToolsetSelection(`x${'a'.repeat(500)}`);
    parseToolsetSelection('evil\n[ERROR] forged line');
    const logged = warn.mock.calls.map((c) => String(c[0]));
    expect(logged[0]).toContain(`x${'a'.repeat(63)}…`);
    expect(logged[0]).not.toContain('a'.repeat(100));
    expect(logged[1]).not.toContain('\n');
    expect(logged[1]).toContain('evil?[ERROR] forged line');
  });

  it('sanitizeToolsetIdForLog leaves ordinary ids alone', () => {
    expect(sanitizeToolsetIdForLog('contacts')).toBe('contacts');
  });

  it('does not warn for blanks or known ids', () => {
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {});
    parseToolsetSelection(' , slack,, crm ');
    parseToolsetSelection('');
    expect(warn).not.toHaveBeenCalled();
  });
});

describe('selectTools — anthropic profile', () => {
  it('returns the full map unchanged, whatever the selection', () => {
    const all = fake(zoeKeys);
    expect(selectTools(all, 'anthropic', undefined)).toBe(all);
    expect(selectTools(all, 'anthropic', ['slack'])).toBe(all);
  });
});

describe('selectTools — generic profile', () => {
  const all = fake(zoeKeys);
  const coreKeys = Object.entries(TOOL_GROUPS)
    .filter(([, g]) => g === 'core')
    .map(([k]) => k)
    .sort();

  it('sends only CORE for a "hi" turn (no selection)', () => {
    expect(Object.keys(selectTools(all, 'generic', undefined)).sort()).toEqual(coreKeys);
  });

  it('sends only CORE when the selection is empty', () => {
    expect(Object.keys(selectTools(all, 'generic', [])).sort()).toEqual(coreKeys);
  });

  it('adds exactly the selected toolsets', () => {
    const keys = Object.keys(selectTools(all, 'generic', ['slack', 'meetings']));
    expect(keys).toEqual(expect.arrayContaining([...coreKeys, 'searchSlackMessagesTool', 'getMeetingInsightsTool']));
    expect(keys).not.toContain('searchCrmContactsTool');
    expect(keys).not.toContain('createTicketTool');
  });

  it('never includes Anthropic-only provider tools, even when web is selected', () => {
    const keys = Object.keys(selectTools(all, 'generic', [...TOOLSET_IDS]));
    for (const k of ANTHROPIC_ONLY_TOOL_KEYS) expect(keys).not.toContain(k);
  });

  it('keeps an ungrouped tool reachable rather than dropping it', () => {
    const keys = Object.keys(selectTools({ ...all, brandNewTool: { id: 'x' } }, 'generic', undefined));
    expect(keys).toContain('brandNewTool');
  });

  it('shrinks a "hi" turn to a fraction of the full map', () => {
    const generic = Object.keys(selectTools(all, 'generic', undefined)).length;
    expect(generic / zoeKeys.length).toBeLessThan(0.2);
  });
});

describe('createToolsResolver', () => {
  const all = fake(zoeKeys);
  const ctx = (value: unknown) => ({ get: (k: string) => (k === TOOLSETS_CONTEXT_KEY ? value : undefined) });

  it('anthropic resolver ignores the context entirely', () => {
    const resolve = createToolsResolver(all, 'anthropic');
    expect(resolve({ requestContext: ctx('slack') })).toBe(all);
    expect(resolve({})).toBe(all);
  });

  it('generic resolver reads the toolsets entry from RequestContext', () => {
    const resolve = createToolsResolver(all, 'generic');
    expect(Object.keys(resolve({ requestContext: ctx('crm') }))).toContain('searchCrmContactsTool');
    expect(Object.keys(resolve({ requestContext: ctx(undefined) }))).not.toContain('searchCrmContactsTool');
  });

  it('generic resolver works with no RequestContext (agent listing, playground)', () => {
    const resolve = createToolsResolver(all, 'generic');
    expect(Object.keys(resolve({})).length).toBeGreaterThan(0);
  });
});

describe('agentTools', () => {
  const all = fake(zoeKeys);

  it('returns the static map itself for the anthropic profile', () => {
    // @mastra/core only registers tools on the Mastra instance (and voice)
    // when the Agent's `tools` option is a plain object.
    const tools = agentTools(all, 'anthropic');
    expect(typeof tools).toBe('object');
    expect(tools).toBe(all);
  });

  it('returns a per-request resolver for the generic profile', () => {
    const tools = agentTools(all, 'generic');
    expect(typeof tools).toBe('function');
    const resolved = (tools as (a: { requestContext?: { get(k: string): unknown } }) => Record<string, unknown>)({
      requestContext: { get: (k) => (k === TOOLSETS_CONTEXT_KEY ? 'crm' : undefined) },
    });
    expect(Object.keys(resolved)).toContain('searchCrmContactsTool');
  });
});

describe('agent definitions', () => {
  it.each(['zoe-agent.ts', 'assistant-agent.ts'])('%s passes tools through agentTools, not a raw resolver', (file) => {
    const src = readFileSync(join(here, '..', file), 'utf8');
    expect(src).not.toMatch(/tools:\s*createToolsResolver\(/);
    expect(src.match(/tools:\s*agentTools\(\w+, 'anthropic'\)/g)?.length).toBe(2);
  });
});

describe('groupTools', () => {
  it('puts toolSearch in no group', () => {
    const { groups, unassigned } = groupTools(fake(zoeKeys));
    expect(unassigned).toEqual([]);
    for (const g of Object.values(groups)) expect(Object.keys(g ?? {})).not.toContain('toolSearch');
  });
});
