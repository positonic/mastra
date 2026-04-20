import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";

// ==================== Project & Action Management Tools ====================
// Tools for creating projects and updating actions (including moving between projects).
// Calls Exponential backend tRPC endpoints (mastra.* mutations).

export const createProjectTool = createTool({
  id: "create-project",
  description:
    "Create a new project in the user's workspace. Use this when the user asks to create, set up, or start a new project. Always confirm the project name with the user before creating.",
  inputSchema: z.object({
    name: z.string().min(1).describe("The project name"),
    description: z.string().optional().describe("A brief description of the project's purpose"),
    status: z
      .enum(["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"])
      .optional()
      .describe("Project status (defaults to ACTIVE)"),
    priority: z
      .enum(["HIGH", "MEDIUM", "LOW", "NONE"])
      .optional()
      .describe("Project priority (defaults to MEDIUM)"),
  }),
  outputSchema: z.object({
    project: z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      status: z.string(),
      priority: z.string(),
      slug: z.string(),
    }),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;
    const workspaceId = requestContext?.get("workspaceId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🏗️ [createProject] INPUT: name="${inputData.name}", status=${inputData.status || "ACTIVE"}, priority=${inputData.priority || "MEDIUM"}`);
    console.log(`🏗️ [createProject] CONTEXT: authToken=${authToken ? "present" : "MISSING"}, userId=${userId || "none"}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.createProject",
        {
          name: inputData.name,
          description: inputData.description,
          status: inputData.status || "ACTIVE",
          priority: inputData.priority || "MEDIUM",
          workspaceId: workspaceId || undefined,
        },
        { authToken, sessionId, userId }
      );

      console.log(`✅ [createProject] SUCCESS:`, JSON.stringify(data));
      return data;
    } catch (error) {
      console.error(`❌ [createProject] FAILED:`, error);
      throw error;
    }
  },
});

export const updateActionTool = createTool({
  id: "update-action",
  description:
    "Update an existing action's fields. Use this to rename actions, change priority/status, set due dates, or move actions between projects by changing the projectId. Set projectId to null to unassign an action from its project.",
  inputSchema: z.object({
    actionId: z.string().describe("The ID of the action to update"),
    name: z.string().min(1).optional().describe("New name for the action"),
    description: z.string().nullable().optional().describe("New description (set null to clear)"),
    projectId: z.string().nullable().optional().describe("Move the action to this project ID, or null to unassign from any project"),
    priority: z
      .enum([
        "Quick", "Scheduled",
        "1st Priority", "2nd Priority", "3rd Priority", "4th Priority", "5th Priority",
        "Errand", "Remember", "Watch", "Someday Maybe",
      ])
      .optional()
      .describe("New priority level"),
    status: z
      .enum(["ACTIVE", "COMPLETED", "CANCELLED"])
      .optional()
      .describe("New status"),
    dueDate: z.string().nullable().optional().describe("New due date in ISO format, or null to clear"),
  }),
  outputSchema: z.object({
    action: z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      status: z.string(),
      priority: z.string(),
      dueDate: z.string().nullable().optional(),
      projectId: z.string().nullable(),
      project: z.object({
        id: z.string(),
        name: z.string(),
      }).nullable().optional(),
    }),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`✏️ [updateAction] INPUT: actionId=${inputData.actionId}, changes=${JSON.stringify(inputData)}`);
    console.log(`✏️ [updateAction] CONTEXT: authToken=${authToken ? "present" : "MISSING"}, userId=${userId || "none"}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.updateAction",
        inputData,
        { authToken, sessionId, userId }
      );

      console.log(`✅ [updateAction] SUCCESS:`, JSON.stringify(data));
      return data;
    } catch (error) {
      console.error(`❌ [updateAction] FAILED:`, error);
      throw error;
    }
  },
});

export const deleteProjectTool = createTool({
  id: "delete-project",
  description:
    "Permanently delete a project. This action cannot be undone — all project data will be lost. Always confirm with the user before deleting. Ask the user to confirm by name before proceeding.",
  inputSchema: z.object({
    projectId: z.string().describe("The ID of the project to delete"),
    confirmDeletion: z.boolean().describe("Must be explicitly true to proceed — confirm with the user before setting this"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    projectId: z.string(),
    name: z.string(),
  }),
  async execute(inputData, { requestContext }) {
    if (!inputData.confirmDeletion) throw new Error("Deletion not confirmed — set confirmDeletion to true after getting user confirmation");

    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🗑️ [deleteProject] Deleting project ${inputData.projectId}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.deleteProject",
        { projectId: inputData.projectId },
        { authToken, sessionId, userId }
      );

      console.log(`✅ [deleteProject] SUCCESS: deleted project ${inputData.projectId}`);
      return data;
    } catch (error) {
      console.error(`❌ [deleteProject] FAILED:`, error);
      throw error;
    }
  },
});

export const getUserWorkspacesTool = createTool({
  id: "get-user-workspaces",
  description:
    "List all workspaces the user belongs to, with their IDs, names, slugs, and the user's role. Use this before bulk creation operations that span multiple workspaces — confirm the target workspace ID before creating goals or projects in it.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    workspaces: z.array(z.object({
      id: z.string(),
      name: z.string(),
      slug: z.string(),
      type: z.string(),
      role: z.string(),
    })),
  }),
  async execute(_inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🏢 [getUserWorkspaces] Fetching workspaces for user`);

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.getUserWorkspaces",
        {},
        { authToken, sessionId, userId }
      );

      console.log(`✅ [getUserWorkspaces] Found ${(data as any)?.workspaces?.length ?? 0} workspaces`);
      return data;
    } catch (error) {
      console.error(`❌ [getUserWorkspaces] FAILED:`, error);
      throw error;
    }
  },
});

export const bulkCreateWorkspaceStructureTool = createTool({
  id: "bulk-create-workspace-structure",
  description:
    "Create a complete hierarchy of goals, projects, and actions in a single atomic operation. Use this when the user provides a structured list of goals with associated projects and actions — it's far more reliable than creating items one by one. Returns a manifest of everything created and anything that failed, so you can give the user an accurate verified summary.",
  inputSchema: z.object({
    workspaceId: z.string().describe("The ID of the workspace to create items in — use get-user-workspaces to find it"),
    goals: z.array(z.object({
      title: z.string().describe("Goal/objective title"),
      description: z.string().optional().describe("Goal description"),
      projects: z.array(z.object({
        name: z.string().describe("Project name"),
        description: z.string().optional().describe("Project description"),
        priority: z.enum(["HIGH", "MEDIUM", "LOW", "NONE"]).optional().describe("Project priority (defaults to MEDIUM)"),
        actions: z.array(z.object({
          name: z.string().describe("Action/task name"),
        })).optional().describe("Actions to create under this project"),
      })).optional().describe("Projects to create under this goal"),
    })).describe("Goals to create, each with their projects and actions"),
  }),
  outputSchema: z.object({
    created: z.array(z.object({
      type: z.string(),
      name: z.string(),
      id: z.union([z.string(), z.number()]),
    })),
    failed: z.array(z.object({
      type: z.string(),
      name: z.string(),
      error: z.string(),
    })),
    totalCreated: z.number(),
    totalFailed: z.number(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    const goalCount = inputData.goals.length;
    const projectCount = inputData.goals.reduce((sum, g) => sum + (g.projects?.length ?? 0), 0);
    const actionCount = inputData.goals.reduce((sum, g) =>
      sum + (g.projects ?? []).reduce((ps, p) => ps + (p.actions?.length ?? 0), 0), 0);

    console.log(`🏗️ [bulkCreate] Creating ${goalCount} goals, ${projectCount} projects, ${actionCount} actions in workspace ${inputData.workspaceId}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.bulkCreateStructure",
        inputData,
        { authToken, sessionId, userId }
      );

      const result = data as { created: any[]; failed: any[]; totalCreated: number; totalFailed: number };
      console.log(`✅ [bulkCreate] Done: ${result.totalCreated} created, ${result.totalFailed} failed`);
      return result;
    } catch (error) {
      console.error(`❌ [bulkCreate] FAILED:`, error);
      throw error;
    }
  },
});
