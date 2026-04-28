import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";
import { asAppContext } from "../types/request-context.js";

// ──────────────────────────────────────────────────────────────────────────────
// Action Items Tools
//
// Ported from one2b's action-items-agent. These tools call exponential's
// action router procedures (bulkCreateFromTranscript, findBySource, update)
// instead of writing to a separate ActionItem table.
//
// Assignee resolution (User vs Participant) is handled server-side by
// bulkCreateFromTranscript — the tool just supplies assigneeEmail when it can
// extract one from the transcript.
// ──────────────────────────────────────────────────────────────────────────────

interface ParsedActionItem {
  assigneeName: string;
  description: string;
  rawText: string;
}

interface PreparedActionItem {
  description: string;
  assigneeName?: string;
  assigneeEmail?: string;
  priority: "HIGH" | "MEDIUM" | "LOW";
  dueDate?: string;
  rawText: string;
}

/**
 * Parse a Fireflies action_items string of the shape:
 *
 *   **Person Name**
 *   Action item text (30:52)
 *   Another item (36:14)
 *
 *   **Another Person**
 *   Their item (12:00)
 *
 * Lines without a preceding **Name** header are attributed to "Unknown".
 * The trailing timestamp like "(30:52)" is stripped from the description.
 */
function parseFirefliesActionItems(raw: string): ParsedActionItem[] {
  const items: ParsedActionItem[] = [];
  let currentAssignee = "Unknown";

  const lines = raw.split("\n");
  for (const line of lines) {
    const trimmed = line.trim();
    if (!trimmed) continue;

    // Match **Name** headers (entire line)
    const headerMatch = trimmed.match(/^\*\*(.+?)\*\*\s*$/);
    if (headerMatch) {
      currentAssignee = headerMatch[1]!.trim();
      continue;
    }

    // Strip trailing timestamp like (30:52) or (1:30:52)
    const description = trimmed
      .replace(/\s*\((\d+:)?\d+:\d+\)\s*$/, "")
      .trim();
    if (description) {
      items.push({
        assigneeName: currentAssignee,
        description,
        rawText: trimmed,
      });
    }
  }

  return items;
}

/**
 * Inspect an action item's raw text and infer a HIGH/MEDIUM/LOW priority
 * from urgency cues. Defaults to MEDIUM.
 */
function inferPriority(text: string): "HIGH" | "MEDIUM" | "LOW" {
  const lower = text.toLowerCase();
  if (
    /\basap\b|\burgent\b|\bblocking\b|\bblocker\b|before the release|by (today|tomorrow|eod|end of day)/.test(
      lower,
    )
  ) {
    return "HIGH";
  }
  if (
    /\bwhen you (get a chance|have time)\b|\bsomeday\b|\beventually\b|\bnice to have\b|\bif (you )?can\b/.test(
      lower,
    )
  ) {
    return "LOW";
  }
  return "MEDIUM";
}

/**
 * Try to extract an ISO date from common phrases like "by Friday" or
 * "by 2026-05-01". Returns undefined when no clear date is present —
 * the agent can refine this later via updateActionItemTool.
 */
function extractDueDate(text: string): string | undefined {
  // ISO date YYYY-MM-DD
  const isoMatch = text.match(/\b(\d{4}-\d{2}-\d{2})\b/);
  if (isoMatch) {
    const parsed = new Date(isoMatch[1]!);
    if (!Number.isNaN(parsed.getTime())) return parsed.toISOString();
  }
  return undefined;
}

interface TranscriptionSessionShape {
  id: string;
  title?: string | null;
  summary?: string | null;
  transcription?: string | null;
  workspaceId?: string | null;
}

interface BulkCreateResult {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  created: Array<Record<string, any>>;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  skipped: Array<Record<string, any>>;
}

export const parseActionItemsTool = createTool({
  id: "parse-action-items",
  description:
    "Extract action items from a Fireflies meeting transcript and persist them as Actions in exponential. Accepts a transcriptionSessionId. Parses the **Name** / timestamp-suffixed item format and forwards each item to action.bulkCreateFromTranscript, which handles assignee resolution server-side.",
  inputSchema: z.object({
    transcriptionSessionId: z
      .string()
      .describe("The exponential TranscriptionSession ID to parse"),
  }),
  outputSchema: z.object({
    created: z.number(),
    skipped: z.number(),
    summary: z.string(),
  }),
  execute: async (inputData, ctx) => {
    const requestContext = asAppContext(ctx.requestContext);
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");
    const workspaceId = requestContext?.get("workspaceId");

    if (!authToken) {
      throw new Error("No authentication token available in request context");
    }
    if (!workspaceId) {
      throw new Error(
        "No workspaceId available in request context — agent must be invoked with a workspace scope",
      );
    }

    console.log(
      `📥 [parseActionItems] Fetching transcript ${inputData.transcriptionSessionId}`,
    );

    const { data: session } = await authenticatedTrpcCall<TranscriptionSessionShape>(
      "transcription.getById",
      { id: inputData.transcriptionSessionId },
      { authToken, sessionId, userId },
    );

    if (!session) {
      throw new Error(
        `Transcription session not found: ${inputData.transcriptionSessionId}`,
      );
    }

    // The Fireflies summary string commonly carries action_items in
    // **Name**\nitem (timestamp) blocks. Fall back to the full transcript
    // when the summary is empty.
    const candidateText = session.summary ?? session.transcription ?? "";

    if (!candidateText.trim()) {
      return {
        created: 0,
        skipped: 0,
        summary: `No transcript or summary text available for session ${inputData.transcriptionSessionId}`,
      };
    }

    const parsed = parseFirefliesActionItems(candidateText);
    if (parsed.length === 0) {
      return {
        created: 0,
        skipped: 0,
        summary: `No action items detected in session ${inputData.transcriptionSessionId}`,
      };
    }

    const items: PreparedActionItem[] = parsed.map((item) => {
      const priority = inferPriority(item.rawText);
      const dueDate = extractDueDate(item.rawText);
      return {
        description: item.description,
        assigneeName:
          item.assigneeName && item.assigneeName !== "Unknown"
            ? item.assigneeName
            : undefined,
        // We don't have a name → email mapping here. The agent can refine
        // assigneeEmail later via updateActionItemTool, or call this tool
        // with assigneeEmail already enriched in the future. For now we
        // pass the parsed assignee name as a hint only.
        assigneeEmail: undefined,
        priority,
        dueDate,
        rawText: item.rawText,
      };
    });

    const defaultProjectId =
      process.env.ONE2B_AGENT_ACTION_PROJECT_ID ?? null;

    const { data: result } = await authenticatedTrpcCall<BulkCreateResult>(
      "action.bulkCreateFromTranscript",
      {
        transcriptionSessionId: inputData.transcriptionSessionId,
        workspaceId,
        projectId: defaultProjectId,
        items: items.map((i) => ({
          description: i.description,
          assigneeName: i.assigneeName,
          assigneeEmail: i.assigneeEmail,
          priority: i.priority,
          dueDate: i.dueDate,
          rawText: i.rawText,
        })),
      },
      { authToken, sessionId, userId },
    );

    const createdCount = Array.isArray(result?.created) ? result.created.length : 0;
    const skippedCount = Array.isArray(result?.skipped) ? result.skipped.length : 0;

    const summary =
      `Parsed ${parsed.length} action item${parsed.length === 1 ? "" : "s"} ` +
      `from session ${inputData.transcriptionSessionId}: ` +
      `${createdCount} created, ${skippedCount} skipped` +
      (defaultProjectId ? ` (assigned to project ${defaultProjectId})` : "");

    console.log(`✅ [parseActionItems] ${summary}`);

    return {
      created: createdCount,
      skipped: skippedCount,
      summary,
    };
  },
});

interface AssigneeUserShape {
  id?: string | null;
  name?: string | null;
  email?: string | null;
}

interface ActionAssigneeShape {
  user?: AssigneeUserShape | null;
}

interface ActionParticipantShape {
  email?: string | null;
  name?: string | null;
}

interface ActionParticipantAssigneeShape {
  participant?: ActionParticipantShape | null;
}

interface ActionRecordShape {
  id: string;
  name?: string | null;
  description?: string | null;
  status?: string | null;
  priority?: string | null;
  dueDate?: string | Date | null;
  createdAt?: string | Date | null;
  assignees?: ActionAssigneeShape[] | null;
  participantAssignees?: ActionParticipantAssigneeShape[] | null;
}

export const getActionItemsTool = createTool({
  id: "get-action-items",
  description:
    "Look up action items previously created from a meeting (or any source). Filters by transcriptionSessionId, assigneeEmail, and status. Returns a flattened list with assignee info already resolved (User vs Participant).",
  inputSchema: z.object({
    transcriptionSessionId: z
      .string()
      .optional()
      .describe(
        "Filter to actions created from a specific TranscriptionSession",
      ),
    assigneeEmail: z
      .string()
      .email()
      .optional()
      .describe("Filter to actions assigned to this email"),
    status: z
      .enum(["ACTIVE", "COMPLETED", "CANCELLED"])
      .optional()
      .describe("Filter by action status"),
    limit: z
      .number()
      .min(1)
      .max(100)
      .default(20)
      .describe("Max results to return"),
  }),
  outputSchema: z.array(
    z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      status: z.string(),
      priority: z.string(),
      dueDate: z.string().nullable(),
      createdAt: z.string(),
      assigneeName: z.string().optional(),
      assigneeEmail: z.string().optional(),
    }),
  ),
  execute: async (inputData, ctx) => {
    const requestContext = asAppContext(ctx.requestContext);
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");
    const workspaceId = requestContext?.get("workspaceId");

    if (!authToken) {
      throw new Error("No authentication token available in request context");
    }
    if (!workspaceId) {
      throw new Error("No workspaceId available in request context");
    }

    const { data } = await authenticatedTrpcCall<ActionRecordShape[]>(
      "action.findBySource",
      {
        workspaceId,
        sourceType: "meeting",
        sourceId: inputData.transcriptionSessionId,
        assigneeEmail: inputData.assigneeEmail,
        status: inputData.status,
        limit: inputData.limit,
      },
      { authToken, sessionId, userId },
    );

    const records = Array.isArray(data) ? data : [];

    return records.map((record) => {
      const userAssignee = record.assignees?.[0]?.user ?? null;
      const participantAssignee =
        record.participantAssignees?.[0]?.participant ?? null;

      const assigneeName =
        userAssignee?.name ?? participantAssignee?.name ?? undefined;
      const assigneeEmail =
        userAssignee?.email ?? participantAssignee?.email ?? undefined;

      const dueDate: string | null =
        record.dueDate instanceof Date
          ? record.dueDate.toISOString()
          : ((record.dueDate as string | null | undefined) ?? null);
      const createdAt: string =
        record.createdAt instanceof Date
          ? record.createdAt.toISOString()
          : ((record.createdAt as string | null | undefined) ?? new Date(0).toISOString());

      return {
        id: record.id,
        name: record.name ?? "",
        description: record.description ?? null,
        status: record.status ?? "ACTIVE",
        priority: record.priority ?? "Quick",
        dueDate,
        createdAt,
        assigneeName: assigneeName ?? undefined,
        assigneeEmail: assigneeEmail ?? undefined,
      };
    });
  },
});

interface UpdatedActionShape {
  id: string;
  status?: string | null;
  updatedAt?: string | Date | null;
}

export const updateActionItemTool = createTool({
  id: "update-action-item",
  description:
    "Update an action's status, priority, description, or due date. Translates one2b-style status (OPEN/IN_PROGRESS/COMPLETED/CANCELLED) to exponential's ACTIVE/COMPLETED/CANCELLED + kanbanStatus. If a completionNote is provided alongside a COMPLETED status, an ActionComment is added.",
  inputSchema: z.object({
    actionItemId: z.string().describe("The exponential Action ID to update"),
    status: z
      .enum(["OPEN", "IN_PROGRESS", "COMPLETED", "OVERDUE", "CANCELLED"])
      .optional()
      .describe(
        "New status. OVERDUE is derived server-side and is ignored if passed here.",
      ),
    priority: z
      .enum(["HIGH", "MEDIUM", "LOW"])
      .optional()
      .describe("New priority — translated to exponential's priority scale."),
    description: z
      .string()
      .optional()
      .describe("Refined action description"),
    dueDate: z
      .string()
      .datetime()
      .optional()
      .describe("New due date in ISO 8601 format"),
    completionNote: z
      .string()
      .optional()
      .describe(
        "Optional note to attach as a comment when marking the action COMPLETED.",
      ),
  }),
  outputSchema: z.object({
    id: z.string(),
    status: z.string(),
    updatedAt: z.string(),
  }),
  execute: async (inputData, ctx) => {
    const requestContext = asAppContext(ctx.requestContext);
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      throw new Error("No authentication token available in request context");
    }

    // Translate the agent-facing status enum to exponential's schema.
    // Stamp source attribution so the action's audit trail records that
    // an agent (specifically this tool) made the change.
    const updatePayload: Record<string, unknown> = {
      id: inputData.actionItemId,
      lastUpdatedBy: "AGENT",
      lastUpdatedSource: "agent-action-items-tool",
    };

    if (inputData.status === "OPEN" || inputData.status === "IN_PROGRESS") {
      updatePayload.status = "ACTIVE";
      if (inputData.status === "IN_PROGRESS") {
        updatePayload.kanbanStatus = "IN_PROGRESS";
      }
    } else if (inputData.status === "COMPLETED") {
      updatePayload.status = "COMPLETED";
    } else if (inputData.status === "CANCELLED") {
      updatePayload.status = "CANCELLED";
    }
    // OVERDUE is intentionally ignored — exponential derives it from due date.

    if (inputData.priority) {
      const priorityMap: Record<"HIGH" | "MEDIUM" | "LOW", string> = {
        HIGH: "1st Priority",
        MEDIUM: "Quick",
        LOW: "5th Priority",
      };
      updatePayload.priority = priorityMap[inputData.priority];
    }

    if (inputData.description !== undefined) {
      updatePayload.description = inputData.description;
    }

    if (inputData.dueDate !== undefined) {
      updatePayload.dueDate = inputData.dueDate;
    }

    const { data: updated } = await authenticatedTrpcCall<UpdatedActionShape>(
      "action.update",
      updatePayload,
      { authToken, sessionId, userId },
    );

    if (!updated?.id) {
      throw new Error("action.update returned no data");
    }

    // Optional: attach a comment with the completion note.
    if (inputData.completionNote && inputData.status === "COMPLETED") {
      try {
        await authenticatedTrpcCall(
          "actionComment.addComment",
          {
            actionId: inputData.actionItemId,
            content: inputData.completionNote,
          },
          { authToken, sessionId, userId },
        );
      } catch (err) {
        console.warn(
          `⚠️ [updateActionItem] Failed to attach completion note as comment:`,
          err,
        );
      }
    }

    const updatedAt: string =
      updated.updatedAt instanceof Date
        ? updated.updatedAt.toISOString()
        : ((updated.updatedAt as string | null | undefined) ?? new Date().toISOString());

    return {
      id: updated.id,
      status: updated.status ?? "ACTIVE",
      updatedAt,
    };
  },
});
