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
// Chat-only. Every key is listed in `RUN_EXCLUDED_TOOL_KEYS`
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
  // A blank workspace is treated as absent, as quick-create-action does.
  const contextWorkspaceId = requestContext?.get("workspaceId");
  const workspaceId = contextWorkspaceId?.trim() ? contextWorkspaceId : undefined;
  const contextProjectId = requestContext?.get("projectId");
  if (!authToken) throw new Error("No authentication token available");
  return { auth: { authToken, sessionId, userId }, userId, workspaceId, contextProjectId };
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

/** A tRPC "no such procedure" body: the app build predates the procedure. */
const MISSING_PROCEDURE = /procedure on path|No procedure found/i;

/** A tRPC FORBIDDEN, as `authenticatedFetch` surfaces it (`Request failed: 403 …`). */
export function isForbidden(error: unknown): boolean {
  const message = errorMessage(error);
  return /^Request failed: 403\b/.test(message) || message.includes("FORBIDDEN");
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

    const forContext = async (ws: string | undefined) =>
      authenticatedTrpcCall<RosterWire>("action.getAssignableUsersForContext", { projectId, workspaceId: ws }, auth);

    let data: RosterWire | undefined;
    if (inputData.actionId) {
      ({ data } = await authenticatedTrpcCall<RosterWire>(
        "action.getAssignableUsers",
        { actionId: inputData.actionId },
        auth,
      ));
    } else {
      try {
        ({ data } = await forContext(workspaceId));
      } catch (error) {
        // Same fallback as quick-create-action: the workspace came from
        // context, not the user (a viewer, a stale gateway pairing), and the
        // action quick-create files after that FORBIDDEN lands unscoped — so
        // read the roster unscoped too.
        if (!workspaceId || !isForbidden(error)) throw error;
        console.warn(`⚠️ [listAssignableMembers] FORBIDDEN in workspace ${workspaceId}; retrying without a workspace`);
        ({ data } = await forContext(undefined));
      }
    }

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
  const message = errorMessage(error);
  if (!/^Request failed: 404\b/.test(message) && !message.includes("NOT_FOUND")) return false;
  return !MISSING_PROCEDURE.test(message);
}

export const assignActionInputSchema = z.object({
  actionId: z.string().describe("The action to assign."),
  userIds: looseStringArray(z.array(z.string().min(1)).min(1).max(10))
    .describe("Member ids from list-assignable-members (1–10)."),
});

export const assignActionOutputSchema = z.object({
  actionId: z.string(),
  assignees: z.array(z.object({ id: z.string(), name: z.string().nullable() })),
  agentRunsQueued: z
    .number()
    .nullable()
    .describe(
      "Agent runs that started. 0: already assigned to that Assistant (re-assigning does not restart it), parked, completed, or a run is already live. Null: not reported.",
    ),
});

export type AssignActionResult = z.infer<typeof assignActionOutputSchema>;

export const assignActionTool = createTool({
  id: "assign-action",
  description:
    "Assign an existing action to one or more members, exactly as the user would in the Assign modal. Member ids MUST come from list-assignable-members — never guess one. Assigning adds to the current assignees; nobody is removed. Assigning an Assistant starts its Agent run on the action: `agentRunsQueued` says how many runs actually started — 0 when the action was already assigned to that Assistant (re-assigning does not restart it), is parked, is completed, or already has a live run; null when the app did not report it. If you cannot tell which, tell the user plainly that no run started rather than invent a cause. A NOT_FOUND error means a member is outside what the user could assign by hand on this action; the error names who was not assigned (and who was, when several ids were sent): tell the user so, and do not retry silently with a different id.",
  inputSchema: assignActionInputSchema,
  outputSchema: assignActionOutputSchema,
  async execute(inputData, ctx): Promise<AssignActionResult> {
    const { auth } = routingAuth(ctx);

    console.log(
      `👥 [assignAction] actionId=${inputData.actionId}, userIds=${inputData.userIds.join(",")}`,
    );

    const { actionId, userIds } = inputData;
    try {
      return toAssignResult(await callAssign(actionId, userIds, auth), actionId);
    } catch (error) {
      console.error(`❌ [assignAction] FAILED:`, error);
      if (!isContainmentNotFound(error)) throw error;
      // The app's containment check rejects the whole request, writes nothing,
      // and never names the member it refused.
      const none = `NOT_FOUND: none of the ${userIds.length} member${userIds.length === 1 ? " was" : "s were"} assigned`;
      if (userIds.length === 1) {
        throw new Error(
          `${none}: ${userIds[0]} is outside what the user could assign by hand on this action. Tell the user that member could not be assigned; do not retry with a different id.`,
        );
      }
      return retryOneAtATime(actionId, userIds, auth, none);
    }
  },
});

type RoutingAuth = ReturnType<typeof routingAuth>["auth"];

async function callAssign(actionId: string, userIds: string[], auth: RoutingAuth) {
  const { data } = await authenticatedTrpcCall<AssignWire | null>("action.assign", { actionId, userIds }, auth);
  return data;
}

function toAssignResult(data: AssignWire | null | undefined, actionId: string): AssignActionResult {
  const assignees = (data?.assignees ?? []).flatMap((a) =>
    a.user ? [{ id: a.user.id, name: a.user.name ?? null }] : [],
  );
  return {
    actionId: data?.id ?? actionId,
    assignees,
    agentRunsQueued: typeof data?.agentRunsQueued === "number" ? data.agentRunsQueued : null,
  };
}

/**
 * Find which member a multi-id NOT_FOUND refused by retrying the SAME ids one
 * at a time — never a different one. The ones the app accepts are assigned by
 * the retry, so the error names both lists.
 */
async function retryOneAtATime(
  actionId: string,
  userIds: string[],
  auth: RoutingAuth,
  none: string,
): Promise<AssignActionResult> {
  const assigned: string[] = [];
  const rejected: string[] = [];
  let last: AssignActionResult | null = null;
  let runs: number | null = 0;
  for (const userId of userIds) {
    try {
      last = toAssignResult(await callAssign(actionId, [userId], auth), actionId);
      assigned.push(userId);
      runs = runs === null || last.agentRunsQueued === null ? null : runs + last.agentRunsQueued;
    } catch (error) {
      if (!isContainmentNotFound(error)) throw error;
      rejected.push(userId);
    }
  }
  console.warn(`⚠️ [assignAction] one-at-a-time retry: assigned=${assigned.join(",") || "none"}, rejected=${rejected.join(",") || "none"}`);
  if (rejected.length === 0 && last) return { ...last, agentRunsQueued: runs };
  const outcome = assigned.length
    ? `Retried the same ids one at a time: assigned ${assigned.join(", ")} (agentRunsQueued: ${runs ?? "not reported"}); not assigned ${rejected.join(", ")}`
    : `Retried the same ids one at a time: none could be assigned (${rejected.join(", ")})`;
  throw new Error(
    `${none} by the combined request. ${outcome} — outside what the user could assign by hand on this action. Tell the user who could not be assigned and who was; do not retry with a different id.`,
  );
}

// ==================== Import roles & responsibilities (Agent PRD D10, V3) ====================
// Zoe turns a pasted roles document (or a Notion page she read) into Positions
// in one conversation: a dry run first, the draft shown as a table, the write
// only after the user's explicit yes. The app's `position.importMany` is
// human-only plus owner/admin, so chat Zoe passes (she calls with the user's
// own token) and an Agent run never can — and the key is run-excluded anyway.

/**
 * The HTTP status of a failed tRPC call (`Request failed: 409 …`), or
 * undefined for anything else. The import classifies its refusals on the
 * status alone: the response body quotes the user's titles, so a code word
 * inside it ("CONFLICT", "FORBIDDEN") must not decide the branch.
 */
function failedStatus(error: unknown): number | undefined {
  const match = /^Request failed: (\d{3})\b/.exec(errorMessage(error));
  return match ? Number(match[1]) : undefined;
}

/** The app caps distinct holders per import (`MAX_IMPORT_HOLDER_IDS`). */
const MAX_IMPORT_HOLDER_IDS = 200;

/**
 * `dryRun` decides whether the import writes, so only an unambiguous value is
 * accepted: a boolean or the strings "true" / "false". Unlike `looseBoolean`,
 * a blank, "no" or "0" is a validation error the model retries — never a
 * silent write.
 */
const dryRunSchema = z.preprocess((v) => {
  if (typeof v !== "string") return v;
  const s = v.trim().toLowerCase();
  return s === "true" ? true : s === "false" ? false : v;
}, z.boolean()) as z.ZodEffects<z.ZodBoolean, boolean, boolean>;

export const importPositionRowSchema = z.object({
  title: z.string().trim().min(1).max(80).describe("The Position's title (1–80 chars), e.g. \"Travel researcher\"."),
  remit: z
    .string()
    .trim()
    .min(1)
    .max(2000)
    .describe("The Remit: the kinds of work its holders take on (Markdown, 1–2000 chars), from the document."),
  notAccountableFor: z
    .string()
    .trim()
    .max(2000)
    .nullish()
    .describe(
      "What the Position is explicitly not accountable for (Markdown, ≤2000 chars). Omit (or null) when the document says nothing — an existing Position keeps its stored value. An empty or blank string clears it: send one only when the user asks to clear it.",
    ),
  holderUserIds: looseStringArray(z.array(z.string().min(1)).max(50))
    .default([])
    .describe(
      "Member ids from list-assignable-members (≤50). Only names you matched to exactly one member; an unmatched name is never guessed — leave it out and ask the user.",
    ),
});

export const importPositionsInputSchema = z.object({
  dryRun: dryRunSchema.describe(
    "true: validate and return the plan without writing — ALWAYS first. false: write — only after the user has seen that plan and said yes.",
  ),
  positions: z
    .array(importPositionRowSchema)
    .min(1)
    .max(50)
    .refine((rows) => new Set(rows.flatMap((row) => row.holderUserIds)).size <= MAX_IMPORT_HOLDER_IDS, {
      message: `An import can name at most ${MAX_IMPORT_HOLDER_IDS} distinct holders`,
    })
    .describe("The Positions to import (1–50), one per title."),
});

/**
 * The input as `execute` receives it. Mastra types `inputData` from the
 * schema's input side, where the defaulted `holderUserIds` is optional.
 */
export type ImportPositionsInput = z.input<typeof importPositionsInputSchema>;

export const importPositionsOutputSchema = z.object({
  written: z.boolean().describe("True only when the app wrote the import. A dry run is always false."),
  created: z.number().describe("Rows whose outcome is create."),
  updated: z.number().describe("Rows whose outcome is update."),
  results: z
    .array(
      z.object({
        title: z.string().describe("The stored title: an update keeps the existing Position's spelling."),
        outcome: z.enum(["create", "update"]),
        notAccountableFor: z.string().nullable(),
        holderUserIds: z
          .array(z.string())
          .describe("Every holder after the import: an update keeps the existing holders and adds these."),
      }),
    )
    .describe("One per input row, in input order."),
});

export type ImportPositionsResult = z.infer<typeof importPositionsOutputSchema>;

interface ImportManyWire {
  written?: boolean | null;
  results?:
    | {
        title?: string | null;
        outcome?: string | null;
        notAccountableFor?: string | null;
        holderUserIds?: string[] | null;
      }[]
    | null;
}

/** The app's `importMany` payload: an omitted or null notAccountableFor is left out, so the stored value is kept. */
export function toImportManyPayload(workspaceId: string, input: ImportPositionsInput) {
  return {
    workspaceId,
    dryRun: input.dryRun,
    positions: input.positions.map((row) => ({
      title: row.title,
      remit: row.remit,
      ...(row.notAccountableFor !== undefined && row.notAccountableFor !== null
        ? { notAccountableFor: row.notAccountableFor }
        : {}),
      holderUserIds: [...new Set(row.holderUserIds ?? [])],
    })),
  };
}

/**
 * Shape the app's answer. Results come back in input order, so a missing
 * title falls back to the row that was sent; an outcome that is neither
 * create nor update is not guessed — the response is refused instead.
 */
function toImportResult(data: ImportManyWire | null | undefined, sent: { title: string }[]): ImportPositionsResult {
  const results = (data?.results ?? []).map((row, i): ImportPositionsResult["results"][number] => {
    const outcome = row.outcome;
    if (outcome !== "create" && outcome !== "update") {
      throw new Error(
        `The app answered the import with an unexpected outcome (${String(outcome)}) for row ${i + 1}. Tell the user the import result could not be confirmed and suggest checking the Positions in workspace settings; do not claim anything was saved.`,
      );
    }
    return {
      title: row.title ?? sent[i]?.title ?? "",
      outcome,
      notAccountableFor: row.notAccountableFor ?? null,
      holderUserIds: row.holderUserIds ?? [],
    };
  });
  return {
    // Reported from the app, never assumed from the request.
    written: data?.written === true,
    created: results.filter((r) => r.outcome === "create").length,
    updated: results.filter((r) => r.outcome === "update").length,
    results,
  };
}

const NOTHING_WRITTEN = "Nothing was written.";

export const importPositionsTool = createTool({
  id: "import-positions",
  description:
    "Import a workspace's roles & responsibilities as Positions (title, Remit, not accountable for, holders) — for when the user pastes a roles document or links a Notion page and asks to import it. Draft and confirm, always: (1) call list-assignable-members and match each named holder to exactly one member by name — never guess an id; a name you cannot match is left out and listed as \"no member found\"; (2) call this tool with `dryRun: true`; (3) show the user the plan as a table — Position · Remit (summary) · Not accountable for · Holders (names) · create/update — plus any unmatched names, and ask ONE yes/no for the whole import; (4) only after an explicit yes, call again with `dryRun: false` and exactly the rows you showed. If the user changes anything, dry-run again and show the new table before writing. An existing title (matched case-insensitively) is updated: its Remit is replaced, its not-accountable-for is replaced when you send one, and holders are only ever added — an import never removes anyone. Report what happened from this tool's output: `written` true means saved (created/updated counts); false means nothing was saved. FORBIDDEN means only a workspace owner or admin can import — tell the user so. The workspace comes from the chat; never ask for it.",
  inputSchema: importPositionsInputSchema,
  outputSchema: importPositionsOutputSchema,
  async execute(inputData, ctx): Promise<ImportPositionsResult> {
    const { auth, workspaceId } = routingAuth(ctx);
    if (!workspaceId) {
      throw new Error(
        `No workspace in this chat. ${NOTHING_WRITTEN} Positions belong to a workspace: ask the user to open the chat from the workspace they want to import into, then try again.`,
      );
    }

    const payload = toImportManyPayload(workspaceId, inputData);
    console.log(
      `🗂️ [importPositions] workspaceId=${workspaceId}, dryRun=${payload.dryRun}, rows=${payload.positions.length}`,
    );

    try {
      const { data } = await authenticatedTrpcCall<ImportManyWire | null>("position.importMany", payload, auth);
      return toImportResult(data, payload.positions);
    } catch (error) {
      console.error(`❌ [importPositions] FAILED:`, error);
      const detail = errorMessage(error);
      const status = failedStatus(error);
      if (status === 404 && MISSING_PROCEDURE.test(detail)) {
        throw new Error(
          `This Exponential build cannot import Positions yet (position.importMany is not available). ${NOTHING_WRITTEN} Tell the user the import is not available yet; they can add Positions in workspace settings.`,
        );
      }
      if (status === 403) {
        throw new Error(
          `FORBIDDEN: only a workspace owner or admin can import Positions. ${NOTHING_WRITTEN} Tell the user an owner or admin of this workspace must run the import; do not retry.`,
        );
      }
      if (status === 404) {
        // importMany's only NOT_FOUND is the holder check (a non-member of
        // the workspace is FORBIDDEN, above), and it never names the id.
        throw new Error(
          `NOT_FOUND: one of the holder ids is not a member of this workspace (the app does not say which). ${NOTHING_WRITTEN} Check every holderUserId against list-assignable-members; ask the user who is meant for any holder you cannot confirm, and dry-run again — never substitute a guessed id.`,
        );
      }
      if (status === 409) {
        throw new Error(
          `CONFLICT: a Position with one of these titles was created while importing. ${NOTHING_WRITTEN} Run the dry run again and show the user the new plan before writing.`,
        );
      }
      if (status === 400) {
        throw new Error(
          `BAD_REQUEST: the app refused this import (${detail}). ${NOTHING_WRITTEN} A title listed twice must become one row; fix what the error names, and ask the user how to resolve anything you cannot fix from the document before dry-running again.`,
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
  importPositionsTool,
};
