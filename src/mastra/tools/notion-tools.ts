/**
 * Notion Tools for Mastra Agents
 * Uses the official @notionhq/client SDK with pagination, retry, and expanded property support.
 */

import { Client, LogLevel, isNotionClientError, ClientErrorCode, APIErrorCode } from "@notionhq/client";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { prepareUntrustedContent } from "../utils/content-safety.js";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";

// ---------------------------------------------------------------------------
// Client — the SDK handles retries (3 attempts with backoff) and rate-limit
// 429 responses internally, so we don't need to re-implement that.
//
// Per-user OAuth tokens get a fresh client each call (cheap — no connection pool).
// The env-var fallback client is cached for the process lifetime.
// ---------------------------------------------------------------------------

/** Resolve the Notion client from the user's OAuth token in requestContext. */
function getClientFromRuntime(requestContext?: any): Client {
  const token = requestContext?.get?.("notionAccessToken") as string | undefined;
  if (!token) {
    throw new Error(
      "Notion is not connected. Connect your Notion account in Settings → Integrations."
    );
  }
  return new Client({ auth: token, logLevel: LogLevel.WARN });
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Extract a human-readable value from any Notion property object. */
function extractPropertyValue(prop: any): unknown {
  switch (prop.type) {
    case "title":
      return prop.title?.map((t: any) => t.plain_text).join("") || null;
    case "rich_text":
      return prop.rich_text?.map((t: any) => t.plain_text).join("") || null;
    case "select":
      return prop.select?.name ?? null;
    case "multi_select":
      return prop.multi_select?.map((s: any) => s.name) ?? [];
    case "status":
      return prop.status?.name ?? null;
    case "date":
      if (!prop.date) return null;
      return prop.date.end
        ? { start: prop.date.start, end: prop.date.end }
        : prop.date.start;
    case "number":
      return prop.number;
    case "checkbox":
      return prop.checkbox;
    case "people":
      return prop.people?.map((p: any) => p.name ?? p.id) ?? [];
    case "url":
      return prop.url;
    case "email":
      return prop.email;
    case "phone_number":
      return prop.phone_number;
    case "formula":
      return prop.formula?.[prop.formula?.type] ?? null;
    case "rollup":
      if (prop.rollup?.type === "array") {
        return prop.rollup.array?.map((item: any) => extractPropertyValue(item));
      }
      return prop.rollup?.[prop.rollup?.type] ?? null;
    case "relation":
      return prop.relation?.map((r: any) => r.id) ?? [];
    case "files":
      return prop.files?.map((f: any) => f.file?.url ?? f.external?.url ?? f.name) ?? [];
    case "created_time":
      return prop.created_time;
    case "last_edited_time":
      return prop.last_edited_time;
    case "created_by":
      return prop.created_by?.name ?? prop.created_by?.id ?? null;
    case "last_edited_by":
      return prop.last_edited_by?.name ?? prop.last_edited_by?.id ?? null;
    case "unique_id":
      return prop.unique_id ? `${prop.unique_id.prefix ?? ""}${prop.unique_id.number}` : null;
    case "verification":
      return prop.verification?.state ?? null;
    default:
      return prop[prop.type] ?? null;
  }
}

/** Extract readable properties from a page. */
function extractProperties(properties: Record<string, any>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(properties)) {
    out[key] = extractPropertyValue(value);
  }
  return out;
}

/** Get the title from a page's properties. */
function extractPageTitle(properties: Record<string, any>): string {
  for (const value of Object.values(properties)) {
    if ((value as any).type === "title") {
      return (value as any).title?.map((t: any) => t.plain_text).join("") || "Untitled";
    }
  }
  return "Untitled";
}

/** Collect all blocks for a page, auto-paginating. */
async function getAllBlocks(client: Client, blockId: string): Promise<any[]> {
  const blocks: any[] = [];
  let cursor: string | undefined;

  do {
    const response = await client.blocks.children.list({
      block_id: blockId,
      start_cursor: cursor,
      page_size: 100,
    });
    blocks.push(...response.results);
    cursor = response.has_more ? (response.next_cursor ?? undefined) : undefined;
  } while (cursor);

  return blocks;
}

/** Extract readable text from a block. */
function extractBlockText(block: any): string | null {
  const richText = block[block.type]?.rich_text;
  if (richText?.length) {
    return richText.map((t: any) => t.plain_text).join("");
  }
  // Handle special block types
  if (block.type === "code") {
    const code = block.code?.rich_text?.map((t: any) => t.plain_text).join("");
    return code ? `\`\`\`${block.code?.language ?? ""}\n${code}\n\`\`\`` : null;
  }
  if (block.type === "equation") {
    return block.equation?.expression ?? null;
  }
  if (block.type === "divider") {
    return "---";
  }
  return null;
}

/** Format a Notion error into a concise message for the agent. */
function formatError(err: unknown): string {
  if (isNotionClientError(err)) {
    if (err.code === ClientErrorCode.RequestTimeout) {
      return "Notion request timed out. Try again in a moment.";
    }
    if (err.code === APIErrorCode.RateLimited) {
      return "Notion rate limit reached. The SDK retried automatically but still failed. Try again shortly.";
    }
    if (err.code === APIErrorCode.ObjectNotFound) {
      return "Not found — check the ID and make sure the integration has access to this page/database.";
    }
    if (err.code === APIErrorCode.Unauthorized) {
      return "Unauthorized — check NOTION_API_KEY and that the integration is connected to the relevant pages.";
    }
    return `Notion API error (${err.code}): ${err.message}`;
  }
  return err instanceof Error ? err.message : String(err);
}

// ---------------------------------------------------------------------------
// Tools
// ---------------------------------------------------------------------------

export const notionSearchTool = createTool({
  id: "notion-search",
  description:
    "Search the user's Notion for pages and databases by title or content. The Notion credential is resolved server-side from the user's connected integration — you never see it. Returns a lean list of {id, type, title, url}. " +
    "If the result is `{connected:false}`, the user has not connected Notion — tell them to connect it in Settings → Integrations. " +
    "If `{connected:true, total:0}` (no matches), the most likely cause is that a Notion internal integration only sees pages explicitly SHARED with it — tell the user to open the page/database in Notion, click '•••' → 'Connections' (or 'Add connections') and share it with the integration, then try again. " +
    "Use the returned page/database `id` with notion-get-page or notion-query-database.",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    filter: z.enum(["page", "database"]).optional().describe("Filter by object type"),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const workspaceId = requestContext?.get("workspaceId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.notionSearch",
        {
          query: inputData.query,
          filter: inputData.filter,
          workspaceId: workspaceId || undefined,
        },
        { authToken, sessionId, userId },
      );
      return data;
    } catch (err) {
      return { error: formatError(err) };
    }
  },
});

/** Recursively wrap property values with prepareUntrustedContent */
function wrapPropertyValue(value: unknown, context: string): unknown {
  if (typeof value === 'string') {
    return prepareUntrustedContent(value, context);
  }
  if (Array.isArray(value)) {
    return value.map(item => wrapPropertyValue(item, context));
  }
  if (value && typeof value === 'object') {
    const wrapped: Record<string, unknown> = {};
    for (const [key, val] of Object.entries(value)) {
      wrapped[key] = wrapPropertyValue(val, context);
    }
    return wrapped;
  }
  return value;
}

export const notionGetPageTool = createTool({
  id: "notion-get-page",
  description:
    "Read a specific Notion page's title and text content by ID (often an id from notion-search or notion-query-database). The Notion credential is resolved server-side — you never see it. " +
    "Returns `{connected, id, title, url, text, truncated}`. The page text may be **truncated** (~3k chars): when `truncated:true`, tell the user you only read the start and ask if they want a specific section, rather than assuming you have the whole page. " +
    "If `{connected:false}`, the user hasn't connected Notion — tell them to connect it in Settings → Integrations. " +
    "If the page isn't found, the internal integration may not have been SHARED with that page — tell the user to share it with the integration in Notion.",
  inputSchema: z.object({
    pageId: z.string().describe("Notion page ID (UUID or 32-char hex)"),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const workspaceId = requestContext?.get("workspaceId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.notionGetPage",
        { pageId: inputData.pageId, workspaceId: workspaceId || undefined },
        { authToken, sessionId, userId },
      );

      // Wrap the page title + text — Notion page content is untrusted external
      // content (content-injection posture, ADR-0020).
      if (data && (data as any).connected) {
        const d = data as any;
        if (typeof d.title === "string") {
          d.title = prepareUntrustedContent(d.title, "notion_page");
        }
        if (typeof d.text === "string") {
          d.text = prepareUntrustedContent(d.text, "notion_page");
        }
      }

      return data;
    } catch (err) {
      return { error: formatError(err) };
    }
  },
});

export const notionQueryDatabaseTool = createTool({
  id: "notion-query-database",
  description:
    "Query one of the user's Notion databases with optional filters and sorts. The Notion credential is resolved server-side — you never see it. " +
    "Returns at most 25 rows (each {id, title, url, props}, scalar properties only — no long text blobs) plus `hasMore`/`nextCursor`. " +
    "If `hasMore` is true there are more rows: either tighten the filter/sort, or page by calling again with `startCursor` set to the returned `nextCursor`. Don't try to slurp the whole database. " +
    "If `{connected:false}`, the user hasn't connected Notion — tell them to connect it in Settings → Integrations. " +
    "If `{connected:true, total:0}` (no rows), the most likely cause is that a Notion internal integration only sees databases explicitly SHARED with it — tell the user to share the database with the integration in Notion (open it → '•••' → 'Connections'), then retry.",
  inputSchema: z.object({
    databaseId: z.string().describe("Notion database ID (UUID), e.g. from notion-search"),
    filter: z.any().optional().describe("Notion filter object — see https://developers.notion.com/reference/post-database-query-filter"),
    sorts: z
      .array(
        z.object({
          property: z.string(),
          direction: z.enum(["ascending", "descending"]),
        })
      )
      .optional()
      .describe("Sort criteria"),
    startCursor: z
      .string()
      .optional()
      .describe("Pagination cursor — pass the `nextCursor` from a previous call to fetch the next page of up to 25 rows"),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const workspaceId = requestContext?.get("workspaceId") as string | undefined;

    if (!authToken) throw new Error("No authentication token available");

    try {
      const { data } = await authenticatedTrpcCall(
        "mastra.notionQueryDatabase",
        {
          databaseId: inputData.databaseId,
          filter: inputData.filter,
          sorts: inputData.sorts,
          startCursor: inputData.startCursor,
          workspaceId: workspaceId || undefined,
        },
        { authToken, sessionId, userId },
      );

      // Wrap the returned row content — Notion database content is untrusted
      // external content (content-injection posture, ADR-0020).
      if (data && (data as any).connected && Array.isArray((data as any).rows)) {
        (data as any).rows = (data as any).rows.map((row: any) => ({
          ...row,
          title: typeof row.title === "string"
            ? prepareUntrustedContent(row.title, "notion_database")
            : row.title,
          props: wrapPropertyValue(row.props, "notion_database"),
        }));
      }

      return data;
    } catch (err) {
      return { error: formatError(err) };
    }
  },
});

export const notionCreatePageTool = createTool({
  id: "notion-create-page",
  description: "Create a new page in a Notion database",
  inputSchema: z.object({
    databaseId: z.string().describe("Parent database ID"),
    title: z.string().describe("Page title"),
    properties: z.record(z.any()).optional().describe("Additional Notion properties to set"),
  }),
  execute: async (inputData, { requestContext }) => {
    try {
      const client = getClientFromRuntime(requestContext);
      const { databaseId, title, properties = {} } = inputData;

      // Look up the database schema to find the title property name
      const db = await client.databases.retrieve({ database_id: databaseId });
      const dbProps = (db as any).properties as Record<string, any>;
      const titlePropName =
        Object.entries(dbProps).find(([_, v]) => v.type === "title")?.[0] ?? "Name";

      const page = await client.pages.create({
        parent: { database_id: databaseId },
        properties: {
          [titlePropName]: { title: [{ text: { content: title } }] },
          ...properties,
        } as any,
      });

      const p = page as any;

      return {
        id: p.id,
        url: p.url,
        message: `Created page: ${title}`,
      };
    } catch (err) {
      return { error: formatError(err) };
    }
  },
});

export const notionUpdatePageTool = createTool({
  id: "notion-update-page",
  description: "Update properties of an existing Notion page",
  inputSchema: z.object({
    pageId: z.string().describe("Page ID to update"),
    properties: z.record(z.any()).describe("Properties to update (Notion property format)"),
  }),
  execute: async (inputData, { requestContext }) => {
    try {
      const client = getClientFromRuntime(requestContext);
      const { pageId, properties } = inputData;

      const page = await client.pages.update({
        page_id: pageId,
        properties: properties as any,
      });

      const p = page as any;

      return {
        id: p.id,
        url: p.url,
        message: "Page updated successfully",
      };
    } catch (err) {
      return { error: formatError(err) };
    }
  },
});

// Export all tools as a bundle
export const notionTools = {
  notionSearchTool,
  notionGetPageTool,
  notionQueryDatabaseTool,
  notionCreatePageTool,
  notionUpdatePageTool,
};
