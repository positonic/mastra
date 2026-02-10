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
