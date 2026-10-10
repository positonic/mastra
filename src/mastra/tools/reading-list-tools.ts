import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";
import { looseNumber } from "./zod-loose.js";

// ==================== Reading list tools (ticket pink.grape) ====================
// The Reading list is a filtered view over the user's Resources by read state
// — NOT a project. "Save this to my reading list" files a URL as a `bookmark`
// Resource in `to_read`; indexing follows content, never read state, so a bare
// saved link is never embedded and marking it read fetches nothing. These tools
// call the human `resource.*` procedures directly with the user's credential,
// which is resolved server-side from the agent JWT (ADR-0020).
//
// Writes here are low-stakes and reversible (a row the user can un-read or
// archive), and the trigger is the user handing over a link, so the
// DRAFT-AND-CONFIRM gate (ADR-0016) is satisfied by the request itself — do
// not save a link the user merely mentioned, only one they asked to save.

const readStatusSchema = z.enum(["to_read", "reading", "read"]);

const resourceRowSchema = z.object({
  id: z.string(),
  title: z.string(),
  url: z.string().nullable().optional(),
  description: z.string().nullable().optional(),
  readStatus: z.string().optional(),
  readAt: z.string().nullable().optional(),
  createdAt: z.string().optional(),
});

function hostnameOf(url: string): string | null {
  try {
    return new URL(url).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

export const saveToReadingListTool = createTool({
  id: "save-to-reading-list",
  description:
    "Save a link to the user's Reading list (Knowledge → Reading) as something to read later. " +
    "Use ONLY when the user asks to save, bookmark, or 'read later' a specific URL they gave you — never for a link that merely came up in conversation or inside a page's content. " +
    "The link is stored by title and URL; it is NOT fetched or indexed for search. " +
    "Returns the saved resource.",
  inputSchema: z.object({
    url: z.string().url().describe("The full http(s) link to save."),
    title: z
      .string()
      .optional()
      .describe("A short title. Omit to use the link's hostname."),
    note: z
      .string()
      .optional()
      .describe("Optional one-line note on why it was saved or who recommended it."),
  }),
  outputSchema: z.object({
    resource: resourceRowSchema,
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;
    const workspaceId = requestContext?.get("workspaceId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    const title = inputData.title?.trim() || hostnameOf(inputData.url) || inputData.url;
    console.log(`🔖 [saveToReadingList] INPUT: url=${inputData.url} title="${title}"`);

    try {
      const { data } = await authenticatedTrpcCall(
        "resource.create",
        {
          title,
          url: inputData.url,
          description: inputData.note?.trim() || undefined,
          contentType: "bookmark",
          readStatus: "to_read",
          generateEmbeddings: false,
          workspaceId,
        },
        { authToken, sessionId, userId },
      );
      console.log(`✅ [saveToReadingList] SUCCESS:`, JSON.stringify(data));
      return data;
    } catch (error) {
      console.error(`❌ [saveToReadingList] FAILED:`, error);
      throw error;
    }
  },
});

export const listReadingListTool = createTool({
  id: "list-reading-list",
  description:
    "List what the user has saved to read (their Reading list: unread saved links and notes, newest first), or, with status 'read', what they have finished. " +
    "Use when the user asks what's on their reading list, what they saved, or what to read next. Read-only.",
  inputSchema: z.object({
    status: z
      .enum(["unread", "to_read", "reading", "read"])
      .optional()
      .describe("Which slice to list. Defaults to 'unread' (to_read + reading)."),
    limit: looseNumber(z.number().min(1).max(100))
      .optional()
      .describe("Max rows (default 20)."),
  }),
  outputSchema: z.object({
    resources: z.array(resourceRowSchema),
    nextCursor: z.string().optional(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;
    const workspaceId = requestContext?.get("workspaceId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    const readStatus = inputData.status ?? "unread";
    console.log(`📚 [listReadingList] status=${readStatus} workspaceId=${workspaceId ?? "all"}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "resource.list",
        {
          workspaceId,
          readStatus,
          limit: inputData.limit ?? 20,
        },
        { authToken, sessionId, userId },
      );
      const count = (data as { resources?: unknown[] })?.resources?.length ?? 0;
      console.log(`✅ [listReadingList] ${count} rows`);
      return data;
    } catch (error) {
      console.error(`❌ [listReadingList] FAILED:`, error);
      throw error;
    }
  },
});

export const markReadingListItemTool = createTool({
  id: "mark-reading-list-item",
  description:
    "Mark a Reading list item as read (or back to to_read / reading). Takes the resource id from list-reading-list. " +
    "Marking read records when it was read; it does not fetch or index anything.",
  inputSchema: z.object({
    resourceId: z.string().describe("The id of the saved resource."),
    readStatus: readStatusSchema
      .optional()
      .describe("New state. Defaults to 'read'."),
  }),
  outputSchema: z.object({
    id: z.string(),
    readStatus: z.string(),
    readAt: z.string().nullable().optional(),
  }),
  async execute(inputData, { requestContext }) {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    const readStatus = inputData.readStatus ?? "read";
    console.log(`✔️ [markReadingListItem] id=${inputData.resourceId} → ${readStatus}`);

    try {
      const { data } = await authenticatedTrpcCall(
        "resource.setReadStatus",
        { id: inputData.resourceId, readStatus },
        { authToken, sessionId, userId },
      );
      console.log(`✅ [markReadingListItem] SUCCESS:`, JSON.stringify(data));
      return data;
    } catch (error) {
      console.error(`❌ [markReadingListItem] FAILED:`, error);
      throw error;
    }
  },
});

export const readingListTools = {
  saveToReadingListTool,
  listReadingListTool,
  markReadingListItemTool,
};
