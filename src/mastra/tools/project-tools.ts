import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";
import { looseBoolean, looseEnum, looseNumber, looseStringArray } from "./zod-loose.js";

// ==================== Project & Action Management Tools ====================
// Tools for creating projects and updating actions (including moving between projects).
// Calls Exponential backend tRPC endpoints (mastra.* mutations).

export const createProjectTool = createTool({
  id: "create-project",
  description:
    "Create a new project in the user's workspace. Use this when the user asks to create, set up, or start a new project. Optionally set a start and end date — useful for time-boxed projects like trips or events (e.g. \"Sailing in Croatia Sep 19-26\"). Always confirm the project name with the user before creating.",
  inputSchema: z.object({
    name: z.string().min(1).describe("The project name"),
    description: z.string().optional().describe("A brief description of the project's purpose"),
    status: looseEnum(["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"])
      .optional()
      .describe("Project status (defaults to ACTIVE)"),
    priority: looseEnum(["HIGH", "MEDIUM", "LOW", "NONE"])
      .optional()
      .describe("Project priority (defaults to MEDIUM)"),
    startDate: z.string().optional().describe("Project start date as an ISO datetime string. For a date-only value use noon UTC (e.g. \"2026-09-19T12:00:00Z\") to avoid timezone off-by-one shifts."),
    endDate: z.string().optional().describe("Project end date as an ISO datetime string. For a date-only value use noon UTC (e.g. \"2026-09-26T12:00:00Z\") to avoid timezone off-by-one shifts."),
  }),
  outputSchema: z.object({
    project: z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      status: z.string(),
      priority: z.string(),
      slug: z.string(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
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
          startDate: inputData.startDate || undefined,
          endDate: inputData.endDate || undefined,
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

export const updateProjectTool = createTool({
  id: "update-project",
  description:
    "Update an existing project's fields. Use this to rename a project, change its description, status, or priority, or set/clear its start and end dates (e.g. assigning a trip's date range to its project). Only the fields you provide are changed. Pass a date as null to clear it.",
  inputSchema: z.object({
    projectId: z.string().describe("The ID of the project to update"),
    name: z.string().min(1).optional().describe("New name for the project"),
    description: z.string().nullable().optional().describe("New description (set null to clear)"),
    status: looseEnum(["ACTIVE", "ON_HOLD", "COMPLETED", "CANCELLED"])
      .optional()
      .describe("New project status"),
    priority: looseEnum(["HIGH", "MEDIUM", "LOW", "NONE"])
      .optional()
      .describe("New project priority"),
    startDate: z.string().nullable().optional().describe("Project start date as an ISO datetime string, or null to clear. For a date-only value use noon UTC (e.g. \"2026-09-19T12:00:00Z\") to avoid timezone off-by-one shifts."),
    endDate: z.string().nullable().optional().describe("Project end date as an ISO datetime string, or null to clear. For a date-only value use noon UTC (e.g. \"2026-09-26T12:00:00Z\") to avoid timezone off-by-one shifts."),
  }),
  outputSchema: z.object({
    project: z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      status: z.string(),
      priority: z.string(),
      slug: z.string(),
      startDate: z.string().nullable(),
      endDate: z.string().nullable(),
    }),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`✏️ [updateProject] INPUT: projectId=${inputData.projectId}, changes=${JSON.stringify(inputData)}`);
    console.log(`✏️ [updateProject] CONTEXT: authToken=${authToken ? "present" : "MISSING"}, userId=${userId || "none"}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.updateProject",
        inputData,
        { authToken, sessionId, userId }
      );

      console.log(`✅ [updateProject] SUCCESS:`, JSON.stringify(data));
      return data;
    } catch (error) {
      console.error(`❌ [updateProject] FAILED:`, error);
      throw error;
    }
  },
});

export const updateActionTool = createTool({
  id: "update-action",
  description:
    "Update an existing action's fields. Use this to rename actions, change priority/status, set due dates, reschedule an action to a specific time, or move actions between projects by changing the projectId. Set projectId to null to unassign an action from its project. " +
    "To MOVE AN ACTION TO A NEW TIME — \"move this to tomorrow morning\", \"do this at 9am\", \"push it to Friday\" — set scheduledStart, not dueDate. scheduledStart is the \"do date\" and it is what /today partitions on; it takes precedence over dueDate, so changing dueDate alone will NOT move an action out of the overdue group. To clear a schedule entirely, set scheduledStart to null (or use defer-actions for several at once).",
  inputSchema: z.object({
    actionId: z.string().describe("The ID of the action to update"),
    name: z.string().min(1).optional().describe("New name for the action"),
    description: z.string().nullable().optional().describe("New description (set null to clear)"),
    projectId: z.string().nullable().optional().describe("Move the action to this project ID, or null to unassign from any project"),
    priority: looseEnum([
        "Quick", "Scheduled",
        "1st Priority", "2nd Priority", "3rd Priority", "4th Priority", "5th Priority",
        "Errand", "Remember", "Watch", "Someday Maybe",
      ])
      .optional()
      .describe("New priority level"),
    status: looseEnum(["ACTIVE", "COMPLETED", "CANCELLED"])
      .optional()
      .describe("New status"),
    dueDate: z.string().nullable().optional().describe("New deadline in ISO format, or null to clear"),
    scheduledStart: z.string().nullable().optional().describe("The do-date: when the user plans to work on this, in ISO format (e.g. 2026-08-05T09:00:00Z). This is what /today partitions on and it wins over dueDate. Null to clear."),
    scheduledEnd: z.string().nullable().optional().describe("End of the time block in ISO format, or null to clear"),
    duration: looseNumber(z.number().int().positive()).nullable().optional().describe("Length of the time block in minutes"),
  }),
  outputSchema: z.object({
    action: z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      status: z.string(),
      priority: z.string(),
      dueDate: z.string().nullish(),
      scheduledStart: z.string().nullish(),
      scheduledEnd: z.string().nullish(),
      duration: z.number().nullish(),
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

// Shape of a single action row returned by action.getTodaysActions. Dates
// arrive as ISO strings over the wire (JSON), hence string|null.
const todaysActionRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  scheduledStart: z.string().nullable(),
  dueDate: z.string().nullable(),
  projectName: z.string().nullable(),
  workspaceName: z.string().nullable(),
});

const todaysActionGroupSchema = z.object({
  count: z.number(),
  actions: z.array(todaysActionRowSchema),
});

export const getTodaysActionsTool = createTool({
  id: "get-todays-actions",
  description:
    "List the user's Today's actions — the tasks scheduled or due today, plus overdue ones and loose inbox items, across ALL of the user's workspaces (the exact set the /today page shows). " +
    "This is your FIRST tool — before get-all-projects or get-project-actions — whenever the user asks you to ACT ON or COMPLETE tasks they refer to without giving ids: \"mark the Malte ones done\", \"finish those\", \"these are done\", \"close out the X tasks\", \"mark them done\", or just \"today's actions\" / \"what's on my plate\" / \"what should I do today\". A name fragment like \"Malte\" is text to match against the action names this returns — NOT necessarily a project. " +
    "Prefer it over a project-by-project search: a referenced task may be loose (no project) or live in a different workspace, so get-all-projects / get-project-actions can miss it, whereas get-todays-actions spans every workspace and returns the ids you need. " +
    "It returns three groups (overdue / today / inbox); each action carries its id, name, status, scheduledStart, dueDate, projectName and workspaceName. The ids are authoritative and span workspaces: to complete or change an action, pass its id to update-action (e.g. set status to \"COMPLETED\"). " +
    "NEVER ask the user which project or workspace a task is in, and NEVER tell them to check their own list — call this tool to find the matching actions yourself, then act by id. " +
    "Optionally pass workspaceId to scope to a single workspace; omit it to see everything (the default, matching /today).",
  inputSchema: z.object({
    workspaceId: z
      .string()
      .optional()
      .describe(
        "Optional workspace id to scope the results to one workspace. Omit to list Today's actions across ALL of the user's workspaces (the default — /today is not workspace-scoped).",
      ),
  }),
  outputSchema: z.object({
    overdue: todaysActionGroupSchema,
    today: todaysActionGroupSchema,
    inbox: todaysActionGroupSchema,
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(
      `📅 [getTodaysActions] Fetching Today's actions (workspaceId=${inputData.workspaceId ?? "all"})`,
    );

    try {
      const { data } = await authenticatedTrpcCall(
        "action.getTodaysActions",
        inputData,
        { authToken, sessionId, userId },
      );

      const d = data as {
        overdue?: { count?: number };
        today?: { count?: number };
        inbox?: { count?: number };
      };
      console.log(
        `✅ [getTodaysActions] overdue=${d?.overdue?.count ?? 0} today=${d?.today?.count ?? 0} inbox=${d?.inbox?.count ?? 0}`,
      );
      return data;
    } catch (error) {
      console.error(`❌ [getTodaysActions] FAILED:`, error);
      throw error;
    }
  },
});

const overdueTriageRowSchema = z.object({
  id: z.string(),
  name: z.string(),
  priority: z.string().nullish(),
  scheduledStart: z.string().nullish(),
  dueDate: z.string().nullish(),
  projectName: z.string().nullish(),
  daysOverdue: z.number(),
});

export const getOverdueTriageTool = createTool({
  id: "get-overdue-triage",
  description:
    "Explain WHY the user's overdue pile is the size it is, before you propose what to do about it. Call this whenever get-todays-actions comes back with a lot of overdue actions, or the user says they are overwhelmed / behind / drowning / buried, or asks you to help them clean up or catch up. " +
    "It splits overdue actions into two kinds. COHORTS are groups that share one exact timestamp — the fingerprint of a single bulk write, like a generated project plan or an import that stamped every row with the same date. Those were never individually due, so the honest disposition is amnesty: call defer-actions on the cohort's actionIds. Rescheduling a cohort is the WRONG move; it just re-inflicts the same pile tomorrow. LOOSE actions were dated one at a time and are real missed commitments — surface those individually and let the user decide. " +
    "Lead with the reframe, not the raw number: say \"17 of these were created in one batch on 25 July and were never really due — want them back in their project backlogs?\" rather than \"you have 43 overdue actions\". Each cohort carries stampedAt, count, daysOverdue, projectNames and actionIds; loose actions carry daysOverdue. " +
    "Optionally pass workspaceId to scope to one workspace; omit it to span all (the default).",
  inputSchema: z.object({
    workspaceId: z
      .string()
      .optional()
      .describe(
        "Optional workspace id to scope to one workspace. Omit to span ALL of the user's workspaces (the default, matching /today).",
      ),
  }),
  outputSchema: z.object({
    totalOverdue: z.number(),
    cohortCount: z.number().describe("How many of totalOverdue sit inside a cohort"),
    cohorts: z.array(
      z.object({
        stampedAt: z.string(),
        daysOverdue: z.number(),
        count: z.number(),
        projectNames: z.array(z.string()),
        actionIds: z.array(z.string()),
        actions: z.array(overdueTriageRowSchema),
      }),
    ),
    loose: z.array(overdueTriageRowSchema),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(
      `🔍 [getOverdueTriage] Triaging overdue (workspaceId=${inputData.workspaceId ?? "all"})`,
    );

    try {
      const { data } = await authenticatedTrpcCall(
        "action.getOverdueTriage",
        inputData,
        { authToken, sessionId, userId },
      );

      const d = data as { totalOverdue?: number; cohortCount?: number; cohorts?: unknown[] };
      console.log(
        `✅ [getOverdueTriage] total=${d?.totalOverdue ?? 0} inCohorts=${d?.cohortCount ?? 0} cohorts=${d?.cohorts?.length ?? 0}`,
      );
      return data;
    } catch (error) {
      console.error(`❌ [getOverdueTriage] FAILED:`, error);
      throw error;
    }
  },
});

export const deferActionsTool = createTool({
  id: "defer-actions",
  description:
    "Amnesty: clear the dates on a set of actions so they fall back to their project backlog untimed, and stop counting as overdue. " +
    "This is the right tool for a COHORT from get-overdue-triage — work that was bulk-created with a blanket date and was never individually due. Prefer it over reschedule-actions whenever the dates were not a real commitment, because rescheduling only moves the pile to tomorrow. " +
    "The actions stay ACTIVE: nothing is deleted, archived, or cancelled, and their kanban status is untouched. They simply lose their dates. Always tell the user how many you deferred and that the work is still there in the backlog. " +
    "Confirm with the user before deferring actions they did not explicitly point at.",
  inputSchema: z.object({
    actionIds: looseStringArray(z.array(z.string()).min(1).max(200))
      .describe("Ids of the actions to defer — typically a cohort's actionIds from get-overdue-triage"),
  }),
  outputSchema: z.object({
    count: z.number(),
    actionIds: z.array(z.string()),
    message: z.string(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🗓️ [deferActions] Deferring ${inputData.actionIds.length} action(s)`);

    try {
      const { data } = await authenticatedTrpcCall(
        "action.bulkDefer",
        inputData,
        { authToken, sessionId, userId },
      );
      console.log(`✅ [deferActions] SUCCESS:`, JSON.stringify(data));
      return data;
    } catch (error) {
      console.error(`❌ [deferActions] FAILED:`, error);
      throw error;
    }
  },
});

export const rescheduleActionsTool = createTool({
  id: "reschedule-actions",
  description:
    "Move several actions to a new do-date at once — for work that genuinely is still due, just later. Sets scheduledStart on every action, and pushes dueDate forward only where it would otherwise fall before the new date. " +
    "Use this when the user says \"move all of these to tomorrow\", \"push this week's tasks to Monday\", or accepts a plan you proposed. For a SINGLE action prefer update-action; for a bulk-created cohort from get-overdue-triage prefer defer-actions, because rescheduling a cohort re-inflicts the same pile tomorrow rather than resolving it.",
  inputSchema: z.object({
    actionIds: looseStringArray(z.array(z.string()).min(1)).describe("Ids of the actions to reschedule"),
    date: z
      .string()
      .describe("The new do-date in ISO format, e.g. 2026-08-05T09:00:00Z"),
  }),
  outputSchema: z.object({
    count: z.number(),
    actionIds: z.array(z.string()),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    const when = new Date(inputData.date);
    if (isNaN(when.getTime())) {
      throw new Error(`Invalid date "${inputData.date}". Use an ISO datetime.`);
    }

    console.log(
      `🗓️ [rescheduleActions] Moving ${inputData.actionIds.length} action(s) to ${when.toISOString()}`,
    );

    try {
      const { data } = await authenticatedTrpcCall(
        "action.bulkReschedule",
        { actionIds: inputData.actionIds, dueDate: when.toISOString() },
        { authToken, sessionId, userId },
      );
      console.log(`✅ [rescheduleActions] SUCCESS:`, JSON.stringify(data));
      return data;
    } catch (error) {
      console.error(`❌ [rescheduleActions] FAILED:`, error);
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
    confirmDeletion: looseBoolean().describe("Must be explicitly true to proceed — confirm with the user before setting this"),
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
    parentGoalId: looseNumber().optional().describe("Optional parent objective (goal) ID: nest EVERY created goal under this one unless a goal sets its own parentGoalId. When the user is viewing a goal and asks to build a structure 'under this goal' / as phases of it, pass that goal's ID (from the page context) here."),
    goals: z.array(z.object({
      title: z.string().describe("Goal/objective title"),
      description: z.string().optional().describe("Goal description"),
      parentGoalId: looseNumber().optional().describe("Optional parent objective (goal) ID for THIS goal specifically; overrides the batch-level parentGoalId."),
      projects: z.array(z.object({
        name: z.string().describe("Project name"),
        description: z.string().optional().describe("Project description"),
        priority: looseEnum(["HIGH", "MEDIUM", "LOW", "NONE"]).optional().describe("Project priority (defaults to MEDIUM)"),
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
