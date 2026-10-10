import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";
import { asAppContext } from "../types/request-context.js";
import { looseStringArray } from "./zod-loose.js";
import { positionSummarySchema } from "./position-schema.js";
import type { PositionSummary } from "./position-schema.js";

// ==================== Routing tools (Exponential ADR-0068, Agent PRD D9) ====================
// Chat Zoe and the Assistant route work by Remit: they read the roster the
// Assign modal offers (now carrying each member's Positions) and assign
// through the same `action.assign` a human uses. Both call the app's HUMAN
// procedures as the user (ADR-0016), so containment is exactly what the user
// could do by hand — there is no agent-side assign path of its own.
//
// Chat-only. Both keys are listed in `RUN_EXCLUDED_TOOL_KEYS`
// (assistant-run-agent.ts): an unattended run keeps delegating through
// `reassign-action`, whose containment runs as the owner.
//
// The JWT comes from `requestContext` and every call is a POST
// (`authenticatedTrpcCall`), queries included, per ADR-0041. No credential
// enters a tool input.

function routingAuth(ctx: { requestContext?: Parameters<typeof asAppContext>[0] }) {
  const requestContext = asAppContext(ctx.requestContext);
  const authToken = requestContext?.get("authToken");
  const sessionId = requestContext?.get("whatsappSession");
  const userId = requestContext?.get("userId");
  const workspaceId = requestContext?.get("workspaceId");
  const contextProjectId = requestContext?.get("projectId");
  if (!authToken) throw new Error("No authentication token available");
  return { auth: { authToken, sessionId, userId }, userId, workspaceId, contextProjectId };
}

// ---- Wire shapes from the app (validated loosely: older app builds omit the
// V1/V2 fields, and Mastra must not fail a whole roster over one of them) ----

interface PositionWire {
  id: string;
  title?: string | null;
  remit?: string | null;
  notAccountableFor?: string | null;
}

interface AssignableUserWire {
  id: string;
  name?: string | null;
  email?: string | null;
  isAgent?: boolean | null;
  assistantOwner?: { id: string; name?: string | null } | null;
  positions?: PositionWire[] | null;
  agentDescription?: string | null;
}

interface RosterWire {
  assignableUsers?: AssignableUserWire[] | null;
}

interface AssignWire {
  id?: string;
  assignees?: { user?: { id: string; name?: string | null } | null }[] | null;
  agentRunsQueued?: number | null;
}

const rosterMemberSchema = z.object({
  id: z.string(),
  name: z.string().nullable(),
  email: z.string().nullable(),
  isAgent: z.boolean(),
  assistantOwner: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
  isRequester: z.boolean(),
  isRequestersAssistant: z.boolean(),
  positionIds: z.array(z.string()),
  agentDescription: z.string().nullable(),
});

type RosterMember = z.infer<typeof rosterMemberSchema>;

export const listAssignableMembersOutputSchema = z.object({
  projectId: z
    .string()
    .nullable()
    .describe(
      "The project this roster was fetched for (the one passed, else the page's project). Null when fetched by actionId or for no project.",
    ),
  positions: z.array(positionSummarySchema),
  members: z.array(rosterMemberSchema),
});

export type Roster = z.infer<typeof listAssignableMembersOutputSchema>;

/**
 * Shape the app's `AssignableUser[]` for the model. A Position held by several
 * members is listed once in `positions` and referenced by id from each member,
 * so a long Remit costs its tokens once, not once per holder.
 */
export function toRoster(
  users: AssignableUserWire[],
  requesterId: string | undefined,
  projectId: string | null = null,
): Roster {
  const positions = new Map<string, PositionSummary>();
  const members: RosterMember[] = users.map((user) => {
    const held = user.positions ?? [];
    for (const p of held) {
      if (!positions.has(p.id)) {
        positions.set(p.id, {
          id: p.id,
          title: p.title ?? "",
          remit: p.remit ?? "",
          notAccountableFor: p.notAccountableFor ?? null,
        });
      }
    }
    const owner = user.assistantOwner ?? null;
    return {
      id: user.id,
      name: user.name ?? null,
      email: user.email ?? null,
      isAgent: user.isAgent ?? false,
      assistantOwner: owner ? { id: owner.id, name: owner.name ?? null } : null,
      isRequester: requesterId !== undefined && user.id === requesterId,
      isRequestersAssistant: requesterId !== undefined && owner?.id === requesterId,
      positionIds: held.map((p) => p.id),
      agentDescription: user.agentDescription ?? null,
    };
  });
  return { projectId, positions: [...positions.values()], members };
}

export const listAssignableMembersTool = createTool({
  id: "list-assignable-members",
  description:
    "List who an action can be assigned to — the exact people, Assistants and agents the user could pick in the Assign modal — with the Positions each holds (title, Remit = the kinds of work they take on, and what they are not accountable for). Use it to route work: before creating or handing off an action for someone else, for \"whoever handles this\", or before assigning anything with assign-action. Pass `actionId` for an existing action, or `projectId` (or nothing) for one you are about to create in the current workspace — with no `projectId` it uses the page's project, exactly as quick-create-action does, and returns the project it used as `projectId`. Each member carries `positionIds` (look them up in `positions`), `isRequester` (the user you are talking to), `isRequestersAssistant` (the user's own Assistant), and for an agent with no Position its `agentDescription`, which stands in for a Remit. Call it once per turn; never invent a member id.",
  inputSchema: z.object({
    actionId: z
      .string()
      .optional()
      .describe("An existing action's id — returns who can be assigned to that action. Wins over projectId."),
    projectId: z
      .string()
      .optional()
      .describe("The project an action you are about to create will live in. Omit to use the page's project (as quick-create-action does), or for an action with no project."),
  }),
  outputSchema: listAssignableMembersOutputSchema,
  async execute(inputData, ctx): Promise<Roster> {
    const { auth, userId, workspaceId, contextProjectId } = routingAuth(ctx);
    // Same fallback as quick-create-action: an explicit projectId wins over the
    // page's, so the roster is read for the project the action will land in.
    const projectId = (inputData.projectId ?? contextProjectId) || undefined;

    console.log(
      `🧭 [listAssignableMembers] actionId=${inputData.actionId ?? "none"}, projectId=${projectId ?? "none"}, workspaceId=${workspaceId ?? "none"}`,
    );

    const { data } = inputData.actionId
      ? await authenticatedTrpcCall<RosterWire>(
          "action.getAssignableUsers",
          { actionId: inputData.actionId },
          auth,
        )
      : await authenticatedTrpcCall<RosterWire>(
          "action.getAssignableUsersForContext",
          { projectId, workspaceId },
          auth,
        );

    return toRoster(data?.assignableUsers ?? [], userId, inputData.actionId ? null : (projectId ?? null));
  },
});

/**
 * A containment refusal from `action.assign`: tRPC NOT_FOUND, which
 * `authenticatedFetch` surfaces as `Request failed: 404 …` with the code in the
 * body. A missing procedure is also a tRPC NOT_FOUND, so that one is excluded —
 * it must not read to the user as "you can't assign this person".
 */
export function isContainmentNotFound(error: unknown): boolean {
  const message = error instanceof Error ? error.message : String(error);
  if (!/^Request failed: 404\b/.test(message) && !message.includes("NOT_FOUND")) return false;
  return !/procedure on path|No procedure found/i.test(message);
}

export const assignActionInputSchema = z.object({
  actionId: z.string().describe("The action to assign."),
  userIds: looseStringArray(z.array(z.string().min(1)).min(1).max(10))
    .describe("Member ids from list-assignable-members (1–10)."),
});

export const assignActionOutputSchema = z.object({
  actionId: z.string(),
  assignees: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
  agentRunsQueued: z.number().nullable(),
});

export type AssignActionResult = z.infer<typeof assignActionOutputSchema>;

export const assignActionTool = createTool({
  id: "assign-action",
  description:
    "Assign an existing action to one or more members, exactly as the user would in the Assign modal. Member ids MUST come from list-assignable-members — never guess one. Assigning adds to the current assignees; nobody is removed. Assigning an Assistant starts its Agent run on the action: `agentRunsQueued` says how many runs actually started (0 when the action is parked, completed, or already has a live run; null when the app did not report it). A NOT_FOUND error means a member is outside what the user could assign by hand on this action: tell the user so, and do not retry silently with a different id.",
  inputSchema: assignActionInputSchema,
  outputSchema: assignActionOutputSchema,
  async execute(inputData, ctx): Promise<AssignActionResult> {
    const { auth } = routingAuth(ctx);

    console.log(
      `👥 [assignAction] actionId=${inputData.actionId}, userIds=${inputData.userIds.join(",")}`,
    );

    try {
      const { data } = await authenticatedTrpcCall<AssignWire | null>(
        "action.assign",
        { actionId: inputData.actionId, userIds: inputData.userIds },
        auth,
      );
      const assignees = (data?.assignees ?? []).flatMap((a) =>
        a.user ? [{ id: a.user.id, name: a.user.name ?? null }] : [],
      );
      return {
        actionId: data?.id ?? inputData.actionId,
        assignees,
        agentRunsQueued: typeof data?.agentRunsQueued === "number" ? data.agentRunsQueued : null,
      };
    } catch (error) {
      console.error(`❌ [assignAction] FAILED:`, error);
      if (isContainmentNotFound(error)) {
        throw new Error(
          "NOT_FOUND: at least one of these members is outside what the user could assign by hand on this action. Tell the user who could not be assigned; do not retry with a different id.",
        );
      }
      throw error;
    }
  },
});

/** The routing tools, keyed as they appear on `zoeTools` / `assistantTools`. */
export const routingTools = {
  listAssignableMembersTool,
  assignActionTool,
};
