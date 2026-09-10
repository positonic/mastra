import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import {
  authenticatedTrpcCall,
  authenticatedTrpcQuery,
} from "../utils/authenticated-fetch.js";
import { asAppContext } from "../types/request-context.js";
import { looseEnum, looseNumber } from "./zod-loose.js";

// ──────────────────────────────────────────────────────────────────────────────
// Decision tools (exponential ADR-0060, ticket royal.ram)
//
// Zoe logs and updates Decisions through the SAME service seam the UI uses:
// the `decision` tRPC router (protectedProcedure — deliberately not
// human-only). There is no agent-side write path of its own: log-decision
// calls decision.create, update-decision calls decision.update /
// decision.setStatus, list-decisions calls decision.list. Visibility and the
// workspace label sequence (D-0042) are the server's.
//
// A decision logged here carries source AGENT, so the Decision Log shows
// "Logged by Zoe" and the activity feed attributes it honestly.
// ──────────────────────────────────────────────────────────────────────────────

const DECISION_STATUSES = ["OPEN", "PROPOSED", "ACCEPTED", "SUPERSEDED", "DEPRECATED"] as const;

/**
 * The model says "confirmed", "agreed" or "decided" for what the log calls
 * ACCEPTED, and "question" for OPEN. The alias words are admitted by the
 * input enums and folded here, so a natural phrasing does not fail
 * validation and the server only ever sees the canonical five.
 */
const STATUS_ALIASES = {
  CONFIRMED: "ACCEPTED",
  AGREED: "ACCEPTED",
  DECIDED: "ACCEPTED",
  FINAL: "ACCEPTED",
  QUESTION: "OPEN",
  PENDING: "PROPOSED",
  DRAFT: "PROPOSED",
  REPLACED: "SUPERSEDED",
  RETIRED: "DEPRECATED",
} as const;
type StatusAlias = keyof typeof STATUS_ALIASES;
type DecisionStatus = (typeof DECISION_STATUSES)[number];
const ALIAS_WORDS = Object.keys(STATUS_ALIASES) as [StatusAlias, ...StatusAlias[]];
const CREATE_STATUS_INPUT = ["ACCEPTED", "PROPOSED", "OPEN", ...ALIAS_WORDS] as const;
const ANY_STATUS_INPUT = [...DECISION_STATUSES, ...ALIAS_WORDS] as const;

function canonicalStatus(value: DecisionStatus | StatusAlias): DecisionStatus {
  return value in STATUS_ALIASES ? STATUS_ALIASES[value as StatusAlias] : (value as DecisionStatus);
}

/** `D-0042` → 42; anything else → null. */
function parseDecisionLabel(text: string): number | null {
  const match = /^\s*D-?(\d{1,6})\s*$/i.exec(text);
  return match ? Number(match[1]) : null;
}

interface DecisionShape {
  id: string;
  label?: string | null;
  number?: number | null;
  statement?: string | null;
  status?: string | null;
  source?: string | null;
  decidedAt?: string | Date | null;
  transcriptionSessionId?: string | null;
  supersededById?: string | null;
  supersededBy?: { id: string; label?: string | null; number?: number | null } | null;
}

interface DecisionListRow {
  id: string;
  label?: string | null;
  number?: number | null;
  statement?: string | null;
  status?: string | null;
  source?: string | null;
  decidedAt?: string | Date | null;
  transcriptionSession?: { id: string; title?: string | null } | null;
  project?: { id: string; name: string } | null;
  product?: { id: string; name: string } | null;
}

function isoOrNull(value: string | Date | null | undefined): string | null {
  if (!value) return null;
  return value instanceof Date ? value.toISOString() : value;
}

function labelOf(d: { label?: string | null; number?: number | null }): string {
  if (d.label) return d.label;
  if (typeof d.number === "number") return `D-${String(d.number).padStart(4, "0")}`;
  return "D-????";
}

function getAuth(ctx: { requestContext?: Parameters<typeof asAppContext>[0] }) {
  const requestContext = asAppContext(ctx.requestContext);
  const authToken = requestContext?.get("authToken");
  const sessionId = requestContext?.get("whatsappSession");
  const userId = requestContext?.get("userId");
  const workspaceId = requestContext?.get("workspaceId");
  if (!authToken) {
    throw new Error("No authentication token available in request context");
  }
  return { authToken, sessionId, userId, workspaceId };
}

export const logDecisionTool = createTool({
  id: "log-decision",
  description:
    "Record a decision in the workspace's Decision Log. Use it when the user says something was decided or agreed (\"log that we decided X\", \"we agreed in the standup to Y\", \"record the decision to Z\") or raises an open question they want tracked. It creates a confirmed Decision with a workspace label like D-0042 through the same path the UI uses. Pass transcriptionSessionId when the decision came from a meeting (resolve it with get-meeting-transcriptions if they named the meeting) — the server then defaults the date and deciders from that meeting, and you may quote supporting transcript turns as evidence, but ONLY turns you actually read. Never invent a decision the user did not state. Status defaults to ACCEPTED; use OPEN for an open question, PROPOSED for something not yet agreed.",
  inputSchema: z.object({
    statement: z
      .string()
      .min(1)
      .max(500)
      .describe("One line: what was decided, in the user's words"),
    body: z
      .string()
      .optional()
      .describe(
        "Optional Markdown notes — context, alternatives considered, consequences. Omit unless the user gave them.",
      ),
    notes: z.string().optional().describe("Alias of body."),
    status: looseEnum(CREATE_STATUS_INPUT)
      .optional()
      .describe(
        "Exactly one of ACCEPTED (default — also for 'confirmed'/'agreed'), PROPOSED, or OPEN (an open question).",
      ),
    decidedAt: z
      .string()
      .optional()
      .describe("ISO date the decision was made. Omit to default to the meeting date or now."),
    transcriptionSessionId: z
      .string()
      .optional()
      .describe("The exponential TranscriptionSession id of the meeting it came from, if any"),
    projectId: z.string().optional().describe("Project the decision belongs to, if known"),
    productId: z.string().optional().describe("Product the decision belongs to, if known"),
    deciders: z
      .array(
        z.object({
          name: z.string().min(1),
          email: z.string().email().optional(),
        }),
      )
      .optional()
      .describe(
        "Who made the call. Omit for a meeting-linked decision to default to the meeting's participants; omit otherwise to default to the user.",
      ),
    evidence: z
      .array(
        z.object({
          turnIndex: looseNumber(z.number().int().min(0)),
          speaker: z.string().optional(),
          text: z.string().min(1),
        }),
      )
      .optional()
      .describe(
        "Transcript turns that support the decision (index + speaker + quoted text). Only for meeting-linked decisions, and only turns you actually read.",
      ),
  }),
  outputSchema: z.object({
    id: z.string(),
    label: z.string(),
    statement: z.string(),
    status: z.string(),
    decidedAt: z.string().nullable(),
    summary: z.string(),
  }),
  execute: async (inputData, ctx) => {
    const { authToken, sessionId, userId, workspaceId } = getAuth(ctx);
    if (!workspaceId) {
      throw new Error(
        "No workspaceId available in request context — the agent must be invoked with a workspace scope",
      );
    }

    console.log(`📝 [logDecision] Logging decision in workspace ${workspaceId}: "${inputData.statement}"`);

    const { data } = await authenticatedTrpcCall<DecisionShape>(
      "decision.create",
      {
        workspaceId,
        statement: inputData.statement,
        body: inputData.body ?? inputData.notes ?? null,
        status: inputData.status ? canonicalStatus(inputData.status) : "ACCEPTED",
        source: "AGENT",
        decidedAt: inputData.decidedAt ?? null,
        transcriptionSessionId: inputData.transcriptionSessionId ?? null,
        projectId: inputData.projectId ?? null,
        productId: inputData.productId ?? null,
        deciders: inputData.deciders,
        evidence: inputData.evidence?.map((turn) => ({
          turnIndex: turn.turnIndex,
          speaker: turn.speaker ?? null,
          startTime: null,
          text: turn.text,
        })),
      },
      { authToken, sessionId, userId },
    );

    if (!data?.id) {
      throw new Error("decision.create returned no data");
    }

    const label = labelOf(data);
    const status = data.status ?? (inputData.status ? canonicalStatus(inputData.status) : "ACCEPTED");
    const summary =
      `Logged ${label} (${status.toLowerCase()}): ${data.statement ?? inputData.statement}` +
      (inputData.transcriptionSessionId ? ` — from meeting ${inputData.transcriptionSessionId}` : "") +
      `. It is in the Decision Log now.`;
    console.log(`✅ [logDecision] ${summary}`);

    return {
      id: data.id,
      label,
      statement: data.statement ?? inputData.statement,
      status,
      decidedAt: isoOrNull(data.decidedAt),
      summary,
    };
  },
});

export const updateDecisionTool = createTool({
  id: "update-decision",
  description:
    "Change a decision in the Decision Log: move it along its lifecycle (accept a proposed one, reopen it as a question, mark it superseded by a newer decision, or deprecate it) and/or edit its statement, notes or date. Needs the decision's id — resolve a label like D-0003 with list-decisions first. To supersede, pass status SUPERSEDED and supersededById (the id of the decision that replaces it). Confirmed decisions are never deleted; deprecate or supersede instead.",
  inputSchema: z.object({
    decisionId: z.string().describe("The Decision id (not the D-label — resolve that with list-decisions)"),
    status: looseEnum(ANY_STATUS_INPUT)
      .optional()
      .describe("New status (OPEN, PROPOSED, ACCEPTED, SUPERSEDED, DEPRECATED). SUPERSEDED requires supersededById."),
    supersededById: z
      .string()
      .optional()
      .describe("With status SUPERSEDED: the id of the decision that replaces this one"),
    statement: z.string().min(1).max(500).optional().describe("New one-line statement"),
    body: z.string().optional().describe("New Markdown notes"),
    notes: z.string().optional().describe("Alias of body."),
    decidedAt: z.string().optional().describe("New ISO decided-at date"),
  }),
  outputSchema: z.object({
    id: z.string(),
    label: z.string(),
    status: z.string(),
    summary: z.string(),
  }),
  execute: async (inputData, ctx) => {
    const { authToken, sessionId, userId, workspaceId } = getAuth(ctx);
    if (!workspaceId) {
      throw new Error("No workspaceId available in request context");
    }
    const status = inputData.status ? canonicalStatus(inputData.status) : undefined;
    if (status === "SUPERSEDED" && !inputData.supersededById) {
      throw new Error(
        "Superseding needs supersededById — the id of the newer decision that replaces this one",
      );
    }

    const contentPatch: Record<string, unknown> = {};
    if (inputData.statement !== undefined) contentPatch.statement = inputData.statement;
    const body = inputData.body ?? inputData.notes;
    if (body !== undefined) contentPatch.body = body;
    if (inputData.decidedAt !== undefined) contentPatch.decidedAt = inputData.decidedAt;
    if (Object.keys(contentPatch).length === 0 && !status) {
      throw new Error("Nothing to update — pass a status and/or a statement, body or decidedAt");
    }

    let latest: DecisionShape | null = null;
    const changes: string[] = [];

    if (Object.keys(contentPatch).length > 0) {
      const { data } = await authenticatedTrpcCall<DecisionShape>(
        "decision.update",
        { workspaceId, decisionId: inputData.decisionId, ...contentPatch },
        { authToken, sessionId, userId },
      );
      latest = data ?? null;
      changes.push(`edited ${Object.keys(contentPatch).join(", ")}`);
    }

    if (status) {
      const { data } = await authenticatedTrpcCall<DecisionShape>(
        "decision.setStatus",
        {
          workspaceId,
          decisionId: inputData.decisionId,
          status,
          supersededById: inputData.supersededById ?? null,
        },
        { authToken, sessionId, userId },
      );
      latest = data ?? latest;
      changes.push(
        status === "SUPERSEDED" && data?.supersededBy
          ? `marked superseded by ${labelOf(data.supersededBy)}`
          : `status → ${status.toLowerCase()}`,
      );
    }

    if (!latest?.id) {
      throw new Error("The decision router returned no data");
    }

    const label = labelOf(latest);
    const summary = `${label}: ${changes.join("; ")}.`;
    console.log(`✅ [updateDecision] ${summary}`);
    return {
      id: latest.id,
      label,
      status: latest.status ?? status ?? "PROPOSED",
      summary,
    };
  },
});

export const listDecisionsTool = createTool({
  id: "list-decisions",
  description:
    "List the workspace's Decisions (from meetings, logged by hand, or by you) — not git ADRs. Use it to answer \"what did we decide about X\" and to resolve a label like D-0003 to an id before update-decision: pass the label itself as `search` (e.g. \"D-0003\") and the matching decision comes back with its id. Other filters: free-text search over statement and notes, status, project.",
  inputSchema: z.object({
    search: z
      .string()
      .optional()
      .describe("Free text matched against statement and notes, or a label like D-0003 to look one decision up"),
    status: looseEnum(ANY_STATUS_INPUT).optional().describe("Only decisions in this status"),
    projectId: z.string().optional().describe("Only decisions scoped to this project"),
    limit: looseNumber(z.number().int().min(1).max(100)).default(25),
  }),
  outputSchema: z.object({
    decisions: z.array(
      z.object({
        id: z.string(),
        label: z.string(),
        statement: z.string(),
        status: z.string(),
        source: z.string(),
        decidedAt: z.string().nullable(),
        meetingTitle: z.string().nullable(),
        project: z.string().nullable(),
        product: z.string().nullable(),
      }),
    ),
    total: z.number(),
  }),
  execute: async (inputData, ctx) => {
    const { authToken, sessionId, userId, workspaceId } = getAuth(ctx);
    if (!workspaceId) {
      throw new Error("No workspaceId available in request context");
    }
    // A label is not stored (it is rendered from the workspace sequence), so
    // "D-0003" is resolved here by number rather than sent as a text search.
    const labelNumber = inputData.search ? parseDecisionLabel(inputData.search) : null;
    // tRPC GET queries take their input as {"json": ...}.
    const input = JSON.stringify({
      json: {
        workspaceId,
        search: labelNumber === null ? inputData.search : undefined,
        statuses: inputData.status ? [canonicalStatus(inputData.status)] : undefined,
        projectId: inputData.projectId,
      },
    });
    const { data } = await authenticatedTrpcQuery<DecisionListRow[]>(
      `decision.list?input=${encodeURIComponent(input)}`,
      { authToken, sessionId, userId },
    );
    const all = Array.isArray(data) ? data : [];
    const rows =
      labelNumber === null
        ? all
        : all.filter((row) => row.number === labelNumber || row.label === `D-${String(labelNumber).padStart(4, "0")}`);
    const decisions = rows.slice(0, inputData.limit).map((row) => ({
      id: row.id,
      label: labelOf(row),
      statement: row.statement ?? "",
      status: row.status ?? "PROPOSED",
      source: row.source ?? "MANUAL",
      decidedAt: isoOrNull(row.decidedAt),
      meetingTitle: row.transcriptionSession?.title ?? null,
      project: row.project?.name ?? null,
      product: row.product?.name ?? null,
    }));
    return { decisions, total: rows.length };
  },
});
