import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";

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
    priority: z
      .number()
      .int()
      .min(0)
      .max(4)
      .optional()
      .describe("Priority 0-4 (0 = critical, 4 = backlog)"),
    points: z.number().optional().describe("Optional estimate in points"),
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
