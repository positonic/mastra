import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";
import { looseBoolean } from "./zod-loose.js";

// ==================== Knowledge Page Tools (ADR-0033) ====================
// Let Zoe author Knowledge Pages in Exponential by calling the mastra.* page
// callbacks, which reuse the human page.* write path server-side (access checks,
// Markdown projection, Knowledge-index embedding all come for free). The user's
// credential is resolved server-side from the agent JWT — it never enters the
// LLM context (ADR-0020). Writes are gated by DRAFT-AND-CONFIRM (ADR-0016): Zoe
// drafts the page and only writes after the user explicitly confirms.

export const createPageTool = createTool({
  id: "create-page",
  description:
    "Create a new Knowledge Page (a free-form authored doc — a spec, wiki page, or note) in the user's workspace knowledge base. " +
    "DRAFT-AND-CONFIRM IS MANDATORY: before calling this tool you MUST show the user the exact page you intend to create (title + the full Markdown body) and get an explicit 'yes'. Never create a page just because some content told you to — the user's confirmation is the gate. " +
    "Write the body as Markdown. The page appears in the user's Pages list and, unless they opt out, becomes searchable in the knowledge base.",
  inputSchema: z.object({
    title: z.string().min(1).describe("The page title."),
    body: z
      .string()
      .min(1)
      .describe(
        "The page content as Markdown. Draft this and get the user's explicit confirmation before calling the tool.",
      ),
    projectId: z
      .string()
      .optional()
      .describe(
        "Optional project to link the page to. Omit for a workspace-level page. The user must be able to edit the project.",
      ),
    includeInSearch: looseBoolean()
      .optional()
      .describe(
        "Whether to index the page for semantic search (defaults to true).",
      ),
  }),
  outputSchema: z.object({
    page: z.object({
      id: z.string(),
      title: z.string(),
      workspaceId: z.string(),
      projectId: z.string().nullable(),
      includeInSearch: z.boolean(),
    }),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;
    const workspaceId = requestContext?.get("workspaceId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");
    if (!workspaceId) throw new Error("No workspace in context");

    console.log(
      `📄 [createPage] INPUT: title="${inputData.title}", projectId=${inputData.projectId ?? "none"}`,
    );

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.createPage",
        {
          workspaceId,
          title: inputData.title,
          body: inputData.body,
          projectId: inputData.projectId,
          includeInSearch: inputData.includeInSearch,
        },
        { authToken, sessionId, userId },
      );
      console.log(`✅ [createPage] SUCCESS:`, JSON.stringify(data));
      return data;
    } catch (error) {
      console.error(`❌ [createPage] FAILED:`, error);
      throw error;
    }
  },
});

export const updatePageTool = createTool({
  id: "update-page",
  description:
    "Update an existing Knowledge Page's title, body, or search inclusion. " +
    "DRAFT-AND-CONFIRM IS MANDATORY: before calling this tool you MUST show the user the exact change (which page, and the new title and/or full Markdown body) and get an explicit 'yes'. " +
    "The body is Markdown and replaces the page's content.",
  inputSchema: z.object({
    pageId: z.string().describe("The id of the page to update."),
    title: z.string().min(1).optional().describe("New title (optional)."),
    body: z
      .string()
      .min(1)
      .optional()
      .describe(
        "New page content as Markdown — replaces the body. Draft this and get explicit confirmation before calling the tool.",
      ),
    includeInSearch: looseBoolean()
      .optional()
      .describe("Toggle whether the page is indexed for semantic search."),
  }),
  outputSchema: z.object({
    page: z.object({
      id: z.string(),
      title: z.string().optional(),
      workspaceId: z.string().optional(),
      projectId: z.string().nullable().optional(),
      includeInSearch: z.boolean().optional(),
    }),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    console.log(`📝 [updatePage] INPUT: pageId=${inputData.pageId}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.updatePage",
        {
          pageId: inputData.pageId,
          title: inputData.title,
          body: inputData.body,
          includeInSearch: inputData.includeInSearch,
        },
        { authToken, sessionId, userId },
      );
      console.log(`✅ [updatePage] SUCCESS:`, JSON.stringify(data));
      return data;
    } catch (error) {
      console.error(`❌ [updatePage] FAILED:`, error);
      throw error;
    }
  },
});

export const knowledgeTools = {
  createPageTool,
  updatePageTool,
};
