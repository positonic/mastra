/**
 * Notion Tools for Mastra Agents
 * Uses the official @notionhq/client SDK with pagination, retry, and expanded property support.
 */

import { Client, LogLevel, isNotionClientError, ClientErrorCode, APIErrorCode } from "@notionhq/client";
import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { prepareUntrustedContent } from "../utils/content-safety.js";

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
  description: "Search for pages and databases in Notion by title or content",
  inputSchema: z.object({
    query: z.string().describe("Search query"),
    filter: z.enum(["page", "database"]).optional().describe("Filter by object type"),
  }),
  execute: async (inputData, { requestContext }) => {
    try {
      const client = getClientFromRuntime(requestContext);
      const { query, filter } = inputData;

      // SDK v5 renamed "database" → "data_source" in the filter type
      const body: Parameters<typeof client.search>[0] = { query };
      if (filter) {
        body.filter = {
          value: filter === "database" ? "data_source" : "page",
          property: "object",
        };
      }

      const response = await client.search(body);

      return {
        results: response.results.map((r: any) => ({
          id: r.id,
          type: r.object,
          title:
            r.object === "page"
              ? extractPageTitle(r.properties ?? {})
              : r.title?.[0]?.plain_text ?? "Untitled",
          url: r.url,
        })),
        total: response.results.length,
        hasMore: response.has_more,
      };
    } catch (err) {
      return { error: formatError(err) };
    }
  },
});

export const notionGetPageTool = createTool({
  id: "notion-get-page",
  description:
    "Get a Notion page by ID, including its properties and full block content (auto-paginates)",
  inputSchema: z.object({
    pageId: z.string().describe("Notion page ID (UUID or 32-char hex)"),
  }),
  execute: async (inputData, { requestContext }) => {
    try {
      const client = getClientFromRuntime(requestContext);
      const { pageId } = inputData;

      const [page, blocks] = await Promise.all([
        client.pages.retrieve({ page_id: pageId }),
        getAllBlocks(client, pageId),
      ]);

      const p = page as any;

      // Wrap Notion content — pages are untrusted external content
      const wrappedContent = blocks
        .map((b: any) => ({
          type: b.type,
          text: extractBlockText(b),
          hasChildren: b.has_children ?? false,
        }))
        .filter((b) => b.text)
        .map((b) => ({
          ...b,
          text: prepareUntrustedContent(b.text!, "notion_page"),
        }));

      // Wrap title and property values — page metadata is also untrusted
      const rawTitle = extractPageTitle(p.properties ?? {});
      const rawProps = extractProperties(p.properties ?? {});
      const wrappedProps: Record<string, unknown> = {};
      for (const [key, value] of Object.entries(rawProps)) {
        wrappedProps[key] = typeof value === 'string'
          ? prepareUntrustedContent(value, "notion_page")
          : value;
      }

      return {
        id: p.id,
        url: p.url,
        title: prepareUntrustedContent(rawTitle, "notion_page"),
        properties: wrappedProps,
        content: wrappedContent,
        blockCount: blocks.length,
      };
    } catch (err) {
      return { error: formatError(err) };
    }
  },
});

export const notionQueryDatabaseTool = createTool({
  id: "notion-query-database",
  description:
    "Query a Notion database with optional filters and sorts. Auto-paginates to fetch all matching results.",
  inputSchema: z.object({
    databaseId: z.string().describe("Notion database ID (UUID)"),
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
    maxResults: z
      .number()
      .optional()
      .default(200)
      .describe("Max results to return (default 200). Set lower for faster responses."),
  }),
  execute: async (inputData, { requestContext }) => {
    try {
      const client = getClientFromRuntime(requestContext);
      const { databaseId, filter, sorts, maxResults = 200 } = inputData;

      const allResults: any[] = [];
      let cursor: string | undefined;

      do {
        const body: Parameters<typeof client.dataSources.query>[0] = {
          data_source_id: databaseId,
          page_size: Math.min(100, maxResults - allResults.length),
          start_cursor: cursor,
        };
        if (filter) body.filter = filter;
        if (sorts) body.sorts = sorts;

        const response = await client.dataSources.query(body);
        allResults.push(...response.results);

        cursor =
          response.has_more && allResults.length < maxResults
            ? (response.next_cursor ?? undefined)
            : undefined;
      } while (cursor);

      // Wrap property values — database content is untrusted external content
      return {
        results: allResults.map((page: any) => {
          const props = extractProperties(page.properties ?? {});
          const wrappedProps: Record<string, unknown> = {};
          for (const [key, value] of Object.entries(props)) {
            wrappedProps[key] = typeof value === 'string'
              ? prepareUntrustedContent(value, "notion_database")
              : value;
          }
          return {
            id: page.id,
            url: page.url,
            properties: wrappedProps,
          };
        }),
        total: allResults.length,
        capped: allResults.length >= maxResults,
      };
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
