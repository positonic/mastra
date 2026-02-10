import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";

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
    lifeDomainId: z.number().optional().describe("Life domain ID to categorize this objective"),
  }),
  outputSchema: z.object({
    objective: z.object({
      id: z.number(),
      title: z.string(),
      description: z.string().nullable(),
      period: z.string().nullable(),
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
    id: z.number().describe("The objective ID to update"),
    title: z.string().optional().describe("Updated objective title"),
    description: z.string().optional().describe("Updated description"),
    whyThisGoal: z.string().optional().describe("Updated reason"),
    period: z.string().optional().describe("Updated OKR period"),
    lifeDomainId: z.number().optional().describe("Updated life domain ID"),
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
    id: z.number().describe("The objective ID to delete"),
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
    "Create a new Key Result linked to an Objective. Key results are measurable outcomes that indicate progress toward the objective. Always confirm details with the user before creating.",
  inputSchema: z.object({
    goalId: z.number().describe("The parent objective (goal) ID"),
    title: z.string().describe("The key result title - should be specific and measurable"),
    description: z.string().optional().describe("Additional detail"),
    targetValue: z.number().describe("The target value to achieve (e.g., 100 for 100%, 50 for 50 customers)"),
    startValue: z.number().optional().default(0).describe("Starting value (default: 0)"),
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
    "Update an existing Key Result. Only include fields you want to change. To update progress, prefer using the check-in tool instead.",
  inputSchema: z.object({
    id: z.string().describe("The key result ID to update"),
    title: z.string().optional().describe("Updated title"),
    description: z.string().optional().describe("Updated description"),
    targetValue: z.number().optional().describe("Updated target value"),
    currentValue: z.number().optional().describe("Updated current value"),
    startValue: z.number().optional().describe("Updated start value"),
    unit: z.enum(["percent", "count", "currency", "hours", "custom"]).optional(),
    unitLabel: z.string().optional(),
    status: z.enum(["not-started", "on-track", "at-risk", "off-track", "achieved"]).optional()
      .describe("Manual status override"),
    confidence: z.number().min(0).max(100).optional().describe("Confidence level 0-100"),
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
    newValue: z.number().describe("The new current value"),
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
