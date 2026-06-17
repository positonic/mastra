import { createTool } from '@mastra/core/tools';
import { z } from 'zod';

/**
 * Eval replay — frozen-prefix, single-call, tools never execute
 * (ADR-0013 decisions 1+2 in the exponential repo).
 *
 * An EvalCase (exported from exponential's Postgres) carries the transcript
 * of a scored-bad Thread plus the index of the violating turn. A replay
 * feeds the prefix up to that turn to a candidate brain — instantiated
 * in-process from THIS working tree, so the candidate prompt is whatever
 * branch is checked out — and regenerates only the violating turn's
 * response. Tool calls are captured as intent and NEVER executed: a
 * candidate brain must not be able to write anywhere during an eval run.
 *
 * This module holds the pure, unit-testable pieces; the CLI entry point is
 * eval-replay.ts next door.
 */

/** One turn of a stored Thread transcript — mirrors exponential's
 * AgentEvalService TranscriptTurn (EvalCase.transcript JSON). */
export const transcriptTurnSchema = z.object({
  userMessage: z.string(),
  aiResponse: z.string(),
  toolsUsed: z.array(z.string()).default([]),
  hadError: z.boolean().default(false),
  responseTime: z.number().nullable().optional(),
  createdAt: z.string().optional(),
});
export type TranscriptTurn = z.infer<typeof transcriptTurnSchema>;

export const replayCaseSchema = z.object({
  id: z.string(),
  conversationId: z.string().optional(),
  transcript: z.array(transcriptTurnSchema).min(1),
  /** 0-based index into transcript; replay feeds transcript[0..index) plus
   * that turn's user message as the frozen prefix. */
  violatingTurnIndex: z.number().int().min(0),
  /** The contract expectation the original turn violated. Not used by the
   * runner (judging is exponential-side) but carried through to results so
   * the output file is self-describing. */
  expectation: z.string().optional(),
  lane: z.string().optional(),
});
export type ReplayCase = z.infer<typeof replayCaseSchema>;

export const casesFileSchema = z.object({
  cases: z.array(replayCaseSchema).min(1),
});

export interface ReplayMessage {
  role: 'user' | 'assistant';
  content: string;
}

/** A tool call the candidate attempted during replay. Recorded, never run. */
export interface ToolIntent {
  toolName: string;
  args: unknown;
}

export interface ReplayCaseResult {
  caseId: string;
  expectation?: string;
  /** The regenerated violating-turn response from the candidate brain. */
  response: string;
  /** Every tool call the candidate attempted (intent only — none executed). */
  toolIntents: ToolIntent[];
  error?: string;
}

/**
 * Build the frozen prefix for one case: full user/assistant pairs for every
 * turn before the violating one, then the violating turn's user message as
 * the final (unanswered) user turn. The candidate's answer to it is the
 * replay output.
 */
export function buildFrozenPrefix(replayCase: ReplayCase): ReplayMessage[] {
  const { transcript, violatingTurnIndex } = replayCase;
  if (violatingTurnIndex >= transcript.length) {
    throw new Error(
      `case ${replayCase.id}: violatingTurnIndex ${violatingTurnIndex} out of bounds (transcript has ${transcript.length} turns)`,
    );
  }
  const messages: ReplayMessage[] = [];
  for (let i = 0; i < violatingTurnIndex; i++) {
    const turn = transcript[i];
    messages.push({ role: 'user', content: turn.userMessage });
    messages.push({ role: 'assistant', content: turn.aiResponse });
  }
  messages.push({
    role: 'user',
    content: transcript[violatingTurnIndex].userMessage,
  });
  return messages;
}

/** What an intent-capturing executor returns in place of a real result. */
export const INTENT_STUB_RESULT = {
  evalReplay: true,
  note: 'Tool call recorded as intent during eval replay; not executed.',
} as const;

/** Duck-type check for a local (createTool) tool vs a provider-defined tool
 * (e.g. Anthropic webSearch/toolSearch), which has no local executor and
 * cannot mutate our data. */
interface LocalToolLike {
  id: string;
  description?: string;
  inputSchema?: unknown;
  execute: (...args: unknown[]) => unknown;
}

function isLocalTool(tool: unknown): tool is LocalToolLike {
  return (
    typeof tool === 'object' &&
    tool !== null &&
    typeof (tool as LocalToolLike).execute === 'function' &&
    typeof (tool as LocalToolLike).id === 'string'
  );
}

/**
 * Replace every local tool's executor with an intent-capturing no-op that
 * records the call (name + args) and returns a stub — THE safety property
 * of eval replay. Input schemas are preserved so the model sees the exact
 * production tool surface; output schemas are dropped so the stub return
 * never fails validation. Provider-defined tools (webSearch, webFetch,
 * toolSearch — executed provider-side, no local executor, no access to our
 * data) pass through unchanged so the prompt shape and deferred tool
 * discovery match production.
 */
export function createIntentCapturingTools<T extends Record<string, unknown>>(
  tools: T,
  onIntent: (intent: ToolIntent) => void,
): Record<string, unknown> {
  const wrapped: Record<string, unknown> = {};
  for (const [name, tool] of Object.entries(tools)) {
    if (!isLocalTool(tool)) {
      wrapped[name] = tool;
      continue;
    }
    wrapped[name] = createTool({
      id: tool.id,
      description: tool.description ?? '',
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      inputSchema: tool.inputSchema as any,
      execute: async (inputData: unknown) => {
        onIntent({ toolName: tool.id, args: inputData });
        return INTENT_STUB_RESULT;
      },
    });
  }
  return wrapped;
}
