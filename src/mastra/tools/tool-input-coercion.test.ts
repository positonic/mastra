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
const { getAllProjectsTool } = await import('./index.js');
const { bulkCreateWorkspaceStructureTool } = await import('./project-tools.js');

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
