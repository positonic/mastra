import { describe, it, expect, vi } from 'vitest';

/**
 * The run agent's tool map is restricted **by construction** (Exponential
 * ADR-0067, Agent PRD D5): an unattended run never carries a tool that sends
 * email, books calendar events, or writes to Notion or the CRM. This test is
 * the guard — the prompt's SECURITY_POLICY is not relied on for it.
 *
 * `assistant-agent.ts` constructs real Anthropic provider tools at import, so
 * the module is loaded with the provider and memory stubbed.
 */
vi.mock('@ai-sdk/anthropic', () => {
  const provider = (() => ({ modelId: 'stub' })) as unknown as Record<string, unknown>;
  provider.tools = {
    webSearch_20250305: () => ({ id: 'web-search' }),
    webFetch_20250910: () => ({ id: 'web-fetch' }),
    toolSearchBm25_20251119: () => ({ id: 'tool-search' }),
  };
  return { anthropic: provider };
});
vi.mock('../../memory/index.js', () => ({ memory: {}, storage: {} }));
vi.mock('../../utils/anthropic-prompt-cache.js', () => ({
  withAnthropicPromptCache: (m: unknown) => m,
}));

const { assistantTools } = await import('../assistant-agent.js');
const {
  assistantRunTools,
  RUN_ALLOWED_ASSISTANT_TOOL_KEYS,
  RUN_EXCLUDED_TOOL_KEYS,
  assistantRunAgent,
} = await import('../assistant-run-agent.js');

const runToolsModule = await import('../../tools/run-tools.js');

const runKeys = Object.keys(assistantRunTools);
const RUN_TOOL_KEY = /^(finishRun|reportProgress|getRunContext|commentOnAction|askOwner|reassignAction|runUpdateAction)Tool$/;

describe('assistantRunAgent tool map (restricted by construction)', () => {
  it.each([...RUN_EXCLUDED_TOOL_KEYS])('does not carry %s', (key) => {
    expect(runKeys).not.toContain(key);
  });

  it('carries no outbound tool by pattern either — nothing that sends, or writes Notion/CRM/Slack/WhatsApp, or deletes', () => {
    const outbound = runKeys.filter((k) =>
      /^(send|reply)|Slack|WhatsApp|notion(Create|Update)|^(create|update|add).*Crm|^delete/.test(k),
    );
    expect(outbound).toEqual([]);
  });

  it('is a subset of the Assistant chat tools plus the run tools', () => {
    const chatKeys = new Set(Object.keys(assistantTools));
    const foreign = runKeys.filter((k) => !chatKeys.has(k) && !RUN_TOOL_KEY.test(k));
    expect(foreign).toEqual([]);
  });

  it('carries every allowed key, and every allowed key is a real Assistant tool', () => {
    // No `if (key in assistantTools)` guard: a renamed tool must fail here,
    // not silently vanish from runs (pickAllowed also throws at import).
    for (const key of RUN_ALLOWED_ASSISTANT_TOOL_KEYS) {
      expect(assistantTools).toHaveProperty(key);
      expect(runKeys).toContain(key);
    }
  });

  it('cannot set an action status: the chat update tool is absent and the run variant has no status field', () => {
    expect(runKeys).not.toContain('updateActionTool');
    const { runUpdateActionTool, runUpdateActionInputSchema } = runToolsModule;
    expect(assistantRunTools.runUpdateActionTool).toBe(runUpdateActionTool);
    expect(runUpdateActionTool.id).toBe('update-action');
    expect(runUpdateActionInputSchema.safeParse({ actionId: 'a1', name: 'Renamed' }).success).toBe(true);
    // strict: a status the model sends anyway is a validation error it sees,
    // not a silently stripped field.
    expect(runUpdateActionInputSchema.safeParse({ actionId: 'a1', status: 'COMPLETED' }).success).toBe(false);
  });

  it('does not carry tool search, so no run tool is deferred behind it', () => {
    // anthropic-prompt-cache.ts defers every function tool when a
    // tool_search provider tool is present.
    expect(runKeys).not.toContain('toolSearch');
  });

  it('carries finish-run', () => {
    expect(runKeys).toContain('finishRunTool');
  });

  it('allow-list and exclusion list never overlap', () => {
    const allowed = new Set<string>(RUN_ALLOWED_ASSISTANT_TOOL_KEYS);
    expect(RUN_EXCLUDED_TOOL_KEYS.filter((k) => allowed.has(k))).toEqual([]);
  });

  it('is registered under the id the app dispatches to', () => {
    expect(assistantRunAgent.id).toBe('assistantRunAgent');
  });
});

describe('assistantRunAgent run contract (prompt)', () => {
  it('tells the model ask-owner ends the run and finish-run is otherwise the last call', async () => {
    const { assistantRunInstructions } = await import('../assistant-run-agent.js');
    const text = assistantRunInstructions();
    expect(text).toMatch(/ask-owner[\s\S]*LAST call/);
    expect(text).toMatch(/do not call finish-run/i);
    expect(text).toMatch(/Exactly one ending/);
    expect(text).toMatch(/Never complete the action/);
    expect(text).toMatch(/no tool that sends email/);
  });
});
