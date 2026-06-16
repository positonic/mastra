import { describe, it, expect, vi } from 'vitest';
import type { z } from 'zod';

// Regression guard for the failure class documented in zod-loose.ts: the model
// (Haiku especially) emits JSON-stringified scalars ("19", "false") instead of
// native number/boolean. A bare z.number()/z.boolean() rejects those at the
// AI-SDK input-validation layer — BEFORE execute() runs — so the agent burns
// retries and gives up. These tests exercise that exact layer: parse the tool's
// inputSchema with the wrong-but-plausible primitive and assert it is accepted
// and normalised. (See the goalId incident that motivated this.)

vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: vi.fn(),
}));

// Mastra exposes inputSchema as a StandardSchema wrapper; the underlying zod
// schema still has .parse at runtime. Cast to validate/coerce directly.
const parseInput = (
  tool: { inputSchema?: unknown },
  value: unknown,
): Record<string, unknown> =>
  (tool.inputSchema as z.ZodTypeAny).parse(value) as Record<string, unknown>;

const {
  createOkrKeyResultTool,
  updateOkrObjectiveTool,
  checkInOkrKeyResultTool,
  createOkrObjectiveTool,
  linkObjectiveToParentTool,
} = await import('./okr-tools.js');
const {
  getAllProjectsTool,
  getMeetingTranscriptionsTool,
  findAvailableTimeSlotsTool,
} = await import('./index.js');
const { bulkCreateWorkspaceStructureTool, deleteProjectTool } = await import(
  './project-tools.js'
);
const { sendEmailTool, replyToEmailTool, getRecentEmailsTool } = await import(
  './email-tools.js'
);
const { createTicketTool } = await import('./ticket-tools.js');
const { listSlackChannelsTool } = await import('./slack-tools.js');
const { findRelatedMeetingsTool } = await import('./meeting-context-tools.js');
const { createSetupTool } = await import('./tradescape-tools.js');
const { listWhatsAppChatsTool } = await import('./whatsapp-tools.js');
const { getActionItemsTool } = await import('./action-items-tools.js');
const { searchDocumentsTool } = await import('./document-tools.js');

// Parse a single input field's schema in isolation (avoids constructing a full
// valid tool input). Each field on a ZodObject is an independent schema.
const parseField = (tool: { inputSchema?: unknown }, field: string, value: unknown): unknown =>
  ((tool.inputSchema as any).shape[field] as z.ZodTypeAny).parse(value);

describe('tool input coercion — the model emits scalars as strings', () => {
  it('getAllProjectsTool.includeAll: string "false" stays false (NOT the z.coerce.boolean footgun)', () => {
    // z.coerce.boolean("false") === true would silently invert the flag.
    expect(parseInput(getAllProjectsTool, { includeAll: 'false' }).includeAll).toBe(false);
    expect(parseInput(getAllProjectsTool, { includeAll: 'true' }).includeAll).toBe(true);
    expect(parseInput(getAllProjectsTool, {}).includeAll).toBe(false); // default
  });

  it('createOkrKeyResultTool coerces string numerics (goalId, targetValue, startValue)', () => {
    const parsed = parseInput(createOkrKeyResultTool, {
      goalId: '7',
      title: 'Increase MRR to $20k',
      targetValue: '20000',
      startValue: '10000',
      period: 'Q1-2026',
    });
    expect(parsed.goalId).toBe(7);
    expect(parsed.targetValue).toBe(20000);
    expect(parsed.startValue).toBe(10000);
  });

  it('checkInOkrKeyResultTool coerces a string newValue', () => {
    const parsed = parseInput(checkInOkrKeyResultTool, {
      keyResultId: 'kr_1',
      newValue: '42',
    });
    expect(parsed.newValue).toBe(42);
  });

  it('updateOkrObjectiveTool coerces a string id', () => {
    const parsed = parseInput(updateOkrObjectiveTool, { id: '19' });
    expect(parsed.id).toBe(19);
  });

  it('still rejects genuine garbage (coercion is not blind acceptance)', () => {
    expect(() => parseInput(checkInOkrKeyResultTool, { keyResultId: 'kr_1', newValue: 'banana' })).toThrow();
  });
});

describe('goal hierarchy — parentGoalId coercion', () => {
  it('createOkrObjectiveTool coerces a string parentGoalId', () => {
    const parsed = parseInput(createOkrObjectiveTool, { title: 'Phase 0', parentGoalId: '19' });
    expect(parsed.parentGoalId).toBe(19);
  });

  it('createOkrObjectiveTool allows omitting parentGoalId (top-level goal)', () => {
    const parsed = parseInput(createOkrObjectiveTool, { title: 'North star' });
    expect(parsed.parentGoalId).toBeUndefined();
  });

  it('linkObjectiveToParentTool coerces a string parentGoalId and accepts null to detach', () => {
    expect(parseInput(linkObjectiveToParentTool, { goalId: '70', parentGoalId: '19' })).toMatchObject({
      goalId: 70,
      parentGoalId: 19,
    });
    expect(parseInput(linkObjectiveToParentTool, { goalId: '70', parentGoalId: null }).parentGoalId).toBeNull();
  });

  it('bulkCreateWorkspaceStructureTool coerces parentGoalId at batch and per-goal level', () => {
    const parsed = parseInput(bulkCreateWorkspaceStructureTool, {
      workspaceId: 'ws_1',
      parentGoalId: '19',
      goals: [{ title: 'Phase 1', parentGoalId: '20' }],
    });
    expect(parsed.parentGoalId).toBe(19);
    expect((parsed.goals as Array<{ parentGoalId: number }>)[0]!.parentGoalId).toBe(20);
  });
});

// ── Scalar coercion sweep (deep.rune) ───────────────────────────────────────
// One representative swept field from every tool file, each asserting the three
// behaviours the sweep guarantees: stringified value coerces, native value is
// unchanged, and genuine garbage still throws (coercion is not blind
// acceptance). The keystone-guard.test.ts enforces that the *rest* of the
// scalar fields are wrapped; these rows pin the runtime behaviour.

describe('scalar sweep — number fields coerce, pass through, and reject garbage', () => {
  // `from`/`to` is the coercion case (chosen in-range for each field's
  // .min/.max); the native passthrough re-uses `to`.
  const numberFields: Array<{ name: string; tool: unknown; field: string; from: string; to: number }> = [
    { name: 'getActionItemsTool.limit', tool: getActionItemsTool, field: 'limit', from: '7', to: 7 },
    { name: 'searchDocumentsTool.similarityThreshold', tool: searchDocumentsTool, field: 'similarityThreshold', from: '0.7', to: 0.7 },
    { name: 'getRecentEmailsTool.maxResults', tool: getRecentEmailsTool, field: 'maxResults', from: '7', to: 7 },
    { name: 'findRelatedMeetingsTool.matchThreshold', tool: findRelatedMeetingsTool, field: 'matchThreshold', from: '0.7', to: 0.7 },
    { name: 'listSlackChannelsTool.limit', tool: listSlackChannelsTool, field: 'limit', from: '7', to: 7 },
    { name: 'createTicketTool.points', tool: createTicketTool, field: 'points', from: '7', to: 7 },
    { name: 'createSetupTool.entryPrice', tool: createSetupTool, field: 'entryPrice', from: '100.5', to: 100.5 },
    { name: 'listWhatsAppChatsTool.limit', tool: listWhatsAppChatsTool, field: 'limit', from: '7', to: 7 },
    { name: 'getMeetingTranscriptionsTool.maxTranscriptLength', tool: getMeetingTranscriptionsTool, field: 'maxTranscriptLength', from: '1500', to: 1500 },
    { name: 'findAvailableTimeSlotsTool.startHour', tool: findAvailableTimeSlotsTool, field: 'startHour', from: '9', to: 9 },
  ];

  it.each(numberFields)('$name: "$from" → $to, native → $to, "banana" throws', ({ tool, field, from, to }) => {
    const t = tool as { inputSchema?: unknown };
    expect(parseField(t, field, from)).toBe(to); // stringified coerces
    expect(parseField(t, field, to)).toBe(to); // native passes through
    expect(() => parseField(t, field, 'banana')).toThrow(); // garbage rejected
  });

  it('createTicketTool.priority keeps its .min/.max INSIDE the wrapper (out-of-range still throws)', () => {
    expect(parseField(createTicketTool, 'priority', '3')).toBe(3);
    expect(() => parseField(createTicketTool, 'priority', '9')).toThrow(); // max(4) preserved
    expect(() => parseField(createTicketTool, 'priority', 'banana')).toThrow();
  });
});

describe('scalar sweep — boolean fields coerce contents (not the z.coerce footgun)', () => {
  const booleanFields: Array<{ name: string; tool: unknown; field: string }> = [
    { name: 'sendEmailTool.userConfirmed', tool: sendEmailTool, field: 'userConfirmed' },
    { name: 'replyToEmailTool.userConfirmed', tool: replyToEmailTool, field: 'userConfirmed' },
    { name: 'deleteProjectTool.confirmDeletion', tool: deleteProjectTool, field: 'confirmDeletion' },
    { name: 'getRecentEmailsTool.unreadOnly', tool: getRecentEmailsTool, field: 'unreadOnly' },
    { name: 'listSlackChannelsTool.excludeArchived', tool: listSlackChannelsTool, field: 'excludeArchived' },
    { name: 'getMeetingTranscriptionsTool.includeTranscript', tool: getMeetingTranscriptionsTool, field: 'includeTranscript' },
  ];

  it.each(booleanFields)('$name: "false" → false (NOT inverted), "true" → true, native passes', ({ tool, field }) => {
    const t = tool as { inputSchema?: unknown };
    // z.coerce.boolean("false") === true would silently invert the gate — these
    // confirmation gates make that the difference between sending and not.
    expect(parseField(t, field, 'false')).toBe(false);
    expect(parseField(t, field, 'true')).toBe(true);
    expect(parseField(t, field, true)).toBe(true);
    expect(parseField(t, field, false)).toBe(false);
  });

  it('a confirmation gate rejects genuine garbage rather than defaulting it', () => {
    expect(() => parseField(sendEmailTool, 'userConfirmed', 'banana')).toThrow();
  });
});
