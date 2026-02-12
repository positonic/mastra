import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { getWhatsAppGateway } from "../bots/whatsapp-gateway.js";

/**
 * Normalizes a phone number or JID string to a WhatsApp JID.
 * If the input already contains '@', it's returned as-is.
 * Otherwise, non-digit characters are stripped and @s.whatsapp.net is appended.
 */
function normalizeToJid(input: string): string {
  if (input.includes('@')) return input;
  return input.replace(/[^\d]/g, '') + '@s.whatsapp.net';
}

function getStoreOrThrow() {
  const gateway = getWhatsAppGateway();
  const store = gateway?.getMessageStore();
  if (!store) {
    throw new Error("WhatsApp message store not available. Is the WhatsApp gateway running?");
  }
  return store;
}

export const listWhatsAppChatsTool = createTool({
  id: "list-whatsapp-chats",
  description:
    "List all WhatsApp conversations with contact names, phone numbers, last message time, and message counts. " +
    "Use this to see who the user has been chatting with on WhatsApp.",
  inputSchema: z.object({
    limit: z
      .number()
      .default(50)
      .describe("Max chats to return (default: 50)"),
    offset: z
      .number()
      .default(0)
      .describe("Offset for pagination"),
  }),
  outputSchema: z.object({
    chats: z.array(
      z.object({
        jid: z.string(),
        phoneNumber: z.string().nullable(),
        contactName: z.string().nullable(),
        pushName: z.string().nullable(),
        isGroup: z.boolean(),
        lastMessageAt: z.string().nullable(),
        messageCount: z.number(),
      }),
    ),
    total: z.number(),
  }),
  execute: async (inputData, { requestContext }) => {
    const userId = requestContext?.get("userId");
    if (!userId) throw new Error("No userId available");

    const store = getStoreOrThrow();

    console.log(`📋 [listWhatsAppChats] Listing chats for user ${userId} (limit: ${inputData.limit}, offset: ${inputData.offset})`);

    const result = await store.listChats(userId, {
      limit: inputData.limit,
      offset: inputData.offset,
    });

    console.log(`✅ [listWhatsAppChats] Found ${result.total} chats, returning ${result.chats.length}`);

    return result;
  },
});

export const getWhatsAppChatHistoryTool = createTool({
  id: "get-whatsapp-chat-history",
  description:
    "Get the full message history for a specific WhatsApp chat, with pagination. Returns messages in " +
    "chronological order. Use the JID from list-whatsapp-chats, or pass a phone number (e.g., '+1234567890').",
  inputSchema: z.object({
    jid: z
      .string()
      .describe(
        "WhatsApp JID (e.g., '1234567890@s.whatsapp.net') or phone number in international format",
      ),
    limit: z
      .number()
      .default(50)
      .describe("Max messages to return (default: 50)"),
    before: z
      .string()
      .optional()
      .describe("ISO timestamp — return messages before this time (for pagination)"),
  }),
  outputSchema: z.object({
    messages: z.array(
      z.object({
        messageId: z.string(),
        fromMe: z.boolean(),
        text: z.string(),
        timestamp: z.string(),
        senderName: z.string().nullable(),
      }),
    ),
    chatInfo: z.object({
      contactName: z.string().nullable(),
      phoneNumber: z.string().nullable(),
      totalMessages: z.number(),
    }),
    hasMore: z.boolean(),
  }),
  execute: async (inputData, { requestContext }) => {
    const userId = requestContext?.get("userId");
    if (!userId) throw new Error("No userId available");

    const store = getStoreOrThrow();

    const jid = normalizeToJid(inputData.jid);

    console.log(`📜 [getWhatsAppChatHistory] Fetching history for ${jid} (user: ${userId}, limit: ${inputData.limit})`);

    const result = await store.getChatHistory(userId, jid, {
      limit: inputData.limit,
      before: inputData.before ? new Date(inputData.before) : undefined,
    });

    console.log(`✅ [getWhatsAppChatHistory] Returned ${result.messages.length} messages (hasMore: ${result.hasMore})`);

    return result;
  },
});

export const searchWhatsAppChatsTool = createTool({
  id: "search-whatsapp-chats",
  description:
    "Search across all WhatsApp messages using keyword and/or semantic (AI-powered) search. " +
    "Keyword search finds exact text matches; semantic search finds conceptually similar messages. " +
    "Use 'hybrid' mode (default) for the best results combining both approaches.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("Search query — can be keywords or a natural language question"),
    searchType: z
      .enum(["keyword", "semantic", "hybrid"])
      .default("hybrid")
      .describe(
        "'keyword' for exact text matches, 'semantic' for meaning-based search, 'hybrid' for both (default)",
      ),
    jid: z
      .string()
      .optional()
      .describe("Limit search to a specific chat (WhatsApp JID or phone number)"),
    limit: z
      .number()
      .default(15)
      .describe("Max results to return (default: 15)"),
  }),
  outputSchema: z.object({
    results: z.array(
      z.object({
        text: z.string(),
        fromMe: z.boolean(),
        timestamp: z.string(),
        senderName: z.string().nullable(),
        contactName: z.string().nullable(),
        phoneNumber: z.string().nullable(),
        jid: z.string(),
        searchType: z.enum(["keyword", "semantic"]),
        relevance: z.number().optional(),
      }),
    ),
    totalResults: z.number(),
  }),
  execute: async (inputData, { requestContext }) => {
    const userId = requestContext?.get("userId");
    if (!userId) throw new Error("No userId available");

    const store = getStoreOrThrow();

    const jid = inputData.jid ? normalizeToJid(inputData.jid) : undefined;

    console.log(
      `🔍 [searchWhatsAppChats] Searching "${inputData.query}" (type: ${inputData.searchType}, ` +
      `user: ${userId}${jid ? `, jid: ${jid}` : ''})`,
    );

    const results: Array<{
      text: string;
      fromMe: boolean;
      timestamp: string;
      senderName: string | null;
      contactName: string | null;
      phoneNumber: string | null;
      jid: string;
      searchType: "keyword" | "semantic";
      relevance?: number;
    }> = [];

    if (inputData.searchType === "keyword" || inputData.searchType === "hybrid") {
      const keywordResults = await store.searchKeyword(userId, inputData.query, {
        jid,
        limit: inputData.limit,
      });
      results.push(
        ...keywordResults.map((r) => ({
          text: r.text,
          fromMe: r.fromMe,
          timestamp: r.timestamp,
          senderName: r.senderName,
          contactName: r.contactName ?? null,
          phoneNumber: r.phoneNumber ?? null,
          jid: r.jid ?? '',
          searchType: "keyword" as const,
        })),
      );
    }

    if (inputData.searchType === "semantic" || inputData.searchType === "hybrid") {
      const semanticResults = await store.searchSemantic(userId, inputData.query, {
        jid,
        topK: inputData.limit,
      });
      results.push(
        ...semanticResults.map((r) => ({
          text: r.text,
          fromMe: r.fromMe,
          timestamp: r.timestamp,
          senderName: r.senderName,
          contactName: r.contactName,
          phoneNumber: r.phoneNumber,
          jid: r.jid,
          searchType: "semantic" as const,
          relevance: r.relevance,
        })),
      );
    }

    // Deduplicate by content + timestamp in hybrid mode
    const seen = new Set<string>();
    const deduped = results.filter((r) => {
      const key = `${r.text}:${r.timestamp}`;
      if (seen.has(key)) return false;
      seen.add(key);
      return true;
    });

    const finalResults = deduped.slice(0, inputData.limit);

    console.log(`✅ [searchWhatsAppChats] Found ${finalResults.length} results`);

    return {
      results: finalResults,
      totalResults: finalResults.length,
    };
  },
});
