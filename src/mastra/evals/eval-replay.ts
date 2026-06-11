#!/usr/bin/env npx tsx
/**
 * Eval replay runner (ADR-0013 in the exponential repo).
 *
 * Scores a candidate brain prompt against exported EvalCases, fully offline:
 *
 *   npm run eval-replay -- cases.json [--out results.json]
 *
 * - The candidate is THIS working tree: the assistant agent is instantiated
 *   in-process from the local checkout (instructions/model/tools imported
 *   from agents/assistant-agent.ts). Edit the instructions, re-run, and the
 *   replay output changes — no server, no deploy.
 * - Engine: Mastra's native runEvals. One model call per case: the frozen
 *   prefix goes in, maxSteps is capped at 1, and only the regenerated
 *   violating-turn response comes out.
 * - Tools never execute. Local tools are replaced with intent-capturing
 *   no-op executors (same input schemas); attempted calls are recorded in
 *   the results. The replay agent also gets NO memory, so nothing touches
 *   the memory store.
 * - Output: results JSON (response text + tool intents per case) on stdout
 *   or --out, for exponential's eval-prompt orchestrator to judge with the
 *   contract judge. No scoring happens here.
 *
 * Requires ANTHROPIC_API_KEY (the model provider is the only network call).
 * Run via the npm script so .env is loaded: `npm run eval-replay -- ...`.
 */
import { readFileSync, writeFileSync } from 'fs';
import { createHash } from 'crypto';
import { Agent } from '@mastra/core/agent';
import { createScorer, runEvals } from '@mastra/core/evals';
import {
  INSTRUCTIONS,
  assistantModel,
  assistantDefaultOptions,
  assistantTools,
} from '../agents/assistant-agent.js';
import {
  buildFrozenPrefix,
  casesFileSchema,
  createIntentCapturingTools,
  type ReplayCaseResult,
  type ToolIntent,
} from './replay.js';

function usage(): never {
  console.error('Usage: npm run eval-replay -- <cases.json> [--out results.json]');
  process.exit(1);
}

const args = process.argv.slice(2);
const outFlagIndex = args.indexOf('--out');
const outPath = outFlagIndex >= 0 ? args[outFlagIndex + 1] : undefined;
if (outFlagIndex >= 0 && !outPath) usage();
const casesPath = args.find((a, i) => !a.startsWith('--') && i !== outFlagIndex + 1);
if (!casesPath) usage();

const parsed = casesFileSchema.safeParse(JSON.parse(readFileSync(casesPath, 'utf8')));
if (!parsed.success) {
  console.error('Invalid cases file:', parsed.error.message);
  process.exit(1);
}
const { cases } = parsed.data;

// Same algorithm as utils/brain-version.ts / exponential's promptVersion
// module — stamps the results with the candidate's identity so a diff vs
// baseline knows exactly which prompt produced which numbers.
const brainVersion = `brain@${createHash('sha256').update(INSTRUCTIONS).digest('hex').slice(0, 12)}`;

// Per-case intent buffers. runEvals runs cases concurrently, so executors
// can't attribute a call to a case on their own — instead each case gets
// its own agent instance whose executors append to that case's buffer.
const intentsByCase = new Map<string, ToolIntent[]>();
const resultsByCase = new Map<string, ReplayCaseResult>();

function buildReplayAgent(caseId: string): Agent {
  const intents: ToolIntent[] = [];
  intentsByCase.set(caseId, intents);
  return new Agent({
    id: `assistantAgentReplay`,
    name: 'Assistant (eval replay)',
    instructions: INSTRUCTIONS,
    model: assistantModel,
    defaultOptions: assistantDefaultOptions,
    // No memory: the frozen prefix carries all context, and the replay must
    // not read or write any store.
    tools: createIntentCapturingTools(assistantTools, (intent) =>
      intents.push(intent),
    ) as ConstructorParameters<typeof Agent>[0]['tools'],
  });
}

console.error(`[eval-replay] ${cases.length} case(s), candidate ${brainVersion}`);

for (const replayCase of cases) {
  const agent = buildReplayAgent(replayCase.id);
  try {
    await runEvals({
      data: [{ input: buildFrozenPrefix(replayCase) as never, groundTruth: { caseId: replayCase.id } }],
      // Judging happens exponential-side with the contract judge (ADR-0013):
      // the runner only generates. runEvals refuses an empty scorer list, so
      // give it a constant pass-through scorer that judges nothing.
      scorers: [
        createScorer({
          id: 'replay-completion',
          name: 'replay-completion',
          description: 'Constant scorer: the contract judge runs exponential-side.',
          type: 'agent',
        }).generateScore(() => 1),
      ],
      target: agent,
      // One model call per case — frozen-prefix, single-turn regeneration.
      // Attempted tool calls in that single step are still routed to the
      // intent-capturing executors; there is no second round-trip.
      targetOptions: { maxSteps: 1 },
      onItemComplete: ({ targetResult }) => {
        const toolCallIntents: ToolIntent[] = (targetResult.toolCalls ?? []).map(
          (tc: { toolName?: string; payload?: { toolName?: string; args?: unknown }; args?: unknown }) => ({
            toolName: tc.toolName ?? tc.payload?.toolName ?? 'unknown',
            args: tc.args ?? tc.payload?.args,
          }),
        );
        const executorIntents = intentsByCase.get(replayCase.id) ?? [];
        // Executor capture is the ground truth (it proves the no-op ran, with
        // schema-parsed args). Model-emitted tool calls are only a fallback
        // for when no executor was invoked at all (e.g. the run stopped after
        // emitting the call) — merging both would double-count, since the
        // executor sees parsed args and the model emits raw ones.
        const merged = executorIntents.length > 0 ? executorIntents : toolCallIntents;
        resultsByCase.set(replayCase.id, {
          caseId: replayCase.id,
          expectation: replayCase.expectation,
          response: targetResult.text ?? '',
          toolIntents: merged,
        });
      },
    });
  } catch (err) {
    resultsByCase.set(replayCase.id, {
      caseId: replayCase.id,
      expectation: replayCase.expectation,
      response: '',
      toolIntents: intentsByCase.get(replayCase.id) ?? [],
      error: err instanceof Error ? err.message : String(err),
    });
  }
  const r = resultsByCase.get(replayCase.id);
  console.error(
    `[eval-replay] case ${replayCase.id}: ${r?.error ? `ERROR ${r.error}` : `${r?.response.length ?? 0} chars, ${r?.toolIntents.length ?? 0} tool intent(s)`}`,
  );
}

const output = {
  brainVersion,
  generatedAt: new Date().toISOString(),
  results: cases.map((c) => resultsByCase.get(c.id)),
};

const json = JSON.stringify(output, null, 2);
if (outPath) {
  writeFileSync(outPath, json);
  console.error(`[eval-replay] wrote ${outPath}`);
} else {
  console.log(json);
}
