import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";

// ==================== PM Agent Tools ====================
// Sprint analytics and GitHub activity tools for proactive project management.
// Calls Exponential backend tRPC endpoints (sprintAnalytics.*).

export const getActiveSprintTool = createTool({
  id: "get-active-sprint",
  description:
    "Find the active sprint for the user's workspace. Returns the sprint name, date range, and action count. Use this as the starting point when the user asks about sprint status, progress, or standup.",
  inputSchema: z.object({
    workspaceId: z.string().describe("The workspace ID to find the active sprint for"),
  }),
  outputSchema: z.object({
    id: z.string(),
    name: z.string(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    actionCount: z.number(),
  }).nullable(),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`📊 [getActiveSprint] INPUT: workspaceId=${inputData.workspaceId}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "sprintAnalytics.getActiveSprint",
        { workspaceId: inputData.workspaceId },
        { authToken, sessionId, userId },
      );

      console.log(`✅ [getActiveSprint] SUCCESS:`, data ? `Sprint "${(data as any).name}" with ${(data as any).actionCount} actions` : "No active sprint");
      return data;
    } catch (error) {
      console.error(`❌ [getActiveSprint] FAILED:`, error);
      throw error;
    }
  },
});

export const getSprintMetricsTool = createTool({
  id: "get-sprint-metrics",
  description:
    "Get detailed metrics for a sprint: velocity, kanban status counts, completion rate, scope creep, planned vs completed effort. Use this to give the user a comprehensive sprint health overview.",
  inputSchema: z.object({
    listId: z.string().describe("The sprint (list) ID — get this from get-active-sprint first"),
  }),
  outputSchema: z.object({
    sprintId: z.string(),
    sprintName: z.string(),
    startDate: z.string().nullable(),
    endDate: z.string().nullable(),
    plannedEffort: z.number(),
    completedEffort: z.number(),
    velocity: z.number(),
    plannedActions: z.number(),
    completedActions: z.number(),
    addedActions: z.number(),
    kanbanCounts: z.record(z.string(), z.number()),
    completionRate: z.number(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`📈 [getSprintMetrics] INPUT: listId=${inputData.listId}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "sprintAnalytics.getMetrics",
        { listId: inputData.listId },
        { authToken, sessionId, userId },
      );

      const metrics = data as any;
      console.log(`✅ [getSprintMetrics] SUCCESS: velocity=${metrics.velocity}, completionRate=${metrics.completionRate}%, completed=${metrics.completedActions}/${metrics.plannedActions}`);
      return data;
    } catch (error) {
      console.error(`❌ [getSprintMetrics] FAILED:`, error);
      throw error;
    }
  },
});

export const getRiskSignalsTool = createTool({
  id: "get-risk-signals",
  description:
    "Detect risk signals for a sprint: scope creep, stale items stuck in progress, overdue actions, blocked work, and velocity drops. Use this to proactively warn the user about problems before they escalate.",
  inputSchema: z.object({
    listId: z.string().describe("The sprint (list) ID — get this from get-active-sprint first"),
  }),
  outputSchema: z.array(
    z.object({
      type: z.string(),
      severity: z.enum(["low", "medium", "high", "critical"]),
      message: z.string(),
      actionIds: z.array(z.string()).optional(),
    }),
  ),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`⚠️ [getRiskSignals] INPUT: listId=${inputData.listId}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "sprintAnalytics.getRiskSignals",
        { listId: inputData.listId },
        { authToken, sessionId, userId },
      );

      const signals = data as any[];
      console.log(`✅ [getRiskSignals] SUCCESS: ${signals.length} risk signal(s) detected`);
      return data;
    } catch (error) {
      console.error(`❌ [getRiskSignals] FAILED:`, error);
      throw error;
    }
  },
});

export const getGitHubActivityTool = createTool({
  id: "get-github-activity",
  description:
    "Get a summary of GitHub activity (commits, PRs opened/merged, reviews) for a workspace since a given date. Shows how much mapped to actions vs unmapped. Use this to understand what development work has been done.",
  inputSchema: z.object({
    workspaceId: z.string().describe("The workspace ID"),
    since: z.string().describe("ISO date string — get activity since this date (e.g. yesterday for daily standup, sprint start for sprint review)"),
  }),
  outputSchema: z.object({
    totalCommits: z.number(),
    totalPRsOpened: z.number(),
    totalPRsMerged: z.number(),
    totalReviews: z.number(),
    mappedCount: z.number(),
    unmappedCount: z.number(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🐙 [getGitHubActivity] INPUT: workspaceId=${inputData.workspaceId}, since=${inputData.since}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "sprintAnalytics.getGitHubActivity",
        { workspaceId: inputData.workspaceId, since: inputData.since },
        { authToken, sessionId, userId },
      );

      const activity = data as any;
      console.log(`✅ [getGitHubActivity] SUCCESS: ${activity.totalCommits} commits, ${activity.totalPRsMerged} PRs merged, ${activity.mappedCount}/${activity.mappedCount + activity.unmappedCount} mapped to actions`);
      return data;
    } catch (error) {
      console.error(`❌ [getGitHubActivity] FAILED:`, error);
      throw error;
    }
  },
});

export const captureDailySnapshotTool = createTool({
  id: "capture-daily-snapshot",
  description:
    "Capture a daily snapshot of the sprint for burndown tracking. Records current kanban counts, effort, and GitHub activity. Call this during evening wrapup to track progress over time.",
  inputSchema: z.object({
    listId: z.string().describe("The sprint (list) ID — get this from get-active-sprint first"),
  }),
  outputSchema: z.object({
    snapshotId: z.string(),
    date: z.string(),
    kanbanCounts: z.record(z.string(), z.number()),
    actionsCompleted: z.number(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`📸 [captureDailySnapshot] INPUT: listId=${inputData.listId}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "sprintAnalytics.captureDailySnapshot",
        { listId: inputData.listId },
        { authToken, sessionId, userId },
      );

      console.log(`✅ [captureDailySnapshot] SUCCESS: snapshot captured`);
      return data;
    } catch (error) {
      console.error(`❌ [captureDailySnapshot] FAILED:`, error);
      throw error;
    }
  },
});
