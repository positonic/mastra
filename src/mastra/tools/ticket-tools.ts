import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";
import { looseNumber } from "./zod-loose.js";

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
    type: z
      .enum(["BUG", "FEATURE", "CHORE", "IMPROVEMENT", "SPIKE", "RESEARCH"])
      .optional()
      .describe("Ticket type (defaults to FEATURE)"),
    status: z
      .enum([
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
          type: z
            .enum(["BUG", "FEATURE", "CHORE", "IMPROVEMENT", "SPIKE", "RESEARCH"])
            .optional()
            .describe("Ticket type (defaults to FEATURE)"),
          status: z
            .enum([
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
        }),
      )
      .min(1)
      .max(100)
      .describe("The tickets to create"),
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
