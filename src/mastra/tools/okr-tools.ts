import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";
import { looseNumber } from "./zod-loose.js";

// ==================== OKR Tools ====================
// CRUD operations for Objectives (Goals) and Key Results.
// Calls Exponential backend tRPC endpoints (mastra.* mutations).

export const getOkrObjectivesTool = createTool({
  id: "get-okr-objectives",
  description:
    "Get all OKR objectives (goals) with their key results and progress for the current workspace. Use this to show the user their OKRs, check progress, or find objectives to add key results to. IMPORTANT: When looking up an objective by name (to add a KR or modify it), do NOT filter by period — fetch all objectives so you can match by name. Only use the period filter when the user explicitly asks to see a specific period's OKRs.",
  inputSchema: z.object({
    period: z.string().optional().describe(
      "Filter by OKR period (e.g., 'Q1-2026', 'H1-2026', 'Annual-2026'). IMPORTANT: Do NOT use this filter when searching for an objective by name — leave it empty to return all objectives. Only filter by period when the user explicitly asks for a specific period's view."
    ),
  }),
  outputSchema: z.object({
    objectives: z.array(z.object({
      id: z.number(),
      title: z.string(),
      description: z.string().nullable(),
      whyThisGoal: z.string().nullable(),
      period: z.string().nullable(),
      lifeDomain: z.object({ id: z.number(), title: z.string() }).nullable(),
      keyResults: z.array(z.object({
        id: z.string(),
        title: z.string(),
        currentValue: z.number(),
        targetValue: z.number(),
        startValue: z.number(),
        unit: z.string(),
        unitLabel: z.string().nullable(),
        status: z.string(),
        confidence: z.number().nullable(),
        period: z.string(),
      })),
      progress: z.number(),
    })),
    total: z.number(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;
    const workspaceId = requestContext?.get("workspaceId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🎯 [getOkrObjectives] Fetching objectives, period=${inputData.period || "all"}`);

    const { data } = await authenticatedTrpcCall(
      "mastra.getOkrObjectives",
      { workspaceId: workspaceId || undefined, period: inputData.period },
      { authToken, sessionId, userId }
    );

    console.log(`✅ [getOkrObjectives] Retrieved ${(data as any)?.total || 0} objectives`);
    return data;
  },
});

export const createOkrObjectiveTool = createTool({
  id: "create-okr-objective",
  description:
    "Create a new OKR Objective (goal). An objective is a qualitative, aspirational goal. Always confirm the objective title and period with the user before creating.",
  inputSchema: z.object({
    title: z.string().describe("The objective title - should be aspirational and qualitative"),
    description: z.string().optional().describe("More detail about the objective"),
    whyThisGoal: z.string().optional().describe("Why this objective matters"),
    period: z.string().optional().describe("OKR period (e.g., 'Q1-2026', 'H1-2026', 'Annual-2026')"),
    lifeDomainId: looseNumber().optional().describe("Life domain ID to categorize this objective"),
    parentGoalId: looseNumber().optional().describe("Parent objective (goal) ID to nest this under. When the user is viewing a goal and asks to create goals 'under this goal' / as phases of it, use that goal's ID (from the page context) here."),
  }),
  outputSchema: z.object({
    objective: z.object({
      id: z.number(),
      title: z.string(),
      description: z.string().nullable(),
      period: z.string().nullable(),
      parentGoalId: z.number().nullable(),
      lifeDomain: z.object({ id: z.number(), title: z.string() }).nullable(),
      workspaceId: z.string().nullable(),
    }),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;
    const workspaceId = requestContext?.get("workspaceId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🎯 [createOkrObjective] Creating: "${inputData.title}", period=${inputData.period || "none"}`);

    const { data } = await authenticatedTrpcCall(
      "mastra.createOkrObjective",
      { ...inputData, workspaceId: workspaceId || undefined },
      { authToken, sessionId, userId }
    );

    console.log(`✅ [createOkrObjective] Created objective: ${(data as any)?.objective?.id}`);
    return data;
  },
});

export const updateOkrObjectiveTool = createTool({
  id: "update-okr-objective",
  description:
    "Update an existing OKR Objective. Only include fields you want to change.",
  inputSchema: z.object({
    id: looseNumber().describe("The objective ID to update"),
    title: z.string().optional().describe("Updated objective title"),
    description: z.string().optional().describe("Updated description"),
    whyThisGoal: z.string().optional().describe("Updated reason"),
    period: z.string().optional().describe("Updated OKR period"),
    lifeDomainId: looseNumber().optional().describe("Updated life domain ID"),
  }),
  outputSchema: z.object({
    objective: z.object({
      id: z.number(),
      title: z.string(),
      description: z.string().nullable(),
      period: z.string().nullable(),
    }),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🎯 [updateOkrObjective] Updating objective ${inputData.id}`);

    const { data } = await authenticatedTrpcCall(
      "mastra.updateOkrObjective",
      inputData,
      { authToken, sessionId, userId }
    );

    console.log(`✅ [updateOkrObjective] Updated objective ${inputData.id}`);
    return data;
  },
});

export const deleteOkrObjectiveTool = createTool({
  id: "delete-okr-objective",
  description:
    "Delete an OKR Objective and all its key results. CRITICAL: Always confirm with the user before deleting. This is irreversible.",
  inputSchema: z.object({
    id: looseNumber().describe("The objective ID to delete"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    deletedKeyResults: z.number(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🎯 [deleteOkrObjective] Deleting objective ${inputData.id}`);

    const { data } = await authenticatedTrpcCall(
      "mastra.deleteOkrObjective",
      inputData,
      { authToken, sessionId, userId }
    );

    console.log(`✅ [deleteOkrObjective] Deleted objective ${inputData.id}, KRs removed: ${(data as any)?.deletedKeyResults}`);
    return data;
  },
});

export const createOkrKeyResultTool = createTool({
  id: "create-okr-key-result",
  description:
    "Create a new Key Result linked to an Objective. A Key Result is a MEASURABLE OUTCOME (e.g., 'Increase MRR from $10k to $20k', 'Reach 500 active users'), NOT an initiative or task (e.g., 'Complete workshop', 'Establish cadence', 'Document Q1 objectives', 'Launch X'). Before calling this tool, verify the title describes a result with a target number — not an activity. If the user's proposed text is an initiative, activity, or checkbox-style milestone, DO NOT call this tool. Instead, explain why it isn't a KR, propose 1–3 measurable reworded alternatives (outcomes of that work), and get the user's explicit confirmation on one before creating.",
  inputSchema: z.object({
    goalId: looseNumber().describe("The parent objective (goal) ID"),
    title: z.string().describe("The key result title - should be specific and measurable"),
    description: z.string().optional().describe("Additional detail"),
    targetValue: looseNumber().describe("The target value to achieve (e.g., 100 for 100%, 50 for 50 customers)"),
    startValue: looseNumber().optional().default(0).describe("Starting value (default: 0)"),
    unit: z.enum(["percent", "count", "currency", "hours", "custom"]).optional().default("percent")
      .describe("Unit of measurement"),
    unitLabel: z.string().optional().describe("Custom unit label (e.g., 'customers', 'deals') - used when unit is 'custom'"),
    period: z.string().describe("OKR period (e.g., 'Q1-2026')"),
  }),
  outputSchema: z.object({
    keyResult: z.object({
      id: z.string(),
      title: z.string(),
      targetValue: z.number(),
      startValue: z.number(),
      currentValue: z.number(),
      unit: z.string(),
      status: z.string(),
      period: z.string(),
      goalId: z.number(),
      goal: z.object({ id: z.number(), title: z.string() }),
    }),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;
    const workspaceId = requestContext?.get("workspaceId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`📊 [createOkrKeyResult] Creating KR for objective ${inputData.goalId}: "${inputData.title}"`);

    const { data } = await authenticatedTrpcCall(
      "mastra.createOkrKeyResult",
      { ...inputData, workspaceId: workspaceId || undefined },
      { authToken, sessionId, userId }
    );

    console.log(`✅ [createOkrKeyResult] Created KR: ${(data as any)?.keyResult?.id}`);
    return data;
  },
});

export const updateOkrKeyResultTool = createTool({
  id: "update-okr-key-result",
  description:
    "Update an existing Key Result. Only include fields you want to change. To update progress, prefer using the check-in tool instead. If you are rewriting the title, the new title must still be a measurable outcome (has a target number, is not an initiative/task) — apply the same KR best-practice check as create-okr-key-result and push back with reworded alternatives if the user proposes initiative-style text.",
  inputSchema: z.object({
    id: z.string().describe("The key result ID to update"),
    title: z.string().optional().describe("Updated title"),
    description: z.string().optional().describe("Updated description"),
    targetValue: looseNumber().optional().describe("Updated target value"),
    currentValue: looseNumber().optional().describe("Updated current value"),
    startValue: looseNumber().optional().describe("Updated start value"),
    unit: z.enum(["percent", "count", "currency", "hours", "custom"]).optional(),
    unitLabel: z.string().optional(),
    status: z.enum(["not-started", "on-track", "at-risk", "off-track", "achieved"]).optional()
      .describe("Manual status override"),
    confidence: looseNumber(z.number().min(0).max(100)).optional().describe("Confidence level 0-100"),
  }),
  outputSchema: z.object({
    keyResult: z.object({
      id: z.string(),
      title: z.string(),
      targetValue: z.number(),
      currentValue: z.number(),
      status: z.string(),
      confidence: z.number().nullable(),
      goal: z.object({ id: z.number(), title: z.string() }),
    }),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`📊 [updateOkrKeyResult] Updating KR ${inputData.id}`);

    const { data } = await authenticatedTrpcCall(
      "mastra.updateOkrKeyResult",
      inputData,
      { authToken, sessionId, userId }
    );

    console.log(`✅ [updateOkrKeyResult] Updated KR ${inputData.id}`);
    return data;
  },
});

export const deleteOkrKeyResultTool = createTool({
  id: "delete-okr-key-result",
  description:
    "Delete a Key Result. CRITICAL: Always confirm with the user before deleting. This removes the KR and all its check-in history.",
  inputSchema: z.object({
    id: z.string().describe("The key result ID to delete"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`📊 [deleteOkrKeyResult] Deleting KR ${inputData.id}`);

    const { data } = await authenticatedTrpcCall(
      "mastra.deleteOkrKeyResult",
      inputData,
      { authToken, sessionId, userId }
    );

    console.log(`✅ [deleteOkrKeyResult] Deleted KR ${inputData.id}`);
    return data;
  },
});

export const checkInOkrKeyResultTool = createTool({
  id: "checkin-okr-key-result",
  description:
    "Record a progress check-in on a Key Result. This updates the current value and automatically calculates the status (on-track, at-risk, off-track, achieved). Use this instead of update when the user reports progress.",
  inputSchema: z.object({
    keyResultId: z.string().describe("The key result ID to check in on"),
    newValue: looseNumber().describe("The new current value"),
    notes: z.string().optional().describe("Check-in notes explaining the progress"),
  }),
  outputSchema: z.object({
    checkIn: z.object({
      id: z.string(),
      previousValue: z.number(),
      newValue: z.number(),
      notes: z.string().nullable(),
      createdAt: z.string(),
    }),
    keyResult: z.object({
      id: z.string(),
      title: z.string(),
      currentValue: z.number(),
      targetValue: z.number(),
      status: z.string(),
    }),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`📊 [checkInOkrKeyResult] Check-in on KR ${inputData.keyResultId}: value=${inputData.newValue}`);

    const { data } = await authenticatedTrpcCall(
      "mastra.checkInOkrKeyResult",
      inputData,
      { authToken, sessionId, userId }
    );

    console.log(`✅ [checkInOkrKeyResult] Check-in recorded, status=${(data as any)?.keyResult?.status}`);
    return data;
  },
});

export const getOkrStatsTool = createTool({
  id: "get-okr-stats",
  description:
    "Get OKR dashboard statistics including total objectives, key results, progress averages, and status breakdown. Useful for giving the user a quick overview of their OKR health.",
  inputSchema: z.object({
    period: z.string().optional().describe("Filter by period (e.g., 'Q1-2026')"),
  }),
  outputSchema: z.object({
    totalObjectives: z.number(),
    totalKeyResults: z.number(),
    completedKeyResults: z.number(),
    statusBreakdown: z.object({
      onTrack: z.number(),
      atRisk: z.number(),
      offTrack: z.number(),
      achieved: z.number(),
    }),
    averageProgress: z.number(),
    averageConfidence: z.number().nullable(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;
    const workspaceId = requestContext?.get("workspaceId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`📊 [getOkrStats] Fetching OKR stats, period=${inputData.period || "all"}`);

    const { data } = await authenticatedTrpcCall(
      "mastra.getOkrStats",
      { workspaceId: workspaceId || undefined, period: inputData.period },
      { authToken, sessionId, userId }
    );

    console.log(`✅ [getOkrStats] Stats retrieved: ${(data as any)?.totalObjectives} objectives, ${(data as any)?.totalKeyResults} KRs`);
    return data;
  },
});

export const addObjectiveCommentTool = createTool({
  id: "add-objective-comment",
  description:
    "Post a narrative comment to an Objective's (goal's) activity feed on the user's behalf. A comment is a NOTE with NO health — it never moves the Objective's status badge. Use this for narrative notes (a strategy summary, context, a recap of what was agreed), NOT for status/progress statements (use a check-in or an Objective update for those). The Objective the user is viewing is provided in the page context as goalId — use it directly; do not ask for the Objective name. CRITICAL: ALWAYS draft the comment text and show it to the user, then post ONLY after they explicitly confirm. After posting, tell the user it's done and which Objective it landed on.",
  inputSchema: z.object({
    goalId: looseNumber().describe("The numeric ID of the Objective (goal) to comment on — from the page context. Tolerant of a stringified number because the model often emits it as text lifted from the prompt."),
    content: z.string().min(1).max(10000).describe("The comment text to post (markdown). Draft this and get the user's explicit confirmation before calling the tool."),
  }),
  outputSchema: z.object({
    id: z.string(),
    goalId: z.number(),
    authorId: z.string(),
    content: z.string(),
    createdAt: z.string(),
    author: z.object({
      id: z.string(),
      name: z.string().nullable(),
      image: z.string().nullable(),
    }).nullable().optional(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`💬 [addObjectiveComment] Posting comment to objective ${inputData.goalId}`);

    const { data } = await authenticatedTrpcCall(
      "mastra.addGoalComment",
      { goalId: inputData.goalId, content: inputData.content },
      { authToken, sessionId, userId }
    );

    console.log(`✅ [addObjectiveComment] Posted comment ${(data as any)?.id} to objective ${inputData.goalId}`);
    return data;
  },
});

export const addObjectiveUpdateTool = createTool({
  id: "add-objective-update",
  description:
    "Post a health-bearing update (check-in) to an Objective's (goal's) activity feed on the user's behalf. An update carries a HEALTH (on-track | at-risk | off-track) and MOVES the Objective's status badge — use it for status/progress statements (\"we're behind on this\", \"back on track\"), NOT for narrative notes (use add-objective-comment for those). The Objective the user is viewing is provided in the page context as goalId — use it directly. Infer the health from the conversation; when there is no clear signal, default to the Objective's CURRENT health (shown as \"Current health\" in your goal page context) so a narrative-ish update never silently flips the status. CRITICAL: ALWAYS draft both the update text AND the health value you will set, show them to the user, and post ONLY after they explicitly confirm. Never set a manual status override — that stays the user's \"Set status\" action. After posting, tell the user it's done, which Objective, and the health you set.",
  inputSchema: z.object({
    goalId: looseNumber().describe("The numeric ID of the Objective (goal) to update — from the page context. Tolerant of a stringified number because the model often emits it as text lifted from the prompt."),
    content: z.string().min(1).max(10000).describe("The update text (markdown). Draft this and get the user's explicit confirmation before calling the tool."),
    health: z.enum(["on-track", "at-risk", "off-track"]).describe("The health this check-in sets — moves the status badge. Infer from the conversation; default to the Objective's current health when unclear. Show it in the draft and confirm before posting."),
  }),
  outputSchema: z.object({
    id: z.string(),
    goalId: z.number(),
    authorId: z.string(),
    content: z.string(),
    health: z.string(),
    createdAt: z.string(),
    author: z.object({
      id: z.string(),
      name: z.string().nullable(),
      image: z.string().nullable(),
    }).nullable().optional(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`📌 [addObjectiveUpdate] Posting ${inputData.health} update to objective ${inputData.goalId}`);

    const { data } = await authenticatedTrpcCall(
      "mastra.addGoalUpdate",
      { goalId: inputData.goalId, content: inputData.content, health: inputData.health },
      { authToken, sessionId, userId }
    );

    console.log(`✅ [addObjectiveUpdate] Posted update ${(data as any)?.id} to objective ${inputData.goalId}`);
    return data;
  },
});

export const linkProjectToGoalTool = createTool({
  id: "link-project-to-goal",
  description:
    "Link a project to an OKR objective (goal). Use this when the user wants to associate or connect a project with a goal/objective. You need both the numeric goal ID and the project ID string.",
  inputSchema: z.object({
    goalId: looseNumber().describe("The numeric ID of the OKR objective/goal"),
    projectId: z.string().describe("The ID of the project to link to the goal"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    goalId: z.number(),
    projectId: z.string(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🔗 [linkProjectToGoal] Linking project ${inputData.projectId} to goal ${inputData.goalId}`);

    const { data } = await authenticatedTrpcCall(
      "mastra.linkProjectToGoal",
      { goalId: inputData.goalId, projectId: inputData.projectId },
      { authToken, sessionId, userId }
    );

    console.log(`✅ [linkProjectToGoal] Success`);
    return data;
  },
});

export const linkObjectiveToParentTool = createTool({
  id: "link-objective-to-parent",
  description:
    "Nest an Objective (goal) under a parent Objective to build a goal hierarchy — e.g. make existing goals into sub-goals/phases of a north-star goal. Both are numeric goal IDs. To detach a goal (make it top-level again), pass parentGoalId = null. The backend rejects cycles and nesting deeper than 5 levels.",
  inputSchema: z.object({
    goalId: looseNumber().describe("The numeric ID of the Objective (goal) to re-parent"),
    parentGoalId: looseNumber().nullable().describe("The numeric ID of the parent Objective to nest under, or null to detach (make top-level)"),
  }),
  outputSchema: z.object({
    objective: z.object({
      id: z.number(),
      title: z.string(),
      parentGoalId: z.number().nullable(),
      parentGoal: z.object({ id: z.number(), title: z.string() }).nullable(),
    }),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🔗 [linkObjectiveToParent] Nesting goal ${inputData.goalId} under ${inputData.parentGoalId}`);

    const { data } = await authenticatedTrpcCall(
      "mastra.setObjectiveParent",
      { goalId: inputData.goalId, parentGoalId: inputData.parentGoalId },
      { authToken, sessionId, userId }
    );

    console.log(`✅ [linkObjectiveToParent] Success`);
    return data;
  },
});

export const unlinkProjectFromGoalTool = createTool({
  id: "unlink-project-from-goal",
  description:
    "Remove the link between a project and an OKR objective (goal). Use this when the user wants to dissociate or disconnect a project from a goal/objective.",
  inputSchema: z.object({
    goalId: looseNumber().describe("The numeric ID of the OKR objective/goal"),
    projectId: z.string().describe("The ID of the project to unlink from the goal"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    goalId: z.number(),
    projectId: z.string(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🔗 [unlinkProjectFromGoal] Unlinking project ${inputData.projectId} from goal ${inputData.goalId}`);

    const { data } = await authenticatedTrpcCall(
      "mastra.unlinkProjectFromGoal",
      { goalId: inputData.goalId, projectId: inputData.projectId },
      { authToken, sessionId, userId }
    );

    console.log(`✅ [unlinkProjectFromGoal] Success`);
    return data;
  },
});
