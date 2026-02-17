import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { WebClient } from "@slack/web-api";
import { prepareUntrustedContent } from "../utils/content-safety.js";

// Bot token client (xoxb-*)
const slackBotClient = new WebClient(process.env.SLACK_BOT_TOKEN);

// Optional user token client (xoxp-*) — needed for search.messages
const slackUserClient = process.env.SLACK_USER_TOKEN
  ? new WebClient(process.env.SLACK_USER_TOKEN)
  : undefined;

// Block Kit schemas
const slackBlockElementSchema = z.object({
  type: z.string(),
  text: z.object({ type: z.string(), text: z.string(), emoji: z.boolean().optional(), verbatim: z.boolean().optional() }).optional(),
  value: z.string().optional(),
  url: z.string().optional(),
  action_id: z.string().optional(),
  style: z.string().optional(),
  confirm: z.any().optional(),
  placeholder: z.object({ type: z.string(), text: z.string(), emoji: z.boolean().optional() }).optional(),
  initial_value: z.string().optional(),
  options: z.array(z.object({ text: z.object({ type: z.string(), text: z.string(), emoji: z.boolean().optional() }), value: z.string() })).optional(),
});

const slackBlockSchema = z.object({
  type: z.string(),
  text: z.object({ type: z.string(), text: z.string(), emoji: z.boolean().optional(), verbatim: z.boolean().optional() }).optional(),
  elements: z.array(slackBlockElementSchema).optional(),
  accessory: slackBlockElementSchema.optional(),
  block_id: z.string().optional(),
  fields: z.array(z.object({ type: z.string(), text: z.string(), emoji: z.boolean().optional(), verbatim: z.boolean().optional() })).optional(),
  image_url: z.string().optional(),
  alt_text: z.string().optional(),
  title: z.object({ type: z.string(), text: z.string(), emoji: z.boolean().optional() }).optional(),
});

// ── Existing tools (moved from index.ts) ─────────────────────────────

export const sendSlackMessageTool = createTool({
  id: "send-slack-message",
  description: "Send a message to a Slack channel or user",
  inputSchema: z.object({
    channel: z.string().describe("The channel ID or user ID to send the message to (e.g., C1234567890 or U1234567890)"),
    text: z.string().describe("The text content of the message"),
    blocks: z.array(slackBlockSchema).optional().describe("Optional Block Kit blocks for rich formatting"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    channel: z.string(),
    ts: z.string().describe("Timestamp of the message"),
    message: z.object({ text: z.string(), type: z.string(), user: z.string(), ts: z.string() }).optional(),
  }),
  execute: async (inputData) => {
    const { channel, text, blocks } = inputData;
    try {
      const result = await slackBotClient.chat.postMessage({ channel, text, blocks });
      return {
        ok: result.ok || false,
        channel: result.channel || "",
        ts: result.ts || "",
        message: result.message
          ? { text: result.message.text || "", type: result.message.type || "", user: result.message.user || "", ts: result.message.ts || "" }
          : undefined,
      };
    } catch (error) {
      throw new Error(`Failed to send Slack message: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  },
});

export const updateSlackMessageTool = createTool({
  id: "update-slack-message",
  description: "Update an existing Slack message",
  inputSchema: z.object({
    channel: z.string().describe("The channel ID where the message was posted"),
    ts: z.string().describe("The timestamp of the message to update"),
    text: z.string().describe("The new text content of the message"),
    blocks: z.array(slackBlockSchema).optional().describe("Optional Block Kit blocks for rich formatting"),
  }),
  outputSchema: z.object({ ok: z.boolean(), channel: z.string(), ts: z.string(), text: z.string() }),
  execute: async (inputData) => {
    const { channel, ts, text, blocks } = inputData;
    try {
      const result = await slackBotClient.chat.update({ channel, ts, text, blocks });
      return { ok: result.ok || false, channel: result.channel || "", ts: result.ts || "", text: result.text || "" };
    } catch (error) {
      throw new Error(`Failed to update Slack message: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  },
});

export const getSlackUserInfoTool = createTool({
  id: "get-slack-user-info",
  description: "Get information about a Slack user",
  inputSchema: z.object({
    user: z.string().describe("The user ID to get information for (e.g., U1234567890)"),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    user: z.object({
      id: z.string(), name: z.string(), real_name: z.string().optional(),
      tz: z.string().optional(), tz_label: z.string().optional(),
      is_bot: z.boolean(), is_admin: z.boolean().optional(), is_owner: z.boolean().optional(),
    }).optional(),
  }),
  execute: async (inputData) => {
    const { user } = inputData;
    try {
      const result = await slackBotClient.users.info({ user });
      if (!result.ok || !result.user) return { ok: false };
      return {
        ok: true,
        user: {
          id: result.user.id || "", name: result.user.name || "", real_name: result.user.real_name,
          tz: result.user.tz, tz_label: result.user.tz_label,
          is_bot: result.user.is_bot || false, is_admin: result.user.is_admin, is_owner: result.user.is_owner,
        },
      };
    } catch (error) {
      throw new Error(`Failed to get Slack user info: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  },
});

// ── New read tools ───────────────────────────────────────────────────

export const listSlackChannelsTool = createTool({
  id: "list-slack-channels",
  description:
    "List Slack channels the bot has access to. Shows channel name, topic, purpose, member count, and whether it is archived. Use this to discover available channels before reading their history.",
  inputSchema: z.object({
    types: z.string().default("public_channel,private_channel").describe("Comma-separated channel types: public_channel, private_channel, mpim, im"),
    excludeArchived: z.boolean().default(true).describe("Exclude archived channels (default: true)"),
    limit: z.number().min(1).max(200).default(100).describe("Max channels to return (default: 100)"),
  }),
  outputSchema: z.object({
    channels: z.array(z.object({
      id: z.string(), name: z.string(), topic: z.string().nullable(), purpose: z.string().nullable(),
      memberCount: z.number().nullable(), isPrivate: z.boolean(), isArchived: z.boolean(), isMember: z.boolean(),
    })),
    total: z.number(),
  }),
  execute: async (inputData) => {
    const { types, excludeArchived, limit } = inputData;
    console.log(`📋 [listSlackChannels] Listing channels (types: ${types}, limit: ${limit})`);
    try {
      const result = await slackBotClient.conversations.list({ types, exclude_archived: excludeArchived, limit });
      const channels = (result.channels || []).map((ch) => ({
        id: ch.id || "",
        name: ch.name || "",
        topic: ch.topic?.value ? prepareUntrustedContent(ch.topic.value, "slack_channel_metadata") : null,
        purpose: ch.purpose?.value ? prepareUntrustedContent(ch.purpose.value, "slack_channel_metadata") : null,
        memberCount: ch.num_members ?? null,
        isPrivate: ch.is_private || false,
        isArchived: ch.is_archived || false,
        isMember: ch.is_member || false,
      }));
      console.log(`✅ [listSlackChannels] Found ${channels.length} channels`);
      return { channels, total: channels.length };
    } catch (error) {
      throw new Error(`Failed to list Slack channels: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  },
});

export const getSlackChannelHistoryTool = createTool({
  id: "get-slack-channel-history",
  description:
    "Read recent messages from a Slack channel. Returns messages in reverse chronological order (newest first). Use the channel ID from list-slack-channels. Messages include sender user ID, text, timestamp, and thread info.",
  inputSchema: z.object({
    channel: z.string().describe("Channel ID (e.g., C1234567890). Use list-slack-channels to find IDs."),
    limit: z.number().min(1).max(100).default(25).describe("Number of messages to return (default: 25, max: 100)"),
    oldest: z.string().optional().describe("Only messages after this Unix timestamp (e.g., '1234567890.123456')"),
    latest: z.string().optional().describe("Only messages before this Unix timestamp"),
  }),
  outputSchema: z.object({
    messages: z.array(z.object({
      ts: z.string(), user: z.string().nullable(), text: z.string(),
      threadTs: z.string().nullable(), replyCount: z.number().nullable(),
      reactions: z.array(z.object({ name: z.string(), count: z.number() })).optional(),
    })),
    hasMore: z.boolean(),
    channelId: z.string(),
  }),
  execute: async (inputData) => {
    const { channel, limit, oldest, latest } = inputData;
    console.log(`📜 [getSlackChannelHistory] Fetching history for ${channel} (limit: ${limit})`);
    try {
      const result = await slackBotClient.conversations.history({ channel, limit, oldest, latest });
      const messages = (result.messages || []).map((msg) => ({
        ts: msg.ts || "",
        user: msg.user || null,
        text: msg.text ? prepareUntrustedContent(msg.text, "slack_message") : "",
        threadTs: msg.thread_ts || null,
        replyCount: msg.reply_count ?? null,
        reactions: msg.reactions?.map((r) => ({ name: r.name || "", count: r.count || 0 })),
      }));
      console.log(`✅ [getSlackChannelHistory] Returned ${messages.length} messages (hasMore: ${result.has_more})`);
      return { messages, hasMore: result.has_more || false, channelId: channel };
    } catch (error) {
      throw new Error(`Failed to get Slack channel history: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  },
});

export const getSlackThreadRepliesTool = createTool({
  id: "get-slack-thread-replies",
  description:
    "Read all replies in a Slack thread. Use this when you see a message with replies (replyCount > 0) from get-slack-channel-history and want to read the full conversation thread.",
  inputSchema: z.object({
    channel: z.string().describe("Channel ID where the thread exists"),
    threadTs: z.string().describe("Timestamp (ts) of the thread's parent message"),
    limit: z.number().min(1).max(100).default(50).describe("Max replies to return (default: 50)"),
  }),
  outputSchema: z.object({
    messages: z.array(z.object({
      ts: z.string(), user: z.string().nullable(), text: z.string(), isParent: z.boolean(),
    })),
    hasMore: z.boolean(),
    replyCount: z.number(),
  }),
  execute: async (inputData) => {
    const { channel, threadTs, limit } = inputData;
    console.log(`🧵 [getSlackThreadReplies] Fetching thread ${threadTs} in ${channel} (limit: ${limit})`);
    try {
      const result = await slackBotClient.conversations.replies({ channel, ts: threadTs, limit });
      const messages = (result.messages || []).map((msg) => ({
        ts: msg.ts || "",
        user: msg.user || null,
        text: msg.text ? prepareUntrustedContent(msg.text, "slack_message") : "",
        isParent: msg.ts === threadTs,
      }));
      const parentMsg = result.messages?.[0];
      const replyCount = parentMsg?.reply_count ?? messages.length - 1;
      console.log(`✅ [getSlackThreadReplies] Returned ${messages.length} messages (replyCount: ${replyCount})`);
      return { messages, hasMore: result.has_more || false, replyCount };
    } catch (error) {
      throw new Error(`Failed to get Slack thread replies: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  },
});

export const searchSlackMessagesTool = createTool({
  id: "search-slack-messages",
  description:
    "Search for messages across Slack channels. If a Slack user token is configured, performs a full server-side search. Otherwise, searches recent history from accessible channels by keyword matching. The bot can only search channels it has been invited to.",
  inputSchema: z.object({
    query: z.string().describe("Search query — keywords to look for in messages"),
    channel: z.string().optional().describe("Limit search to a specific channel ID (optional)"),
    limit: z.number().min(1).max(50).default(20).describe("Max results to return (default: 20)"),
  }),
  outputSchema: z.object({
    results: z.array(z.object({
      text: z.string(), user: z.string().nullable(), ts: z.string(),
      channelId: z.string(), channelName: z.string().nullable(),
      permalink: z.string().nullable(), searchMode: z.enum(["api", "local"]),
    })),
    totalResults: z.number(),
    searchMode: z.enum(["api", "local"]),
  }),
  execute: async (inputData) => {
    const { query, channel, limit } = inputData;
    console.log(`🔍 [searchSlackMessages] Searching "${query}" (channel: ${channel || "all"}, limit: ${limit})`);

    // Path 1: Use search.messages with user token if available
    if (slackUserClient) {
      try {
        const searchResult = await slackUserClient.search.messages({
          query: channel ? `in:<#${channel}> ${query}` : query,
          count: limit,
          sort: "timestamp",
          sort_dir: "desc",
        });
        const matches = searchResult.messages?.matches || [];
        const results = matches.map((match: any) => ({
          text: match.text ? prepareUntrustedContent(match.text, "slack_message") : "",
          user: match.user || null,
          ts: match.ts || "",
          channelId: match.channel?.id || "",
          channelName: match.channel?.name || null,
          permalink: match.permalink || null,
          searchMode: "api" as const,
        }));
        console.log(`✅ [searchSlackMessages] API search found ${results.length} results`);
        return { results, totalResults: searchResult.messages?.total || results.length, searchMode: "api" as const };
      } catch (error) {
        console.error(`⚠️ [searchSlackMessages] API search failed, falling back to local:`, error);
      }
    }

    // Path 2: Local fallback — fetch history from channels and filter
    try {
      let channelsToSearch: Array<{ id: string; name: string }> = [];
      if (channel) {
        channelsToSearch = [{ id: channel, name: "" }];
      } else {
        const channelList = await slackBotClient.conversations.list({
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: 10,
        });
        channelsToSearch = (channelList.channels || [])
          .filter((ch) => ch.is_member)
          .map((ch) => ({ id: ch.id || "", name: ch.name || "" }));
      }

      const queryLower = query.toLowerCase();
      const allResults: Array<{
        text: string; user: string | null; ts: string;
        channelId: string; channelName: string | null;
        permalink: string | null; searchMode: "local";
      }> = [];

      for (const ch of channelsToSearch) {
        try {
          const history = await slackBotClient.conversations.history({ channel: ch.id, limit: 200 });
          const matches = (history.messages || []).filter(
            (msg) => msg.text && msg.text.toLowerCase().includes(queryLower)
          );
          for (const msg of matches) {
            allResults.push({
              text: msg.text ? prepareUntrustedContent(msg.text, "slack_message") : "",
              user: msg.user || null, ts: msg.ts || "",
              channelId: ch.id, channelName: ch.name || null,
              permalink: null, searchMode: "local",
            });
          }
        } catch (err) {
          console.warn(`⚠️ [searchSlackMessages] Skipping channel ${ch.id}: ${err instanceof Error ? err.message : "unknown error"}`);
        }
      }

      allResults.sort((a, b) => (parseFloat(b.ts) || 0) - (parseFloat(a.ts) || 0));
      const trimmed = allResults.slice(0, limit);
      console.log(`✅ [searchSlackMessages] Local search found ${trimmed.length} results across ${channelsToSearch.length} channels`);
      return { results: trimmed, totalResults: trimmed.length, searchMode: "local" as const };
    } catch (error) {
      throw new Error(`Failed to search Slack messages: ${error instanceof Error ? error.message : "Unknown error"}`);
    }
  },
});
