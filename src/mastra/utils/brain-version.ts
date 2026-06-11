import { createHash } from 'crypto';
import type { Agent } from '@mastra/core/agent';

/**
 * brain@<hash> — the brain half of exponential's composite promptVersion
 * stamp (ADR-0013 decision 3 in the exponential repo).
 *
 * Exponential reads the `x-brain-version` response header, validates the
 * shape `brain@[0-9a-f]{6,64}`, and stamps AiInteractionHistory.promptVersion
 * as `router@X+brain@Y` at interaction-write time. When the header is absent
 * (older deploys of this repo) it falls back to the router half alone, so
 * this header is additive and safe to ship independently.
 *
 * The hash mirrors exponential's promptVersion module: first 12 hex chars of
 * sha256 over the agent's instructions, computed once at boot — pure, no I/O.
 */

export const BRAIN_VERSION_HEADER = 'x-brain-version';

export function hashInstructions(instructions: string): string {
  return createHash('sha256').update(instructions).digest('hex').slice(0, 12);
}

export function brainVersionFor(instructions: string): string {
  return `brain@${hashInstructions(instructions)}`;
}

/**
 * Compute `brain@<hash>` for every registered agent at boot. Agents whose
 * instructions resolve to a non-string (dynamic instructions) are skipped —
 * hashing one resolution would misattribute every later response.
 */
export async function computeBrainVersions(
  agents: Record<string, Agent>,
): Promise<Record<string, string>> {
  const versions: Record<string, string> = {};
  for (const [agentId, agent] of Object.entries(agents)) {
    try {
      const instructions = await agent.getInstructions();
      if (typeof instructions === 'string') {
        versions[agentId] = brainVersionFor(instructions);
      }
    } catch {
      // assertAgentsValid already fails the boot for broken agents; a throw
      // here just means this agent gets no version header.
    }
  }
  return versions;
}

/** Extract the agent id from `/api/agents/:agentId/...` request paths. */
export function agentIdFromPath(path: string): string | null {
  const match = /^\/api\/agents\/([^/]+)/.exec(path);
  return match?.[1] ? decodeURIComponent(match[1]) : null;
}
