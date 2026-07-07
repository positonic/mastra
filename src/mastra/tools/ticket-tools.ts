import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";
import { looseBoolean, looseEnum, looseNumber, looseStringArray } from "./zod-loose.js";

// ==================== Product Pipeline Ticket Tools ====================
// Tools for listing products and filing tickets into a product's pipeline
// (the board shown at /w/<workspace>/products/<product>/tickets).
// Calls Exponential backend tRPC endpoints (mastra.listProducts / mastra.createTicket).

export const listProductsTool = createTool({
  id: "list-products",
  description:
    "List the products the user can access, with their IDs, names, and workspace. Use this to resolve a product by name into a productId BEFORE creating a ticket — never guess a productId. Confirm the target product with the user if more than one matches.",
  inputSchema: z.object({
    workspaceId: z
      .string()
      .optional()
      .describe("Optional workspace ID to narrow the list to a single workspace"),
  }),
  outputSchema: z.object({
    products: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        workspaceId: z.string(),
        workspaceName: z.string(),
        workspaceSlug: z.string(),
        ticketCount: z.number(),
      }),
    ),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🎫 [listProducts] Fetching products${inputData.workspaceId ? ` for workspace ${inputData.workspaceId}` : ""}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.listProducts",
        { workspaceId: inputData.workspaceId },
        { authToken, sessionId, userId },
      );

      console.log(`✅ [listProducts] Found ${(data as any)?.products?.length ?? 0} products`);
      return data;
    } catch (error) {
      console.error(`❌ [listProducts] FAILED:`, error);
      throw error;
    }
  },
});

export const createTicketTool = createTool({
  id: "create-ticket",
  description:
    "File a ticket into a product's pipeline (the tickets board). Use this when the user asks to create, file, log, or raise a ticket, bug, or feature request for a product. You MUST have a productId first — call list-products to resolve the product by name if you don't have one. Always confirm the title and target product with the user before creating.",
  inputSchema: z.object({
    productId: z
      .string()
      .describe("The ID of the product to file the ticket under — use list-products to resolve it"),
    title: z.string().min(1).max(300).describe("Short, descriptive ticket title"),
    body: z
      .string()
      .optional()
      .describe("Optional longer description / details for the ticket"),
    type: looseEnum(["BUG", "FEATURE", "CHORE", "IMPROVEMENT", "SPIKE", "RESEARCH"])
      .optional()
      .describe("Ticket type (defaults to FEATURE)"),
    status: looseEnum([
        "BACKLOG",
        "NEEDS_REFINEMENT",
        "READY_TO_PLAN",
        "COMMITTED",
        "IN_PROGRESS",
        "BLOCKED",
        "QA",
        "DONE",
        "DEPLOYED",
        "ARCHIVED",
      ])
      .optional()
      .describe("Initial pipeline status (defaults to BACKLOG)"),
    priority: looseNumber(z
      .number()
      .int()
      .min(0)
      .max(4))
      .optional()
      .describe("Priority 0-4 (0 = critical, 4 = backlog)"),
    points: looseNumber(z.number()).optional().describe("Optional estimate in points"),
    assigneeId: z
      .string()
      .optional()
      .describe("Optional user ID to assign the ticket to"),
  }),
  outputSchema: z.object({
    ticket: z.object({
      id: z.string(),
      number: z.number(),
      shortId: z.string().nullable(),
      title: z.string(),
      type: z.string(),
      status: z.string(),
      priority: z.number().nullable(),
      productId: z.string(),
    }),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🎫 [createTicket] INPUT: productId=${inputData.productId}, title="${inputData.title}", type=${inputData.type || "FEATURE"}, status=${inputData.status || "BACKLOG"}`);
    console.log(`🎫 [createTicket] CONTEXT: authToken=${authToken ? "present" : "MISSING"}, userId=${userId || "none"}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.createTicket",
        inputData,
        { authToken, sessionId, userId },
      );

      console.log(`✅ [createTicket] SUCCESS:`, JSON.stringify(data));
      return data;
    } catch (error) {
      console.error(`❌ [createTicket] FAILED:`, error);
      throw error;
    }
  },
});

export const bulkCreateTicketsTool = createTool({
  id: "bulk-create-tickets",
  description:
    "File MULTIPLE tickets into one product's pipeline in a single call — far more reliable than calling create-ticket repeatedly. Use this whenever the user provides a list/table of tickets (e.g. a cycle's worth of work). Resolve the product with list-products first to get the productId. Cycle and owner are resolved server-side BY NAME (pass cycleName / assigneeName as written, e.g. \"Cycle 8\", \"James\") — anything that can't be resolved is reported in the per-ticket warnings, not silently dropped. Returns a manifest of created vs failed tickets so you can report an accurate summary.",
  inputSchema: z.object({
    productId: z
      .string()
      .describe("The ID of the product to file the tickets under — use list-products to resolve it"),
    tickets: z
      .array(
        z.object({
          title: z.string().min(1).max(300).describe("Short, descriptive ticket title"),
          body: z.string().optional().describe("Optional details. Put unmappable columns (e.g. Area) here."),
          type: looseEnum(["BUG", "FEATURE", "CHORE", "IMPROVEMENT", "SPIKE", "RESEARCH"])
            .optional()
            .describe("Ticket type (defaults to FEATURE)"),
          status: looseEnum([
              "BACKLOG",
              "NEEDS_REFINEMENT",
              "READY_TO_PLAN",
              "COMMITTED",
              "IN_PROGRESS",
              "BLOCKED",
              "QA",
              "DONE",
              "DEPLOYED",
              "ARCHIVED",
            ])
            .optional()
            .describe("Pipeline status. Map e.g. 'In progress'→IN_PROGRESS, 'Committed'→COMMITTED (defaults to BACKLOG)"),
          priority: looseNumber(z
            .number()
            .int()
            .min(0)
            .max(4))
            .optional()
            .describe("Priority 0-4. Map High→1, Medium→2, Low→3 (reserve 0 for critical)"),
          points: looseNumber(z
            .number())
            .optional()
            .describe("Estimate in points. Map T-shirt sizes XS/S/M/L/XL → 1/2/3/5/8"),
          cycleName: z
            .string()
            .optional()
            .describe("Cycle/sprint name as written (e.g. 'Cycle 8') — resolved to a cycle server-side"),
          assigneeName: z
            .string()
            .optional()
            .describe("Owner name or email as written (e.g. 'James') — resolved to a workspace member server-side"),
          labels: looseStringArray(z.array(z.string().min(1).max(50)).max(10))
            .optional()
            .describe("Labels for THIS ticket only (merged with the top-level labels)"),
        }),
      )
      .min(1)
      .max(100)
      .describe("The tickets to create"),
    labels: looseStringArray(z.array(z.string().min(1).max(50)).max(10))
      .optional()
      .describe("Labels applied to EVERY created ticket (e.g. 'FROM-NOTION' for imports) — resolved to workspace tags by name, created when missing"),
  }),
  outputSchema: z.object({
    created: z.array(
      z.object({
        id: z.string(),
        number: z.number(),
        shortId: z.string().nullable(),
        title: z.string(),
        status: z.string(),
        type: z.string(),
        warnings: z.array(z.string()),
      }),
    ),
    failed: z.array(z.object({ title: z.string(), error: z.string() })),
    totalCreated: z.number(),
    totalFailed: z.number(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🎫 [bulkCreateTickets] INPUT: productId=${inputData.productId}, count=${inputData.tickets.length}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.bulkCreateTickets",
        inputData,
        { authToken, sessionId, userId },
      );

      const result = data as { totalCreated: number; totalFailed: number };
      console.log(`✅ [bulkCreateTickets] Done: ${result.totalCreated} created, ${result.totalFailed} failed`);
      return data;
    } catch (error) {
      console.error(`❌ [bulkCreateTickets] FAILED:`, error);
      throw error;
    }
  },
});

export const importNotionCycleTicketsTool = createTool({
  id: "import-notion-cycle-tickets",
  description:
    "Import ONE Notion backlog cycle into a product's tickets in a SINGLE call — the whole flow runs server-side: it resolves the Notion cycle page, filters the backlog database on its cycle relation, maps fields (status, '1 - High' priorities, 'L (5pts)' efforts, types), labels every ticket (default FROM-NOTION), assigns the matching Exponential cycle, and SKIPS rows already imported (safe to re-run). ALWAYS prefer this over hand-querying Notion and bulk-creating when the user asks to import/sync a Notion cycle or backlog slice. You need: the productId (via list-products) and the Notion backlog database id (via notion-search for e.g. 'Backlog'). Pass the cycle by name (e.g. 'Cycle 11') — or cyclePageId if the name is ambiguous. Run with dryRun:true FIRST, show the user the preview, and only re-run without dryRun after they confirm (draft-and-confirm). Report skipped/failed/warnings honestly from the returned manifest — never claim more than it reports.",
  inputSchema: z.object({
    productId: z
      .string()
      .describe("The ID of the product to import into — use list-products to resolve it"),
    notionDatabaseId: z
      .string()
      .describe("The Notion backlog database id — use notion-search (filter: database) to find it"),
    cycleName: z
      .string()
      .optional()
      .describe("Cycle title as written in Notion, e.g. 'Cycle 11' — resolved via Notion search server-side"),
    cyclePageId: z
      .string()
      .optional()
      .describe("Notion page id of the cycle (from the cycles database) — use instead of cycleName when ambiguous"),
    relationProperty: z
      .string()
      .optional()
      .describe("Name of the backlog database's relation property pointing at cycles (default 'Cycles')"),
    labels: looseStringArray(z.array(z.string().min(1).max(50)).max(10))
      .optional()
      .describe("Labels applied to every imported ticket (default ['FROM-NOTION'])"),
    targetCycleName: z
      .string()
      .optional()
      .describe("Exponential cycle to assign tickets to, when its name differs from the Notion cycle title"),
    properties: z
      .object({
        status: z.string().optional(),
        priority: z.string().optional(),
        type: z.string().optional(),
        effort: z.string().optional(),
        label: z.string().optional(),
      })
      .optional()
      .describe("Notion property-name overrides when the backlog schema doesn't use Status/Priority/Type/Effort/Label"),
    dryRun: looseBoolean()
      .optional()
      .describe("true = map and preview WITHOUT creating anything. Always do a dry run first and confirm with the user."),
  }),
  outputSchema: z.object({
    connected: z.boolean(),
    error: z.string().optional(),
    candidates: z
      .array(z.object({ id: z.string(), title: z.string(), url: z.string() }))
      .optional(),
    dryRun: z.boolean().optional(),
    cycle: z
      .object({
        notionPageId: z.string(),
        notionTitle: z.string(),
        exponentialCycleId: z.string().nullable(),
      })
      .optional(),
    totalFound: z.number().optional(),
    created: z
      .array(
        z.object({
          id: z.string(),
          number: z.number(),
          shortId: z.string().nullable(),
          title: z.string(),
          status: z.string(),
          warnings: z.array(z.string()),
        }),
      )
      .optional(),
    skipped: z.array(z.object({ title: z.string(), reason: z.string() })).optional(),
    failed: z.array(z.object({ title: z.string(), error: z.string() })).optional(),
    preview: z
      .array(
        z.object({
          title: z.string(),
          status: z.string(),
          type: z.string(),
          priority: z.number().optional(),
          points: z.number().optional(),
          notionUrl: z.string(),
          labels: z.array(z.string()),
          warnings: z.array(z.string()),
        }),
      )
      .optional(),
    warnings: z.array(z.string()).optional(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`📥 [importNotionCycleTickets] INPUT: productId=${inputData.productId}, cycle="${inputData.cycleName ?? inputData.cyclePageId}", dryRun=${inputData.dryRun ?? false}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.importNotionCycleTickets",
        inputData,
        { authToken, sessionId, userId },
      );

      const result = data as { created?: unknown[]; skipped?: unknown[]; failed?: unknown[]; error?: string };
      console.log(`✅ [importNotionCycleTickets] Done: created=${result.created?.length ?? 0}, skipped=${result.skipped?.length ?? 0}, failed=${result.failed?.length ?? 0}${result.error ? `, error=${result.error}` : ""}`);
      return data;
    } catch (error) {
      console.error(`❌ [importNotionCycleTickets] FAILED:`, error);
      throw error;
    }
  },
});

export const listCyclesTool = createTool({
  id: "list-cycles",
  description:
    "List the cycles (sprints) in a workspace, with their status, dates, goal, and ticket count. Use this to see what cycles exist, resolve a cycle the user names, or find the current/upcoming cycle — before listing tickets or analysing a cycle. Pass a productId (from list-products) OR a workspaceId. Read-only; never creates cycles.",
  inputSchema: z.object({
    productId: z
      .string()
      .optional()
      .describe("A product in the target workspace — use list-products to resolve it. Provide this OR workspaceId."),
    workspaceId: z
      .string()
      .optional()
      .describe("The workspace to list cycles for. Provide this OR productId."),
  }),
  outputSchema: z.object({
    cycles: z.array(
      z.object({
        id: z.string(),
        name: z.string(),
        slug: z.string(),
        status: z.string(),
        startDate: z.string().nullable(),
        endDate: z.string().nullable(),
        cycleGoal: z.string().nullable(),
        ticketCount: z.number(),
      }),
    ),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🔄 [listCycles] Fetching cycles for ${inputData.productId ? `product ${inputData.productId}` : `workspace ${inputData.workspaceId}`}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.listCycles",
        { productId: inputData.productId, workspaceId: inputData.workspaceId },
        { authToken, sessionId, userId },
      );

      console.log(`✅ [listCycles] Found ${(data as any)?.cycles?.length ?? 0} cycles`);
      return data;
    } catch (error) {
      console.error(`❌ [listCycles] FAILED:`, error);
      throw error;
    }
  },
});

export const listTicketsTool = createTool({
  id: "list-tickets",
  description:
    "READ a product's tickets — optionally scoped to one cycle, status, or type — WITH their dependency edges (dependsOn / requiredFor) and an isBlocked flag. This is the tool to answer 'what tickets are in cycle 10?', 'could any have dependencies?', 'what's blocked?', or to review/summarise a product's work. NEVER ask the user to paste their tickets — call this instead. You need a productId (use list-products). For a cycle, pass `cycle` as the user says it ('Cycle 10', 'cycle-10', or '10') — the server resolves the name; if it can't, the response lists availableCycles so you can retry. If totalCount exceeds the returned tickets, say the list is truncated rather than reasoning over a partial set.",
  inputSchema: z.object({
    productId: z
      .string()
      .describe("The product whose tickets to list — use list-products to resolve it"),
    cycle: z
      .string()
      .optional()
      .describe("Cycle to scope to, as a human reference: 'Cycle 10', 'cycle-10', '10', or a cycle id. Omit for all cycles."),
    status: looseEnum([
        "BACKLOG",
        "NEEDS_REFINEMENT",
        "READY_TO_PLAN",
        "COMMITTED",
        "IN_PROGRESS",
        "BLOCKED",
        "QA",
        "DONE",
        "DEPLOYED",
        "ARCHIVED",
      ])
      .optional()
      .describe("Only return tickets in this pipeline status"),
    type: looseEnum(["BUG", "FEATURE", "CHORE", "IMPROVEMENT", "SPIKE", "RESEARCH"])
      .optional()
      .describe("Only return tickets of this type"),
    limit: looseNumber(z.number().int().min(1).max(200))
      .optional()
      .describe("Max tickets to return (default 100, max 200)"),
  }),
  outputSchema: z.object({
    cycle: z.object({ id: z.string(), name: z.string() }).nullable(),
    totalCount: z.number(),
    warning: z.string().optional(),
    availableCycles: z.array(z.string()).optional(),
    tickets: z.array(
      z.object({
        number: z.number(),
        shortId: z.string().nullable(),
        title: z.string(),
        body: z.string().nullable(),
        status: z.string(),
        type: z.string(),
        priority: z.number().nullable(),
        points: z.number().nullable(),
        assignee: z.string().nullable(),
        cycle: z.string().nullable(),
        feature: z.string().nullable(),
        epic: z.string().nullable(),
        dependsOn: z.array(
          z.object({ number: z.number(), title: z.string(), status: z.string() }),
        ),
        requiredFor: z.array(
          z.object({ number: z.number(), title: z.string(), status: z.string() }),
        ),
        isBlocked: z.boolean(),
      }),
    ),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🎫 [listTickets] INPUT: productId=${inputData.productId}, cycle="${inputData.cycle ?? "(all)"}", status=${inputData.status ?? "(any)"}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.listTickets",
        inputData,
        { authToken, sessionId, userId },
      );

      const result = data as { tickets?: unknown[]; totalCount?: number; warning?: string };
      console.log(`✅ [listTickets] Returned ${result.tickets?.length ?? 0}/${result.totalCount ?? 0} tickets${result.warning ? ` (warning: ${result.warning})` : ""}`);
      return data;
    } catch (error) {
      console.error(`❌ [listTickets] FAILED:`, error);
      throw error;
    }
  },
});

export const addTicketDependenciesTool = createTool({
  id: "add-ticket-dependencies",
  description:
    "Create dependency links between tickets in ONE product, by ticket number — records that a ticket is blocked by (depends on) another. Use when the user asks to link tickets, mark blockers, or after you've proposed dependencies and they've confirmed. Each edge is {ticketNumber, dependsOnNumber} meaning ticketNumber depends on / is blocked by dependsOnNumber. The server rejects self-links and any edge that would create a cycle, and reports per-edge outcomes — relay added vs failed honestly. ALWAYS propose the edges to the user and get confirmation before calling this; it writes data.",
  inputSchema: z.object({
    productId: z
      .string()
      .describe("The product the tickets belong to — use list-products to resolve it"),
    dependencies: z
      .array(
        z.object({
          ticketNumber: looseNumber(z.number().int().positive())
            .describe("The dependent/blocked ticket's number (the one that depends on the other)"),
          dependsOnNumber: looseNumber(z.number().int().positive())
            .describe("The blocker ticket's number (the prerequisite)"),
        }),
      )
      .min(1)
      .max(50)
      .describe("The dependency edges to create"),
  }),
  outputSchema: z.object({
    added: z.array(z.object({ ticket: z.number(), dependsOn: z.number() })),
    failed: z.array(
      z.object({ ticket: z.number(), dependsOn: z.number(), error: z.string() }),
    ),
    totalAdded: z.number(),
    totalFailed: z.number(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`🔗 [addTicketDependencies] INPUT: productId=${inputData.productId}, edges=${inputData.dependencies.length}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.addTicketDependencies",
        inputData,
        { authToken, sessionId, userId },
      );

      const result = data as { totalAdded?: number; totalFailed?: number };
      console.log(`✅ [addTicketDependencies] Done: added=${result.totalAdded ?? 0}, failed=${result.totalFailed ?? 0}`);
      return data;
    } catch (error) {
      console.error(`❌ [addTicketDependencies] FAILED:`, error);
      throw error;
    }
  },
});
