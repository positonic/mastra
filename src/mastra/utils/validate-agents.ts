import type { Agent } from '@mastra/core/agent';

/**
 * Minimum plausible length for an agent's system prompt. Below this, the
 * agent is almost certainly misconfigured — typically because the
 * `instructions` field was assigned a non-string value (an object, an
 * array of message parts) that coerced to a short string during
 * serialization.
 *
 * This exists because an earlier `cachedSystemPrompt` helper returned a
 * CoreSystemMessage[] but was passed to Agent.instructions (typed as
 * string). The resulting 1-character garbage silently broke agent
 * listing and similarity-based routing in downstream consumers.
 */
const MIN_INSTRUCTION_LENGTH = 50;

export type AgentValidationIssue = {
  agentId: string;
  reason: string;
  actualType: string;
  actualLength?: number;
};

/**
 * Validate that every registered agent has a well-formed instructions
 * field. Returns a list of issues; empty means all good.
 *
 * Kept pure so it can be unit-tested without booting the full server.
 *
 * In Mastra 1.x, `instructions` is no longer a public string property —
 * it's resolved via the async `getInstructions()` method, which handles
 * both static strings and dynamic (function-based) instructions.
 */
export async function validateAgentInstructions(
  agents: Record<string, Agent>,
): Promise<AgentValidationIssue[]> {
  const issues: AgentValidationIssue[] = [];

  for (const [agentId, agent] of Object.entries(agents)) {
    let raw: unknown;
    try {
      raw = await agent.getInstructions();
    } catch (err) {
      issues.push({
        agentId,
        reason: `getInstructions() threw: ${err instanceof Error ? err.message : String(err)}`,
        actualType: 'error',
      });
      continue;
    }

    const actualType = Array.isArray(raw) ? 'array' : typeof raw;

    if (typeof raw !== 'string') {
      issues.push({
        agentId,
        reason: `instructions must be a string (got ${actualType})`,
        actualType,
      });
      continue;
    }

    if (raw.trim().length < MIN_INSTRUCTION_LENGTH) {
      issues.push({
        agentId,
        reason: `instructions shorter than ${MIN_INSTRUCTION_LENGTH} chars — likely misconfigured`,
        actualType,
        actualLength: raw.length,
      });
    }
  }

  return issues;
}

/**
 * Fail-fast assertion for server boot. Logs each issue and throws if any
 * agent is broken, so a bad deploy dies during startup rather than
 * silently serving empty agents.
 */
export async function assertAgentsValid(
  agents: Record<string, Agent>,
  logger: { error: (msg: string, meta?: any) => void },
): Promise<void> {
  const issues = await validateAgentInstructions(agents);
  if (issues.length === 0) return;

  for (const issue of issues) {
    logger.error(`[agent-validation] ${issue.agentId}: ${issue.reason}`, issue);
  }

  throw new Error(
    `Agent validation failed for ${issues.length} agent(s): ` +
      issues.map((i) => i.agentId).join(', '),
  );
}
