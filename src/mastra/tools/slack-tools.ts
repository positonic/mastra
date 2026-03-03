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

// ── Workspace domain cache (for constructing permalinks) ────────────
let _teamDomain: string | null = null;

async function getTeamDomain(): Promise<string | null> {
  if (_teamDomain) return _teamDomain;
  try {
    const auth = await slackBotClient.auth.test();
    // auth.url is like "https://workspace.slack.com/" — extract the subdomain
    if (auth.url) {
      const match = auth.url.match(/https?:\/\/([^.]+)\.slack\.com/);
      if (match) _teamDomain = match[1];
    }
    return _teamDomain;
  } catch {
    return null;
  }
}

function buildPermalink(teamDomain: string | null, channelId: string, ts: string): string | null {
  if (!teamDomain || !ts) return null;
  // Slack permalink format: https://WORKSPACE.slack.com/archives/CHANNEL/pTIMESTAMP_WITHOUT_DOT
  const tsNoDot = ts.replace(".", "");
  return `https://${teamDomain}.slack.com/archives/${channelId}/p${tsNoDot}`;
}

// ── User ID → display name cache ────────────────────────────────────
const _userNameCache = new Map<string, string>();

async function resolveUserNames(userIds: string[]): Promise<Map<string, string>> {
  const unknowns = userIds.filter((id) => id && !_userNameCache.has(id));
  // Resolve up to 10 unknown users per call to avoid rate limits
  for (const uid of unknowns.slice(0, 10)) {
    try {
      const result = await slackBotClient.users.info({ user: uid });
      if (result.ok && result.user) {
        _userNameCache.set(uid, result.user.real_name || result.user.name || uid);
      }
    } catch {
      _userNameCache.set(uid, uid); // fallback to raw ID
    }
  }
  return _userNameCache;
}

// ── User identity resolution (for mention detection) ────────────────
/**
 * Resolve the Slack user ID for mention/unread queries.
 * The Exponential app looks up IntegrationUserMapping and passes
 * slackUserId via requestContext. Returns null if user hasn't
 * connected their Slack account.
 */
function resolveSlackUserId(requestContext?: any): string | null {
  const ctxUserId = requestContext?.get?.("slackUserId") as string | undefined;
  return ctxUserId || null;
}

// ── Time window helper ──────────────────────────────────────────────
function sinceToOldest(since: string): string {
  const now = Date.now();
  const durations: Record<string, number> = {
    "1h": 60 * 60 * 1000,
    "4h": 4 * 60 * 60 * 1000,
    "12h": 12 * 60 * 60 * 1000,
    "24h": 24 * 60 * 60 * 1000,
    "3d": 3 * 24 * 60 * 60 * 1000,
    "7d": 7 * 24 * 60 * 60 * 1000,
  };
  const ms = durations[since] || durations["24h"];
  return ((now - ms) / 1000).toFixed(6);
}

// ── Mention classification ──────────────────────────────────────────
function classifyMentions(
  text: string,
  userId: string,
  includeGroup: boolean,
): Array<"direct" | "here" | "channel"> {
  const types: Array<"direct" | "here" | "channel"> = [];
  if (text.includes(`<@${userId}>`)) types.push("direct");
  if (includeGroup) {
    if (text.includes("<!here>") || text.includes("<!here|here>")) types.push("here");
    if (text.includes("<!channel>") || text.includes("<!channel|channel>")) types.push("channel");
  }
  return types;
}

// ── Batch processing for rate-limit safety ──────────────────────────
async function batchProcess<T, R>(
  items: T[],
  batchSize: number,
  fn: (item: T) => Promise<R>,
): Promise<Array<{ item: T; result: R | null; error?: unknown }>> {
  const results: Array<{ item: T; result: R | null; error?: unknown }> = [];
  for (let i = 0; i < items.length; i += batchSize) {
    const batch = items.slice(i, i + batchSize);
    const settled = await Promise.allSettled(batch.map(fn));
    for (let j = 0; j < batch.length; j++) {
      const s = settled[j];
      results.push({
        item: batch[j],
        result: s.status === "fulfilled" ? s.value : null,
        error: s.status === "rejected" ? s.reason : undefined,
      });
    }
  }
  return results;
}

// ── Paginated channel fetching ──────────────────────────────────────
/**
 * Fetch Slack channels with cursor-based pagination.
 * Slack conversations.list returns at most `limit` channels per page.
 * This helper collects all pages until no cursor remains or maxChannels is reached.
 */
async function fetchAllSlackChannels(
  client: WebClient,
  options: { types: string; excludeArchived: boolean; maxChannels?: number },
): Promise<Array<any>> {
  const max = options.maxChannels ?? 1000;
  const allChannels: Array<any> = [];
  let cursor: string | undefined;
  do {
    const result = await client.conversations.list({
      types: options.types,
      exclude_archived: options.excludeArchived,
      limit: 200,
      cursor,
    });
    allChannels.push(...(result.channels ?? []));
    cursor = result.response_metadata?.next_cursor || undefined;
  } while (cursor && allChannels.length < max);
  return allChannels.slice(0, max);
}

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
  description: "Send a message to a Slack channel or user. Always pass username and icon_emoji to identify which agent is sending the message.",
  inputSchema: z.object({
    channel: z.string().describe("The channel ID or user ID to send the message to (e.g., C1234567890 or U1234567890)"),
    text: z.string().describe("The text content of the message"),
    blocks: z.array(slackBlockSchema).optional().describe("Optional Block Kit blocks for rich formatting"),
    username: z.string().optional().describe("Display name override for the bot (e.g., 'Paddy', 'Zoe'). Requires chat:write.customize scope."),
    icon_emoji: z.string().optional().describe("Emoji icon override for the bot avatar (e.g., ':clipboard:', ':sparkles:'). Requires chat:write.customize scope."),
  }),
  outputSchema: z.object({
    ok: z.boolean(),
    channel: z.string(),
    ts: z.string().describe("Timestamp of the message"),
    message: z.object({ text: z.string(), type: z.string(), user: z.string(), ts: z.string() }).optional(),
  }),
  execute: async (inputData) => {
    const { channel, text, blocks, username, icon_emoji } = inputData;
    try {
      const result = await slackBotClient.chat.postMessage({ channel, text, blocks, username, icon_emoji });
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
      // Note: chat.update does not support username/icon_emoji overrides — Slack limitation
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
    limit: z.number().min(1).max(1000).default(200).describe("Max channels to return (default: 200, max: 1000). Fetches all pages automatically."),
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
      const rawChannels = await fetchAllSlackChannels(slackBotClient, { types: types ?? "public_channel,private_channel", excludeArchived: excludeArchived ?? true, maxChannels: limit });
      const channels = rawChannels.map((ch) => ({
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
    "Read recent messages from a Slack channel. Returns messages in reverse chronological order (newest first). Use the channel ID from list-slack-channels. Messages include sender display name, text, permalink, and thread info.",
  inputSchema: z.object({
    channel: z.string().describe("Channel ID (e.g., C1234567890). Use list-slack-channels to find IDs."),
    limit: z.number().min(1).max(100).default(25).describe("Number of messages to return (default: 25, max: 100)"),
    oldest: z.string().optional().describe("Only messages after this Unix timestamp (e.g., '1234567890.123456')"),
    latest: z.string().optional().describe("Only messages before this Unix timestamp"),
  }),
  outputSchema: z.object({
    messages: z.array(z.object({
      ts: z.string(), user: z.string().nullable(), userName: z.string().nullable(), text: z.string(),
      threadTs: z.string().nullable(), replyCount: z.number().nullable(),
      permalink: z.string().nullable(),
      reactions: z.array(z.object({ name: z.string(), count: z.number() })).optional(),
    })),
    hasMore: z.boolean(),
    channelId: z.string(),
  }),
  execute: async (inputData) => {
    const { channel, limit, oldest, latest } = inputData;
    console.log(`📜 [getSlackChannelHistory] Fetching history for ${channel} (limit: ${limit})`);
    try {
      const [result, teamDomain] = await Promise.all([
        slackBotClient.conversations.history({ channel, limit, oldest, latest }),
        getTeamDomain(),
      ]);
      const rawMessages = result.messages || [];
      const userIds = rawMessages.map((m) => m.user).filter(Boolean) as string[];
      const nameMap = await resolveUserNames(userIds);
      const messages = rawMessages.map((msg) => ({
        ts: msg.ts || "",
        user: msg.user || null,
        userName: msg.user ? nameMap.get(msg.user) || null : null,
        text: msg.text ? prepareUntrustedContent(msg.text, "slack_message") : "",
        threadTs: msg.thread_ts || null,
        replyCount: msg.reply_count ?? null,
        permalink: buildPermalink(teamDomain, channel, msg.ts || ""),
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
      ts: z.string(), user: z.string().nullable(), userName: z.string().nullable(),
      text: z.string(), isParent: z.boolean(), permalink: z.string().nullable(),
    })),
    hasMore: z.boolean(),
    replyCount: z.number(),
  }),
  execute: async (inputData) => {
    const { channel, threadTs, limit } = inputData;
    console.log(`🧵 [getSlackThreadReplies] Fetching thread ${threadTs} in ${channel} (limit: ${limit})`);
    try {
      const [result, teamDomain] = await Promise.all([
        slackBotClient.conversations.replies({ channel, ts: threadTs, limit }),
        getTeamDomain(),
      ]);
      const rawMessages = result.messages || [];
      const userIds = rawMessages.map((m) => m.user).filter(Boolean) as string[];
      const nameMap = await resolveUserNames(userIds);
      const messages = rawMessages.map((msg) => ({
        ts: msg.ts || "",
        user: msg.user || null,
        userName: msg.user ? nameMap.get(msg.user) || null : null,
        text: msg.text ? prepareUntrustedContent(msg.text, "slack_message") : "",
        isParent: msg.ts === threadTs,
        permalink: buildPermalink(teamDomain, channel, msg.ts || ""),
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
      text: z.string(), user: z.string().nullable(), userName: z.string().nullable(), ts: z.string(),
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
        const userIds = matches.map((m: any) => m.user).filter(Boolean) as string[];
        const nameMap = await resolveUserNames(userIds);
        const results = matches.map((match: any) => ({
          text: match.text ? prepareUntrustedContent(match.text, "slack_message") : "",
          user: match.user || null,
          userName: match.user ? nameMap.get(match.user) || null : null,
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
      const teamDomain = await getTeamDomain();
      let channelsToSearch: Array<{ id: string; name: string }> = [];
      if (channel) {
        channelsToSearch = [{ id: channel, name: "" }];
      } else {
        const rawChannels = await fetchAllSlackChannels(slackBotClient, {
          types: "public_channel,private_channel",
          excludeArchived: true,
          maxChannels: 1000,
        });
        channelsToSearch = rawChannels
          .filter((ch) => ch.is_member)
          .map((ch) => ({ id: ch.id || "", name: ch.name || "" }));
      }

      const queryLower = query.toLowerCase();
      const allResults: Array<{
        text: string; user: string | null; userName: string | null; ts: string;
        channelId: string; channelName: string | null;
        permalink: string | null; searchMode: "local";
      }> = [];

      for (const ch of channelsToSearch) {
        try {
          const history = await slackBotClient.conversations.history({ channel: ch.id, limit: 200 });
          const matches = (history.messages || []).filter(
            (msg) => msg.text && msg.text.toLowerCase().includes(queryLower)
          );
          const matchUserIds = matches.map((m) => m.user).filter(Boolean) as string[];
          const nameMap = await resolveUserNames(matchUserIds);
          for (const msg of matches) {
            allResults.push({
              text: msg.text ? prepareUntrustedContent(msg.text, "slack_message") : "",
              user: msg.user || null,
              userName: msg.user ? nameMap.get(msg.user) || null : null,
              ts: msg.ts || "",
              channelId: ch.id, channelName: ch.name || null,
              permalink: buildPermalink(teamDomain, ch.id, msg.ts || ""),
              searchMode: "local",
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

// ── Mentions & Unreads tools ────────────────────────────────────────

const sinceEnum = z.enum(["1h", "4h", "12h", "24h", "3d", "7d"]);

export const getSlackMentionsTool = createTool({
  id: "get-slack-mentions",
  description:
    "Find @mentions of the user across Slack channels. Returns messages where the user was directly mentioned (@user), and optionally @here/@channel mentions. Use this when the user asks about tags, mentions, or who's been pinging them.",
  inputSchema: z.object({
    since: sinceEnum.default("24h").describe("Time window to search (default: 24h)"),
    includeGroupMentions: z.boolean().default(true).describe("Include @here and @channel mentions (default: true)"),
    limit: z.number().min(1).max(50).default(25).describe("Max mentions to return (default: 25)"),
    maxChannels: z.number().min(1).max(50).default(20).describe("Max channels to scan in bot-token mode (default: 20)"),
  }),
  outputSchema: z.object({
    mentions: z.array(z.object({
      text: z.string(),
      user: z.string().nullable(),
      userName: z.string().nullable(),
      ts: z.string(),
      channelId: z.string(),
      channelName: z.string().nullable(),
      permalink: z.string().nullable(),
      threadTs: z.string().nullable(),
      mentionType: z.enum(["direct", "here", "channel"]),
      searchMode: z.enum(["api", "local"]),
    })),
    totalFound: z.number(),
    searchMode: z.enum(["api", "local"]),
    userId: z.string().nullable(),
    timeWindow: z.string(),
  }),
  execute: async (inputData, { requestContext }) => {
    const { since, includeGroupMentions, limit, maxChannels } = inputData;
    console.log(`🔔 [getSlackMentions] Searching mentions (since: ${since}, limit: ${limit})`);

    const userId = resolveSlackUserId(requestContext);
    if (!userId) {
      throw new Error(
        "Your Slack account is not connected. Please connect Slack in Settings → Integrations to use this feature."
      );
    }

    const oldest = sinceToOldest(since);

    // Path 1: API search with user token
    if (slackUserClient) {
      try {
        const searchQuery = `<@${userId}>`;
        const searchResult = await slackUserClient.search.messages({
          query: searchQuery,
          count: limit,
          sort: "timestamp",
          sort_dir: "desc",
        });
        const matches = searchResult.messages?.matches || [];
        // Filter by time window
        const filtered = matches.filter((m: any) => !oldest || parseFloat(m.ts || "0") >= parseFloat(oldest));
        const userIds = filtered.map((m: any) => m.user).filter(Boolean) as string[];
        const nameMap = await resolveUserNames(userIds);

        const mentions = filtered.map((match: any) => {
          const types = classifyMentions(match.text || "", userId, includeGroupMentions);
          return {
            text: match.text ? prepareUntrustedContent(match.text, "slack_message") : "",
            user: match.user || null,
            userName: match.user ? nameMap.get(match.user) || null : null,
            ts: match.ts || "",
            channelId: match.channel?.id || "",
            channelName: match.channel?.name || null,
            permalink: match.permalink || null,
            threadTs: match.thread_ts || null,
            mentionType: (types[0] || "direct") as "direct" | "here" | "channel",
            searchMode: "api" as const,
          };
        });

        console.log(`✅ [getSlackMentions] API search found ${mentions.length} mentions`);
        return { mentions, totalFound: mentions.length, searchMode: "api" as const, userId, timeWindow: since };
      } catch (error) {
        console.error(`⚠️ [getSlackMentions] API search failed, falling back to local:`, error);
      }
    }

    // Path 2: Local scan with bot token
    const teamDomain = await getTeamDomain();
    const channelList = await slackBotClient.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: maxChannels,
    });
    const memberChannels = (channelList.channels || [])
      .filter((ch) => ch.is_member)
      .map((ch) => ({ id: ch.id || "", name: ch.name || "" }));

    console.log(`🔍 [getSlackMentions] Scanning ${memberChannels.length} channels for <@${userId}>`);

    type MentionResult = Array<{
      text: string; user: string | null; ts: string;
      channelId: string; channelName: string;
      threadTs: string | null; mentionType: "direct" | "here" | "channel";
    }>;

    const batchResults = await batchProcess(memberChannels, 5, async (ch): Promise<MentionResult> => {
      const history = await slackBotClient.conversations.history({ channel: ch.id, oldest, limit: 200 });
      const found: MentionResult = [];
      for (const msg of history.messages || []) {
        if (!msg.text) continue;
        const types = classifyMentions(msg.text, userId, includeGroupMentions);
        if (types.length > 0) {
          for (const t of types) {
            found.push({
              text: msg.text,
              user: msg.user || null,
              ts: msg.ts || "",
              channelId: ch.id,
              channelName: ch.name,
              threadTs: msg.thread_ts || null,
              mentionType: t,
            });
          }
        }
      }
      return found;
    });

    const allMentions: Array<{
      text: string; user: string | null; userName: string | null; ts: string;
      channelId: string; channelName: string | null; permalink: string | null;
      threadTs: string | null; mentionType: "direct" | "here" | "channel";
      searchMode: "local";
    }> = [];

    const allUserIds = new Set<string>();
    for (const br of batchResults) {
      if (br.result) {
        for (const m of br.result) {
          if (m.user) allUserIds.add(m.user);
        }
      }
    }
    const nameMap = await resolveUserNames([...allUserIds]);

    for (const br of batchResults) {
      if (br.result) {
        for (const m of br.result) {
          allMentions.push({
            text: prepareUntrustedContent(m.text, "slack_message"),
            user: m.user,
            userName: m.user ? nameMap.get(m.user) || null : null,
            ts: m.ts,
            channelId: m.channelId,
            channelName: m.channelName,
            permalink: buildPermalink(teamDomain, m.channelId, m.ts),
            threadTs: m.threadTs,
            mentionType: m.mentionType,
            searchMode: "local",
          });
        }
      }
    }

    allMentions.sort((a, b) => (parseFloat(b.ts) || 0) - (parseFloat(a.ts) || 0));
    const trimmed = allMentions.slice(0, limit);
    console.log(`✅ [getSlackMentions] Local scan found ${trimmed.length} mentions across ${memberChannels.length} channels`);
    return { mentions: trimmed, totalFound: trimmed.length, searchMode: "local" as const, userId, timeWindow: since };
  },
});

export const getSlackUnreadsTool = createTool({
  id: "get-slack-unreads",
  description:
    "Show channels with unread messages or recent activity. With a user token, shows actual unread counts. Without a user token, shows channels with recent activity since a given time window. Use this when the user asks what they missed, about unreads, or wants to catch up on Slack.",
  inputSchema: z.object({
    since: sinceEnum.default("24h").describe("Time window for recent activity mode (default: 24h)"),
    includeMessages: z.boolean().default(false).describe("Include actual recent messages in the response (default: false, just counts)"),
    messagesPerChannel: z.number().min(1).max(10).default(3).describe("Messages to show per channel when includeMessages is true (default: 3)"),
    maxChannels: z.number().min(1).max(50).default(30).describe("Max channels to check (default: 30)"),
  }),
  outputSchema: z.object({
    channels: z.array(z.object({
      channelId: z.string(),
      channelName: z.string(),
      isPrivate: z.boolean(),
      unreadCount: z.number().nullable(),
      recentMessageCount: z.number().nullable(),
      lastMessageTs: z.string().nullable(),
      lastMessagePreview: z.string().nullable(),
      messages: z.array(z.object({
        ts: z.string(),
        user: z.string().nullable(),
        userName: z.string().nullable(),
        text: z.string(),
        permalink: z.string().nullable(),
      })).optional(),
    })),
    totalActiveChannels: z.number(),
    mode: z.enum(["unread", "recent_activity"]),
    timeWindow: z.string().nullable(),
  }),
  execute: async (inputData) => {
    const { since, includeMessages, messagesPerChannel, maxChannels } = inputData;
    console.log(`📬 [getSlackUnreads] Checking unreads (since: ${since}, includeMessages: ${includeMessages})`);

    // Path 1: User token — use actual unread counts
    if (slackUserClient) {
      try {
        const channelList = await slackUserClient.conversations.list({
          types: "public_channel,private_channel",
          exclude_archived: true,
          limit: maxChannels,
        });
        const teamDomain = await getTeamDomain();
        const unreadChannels = (channelList.channels || [])
          .filter((ch) => ch.is_member && ((ch as any).unread_count_display || 0) > 0)
          .map((ch) => ({
            id: ch.id || "",
            name: ch.name || "",
            isPrivate: ch.is_private || false,
            unreadCount: (ch as any).unread_count_display as number || 0,
          }));

        type ChannelResult = {
          channelId: string; channelName: string; isPrivate: boolean;
          unreadCount: number; recentMessageCount: null; lastMessageTs: string | null;
          lastMessagePreview: string | null;
          messages?: Array<{ ts: string; user: string | null; userName: string | null; text: string; permalink: string | null }>;
        };

        const results = await batchProcess(unreadChannels, 5, async (ch): Promise<ChannelResult> => {
          const result: ChannelResult = {
            channelId: ch.id, channelName: ch.name, isPrivate: ch.isPrivate,
            unreadCount: ch.unreadCount, recentMessageCount: null,
            lastMessageTs: null, lastMessagePreview: null,
          };
          if (includeMessages) {
            const history = await slackBotClient.conversations.history({ channel: ch.id, limit: messagesPerChannel });
            const msgs = history.messages || [];
            const userIds = msgs.map((m) => m.user).filter(Boolean) as string[];
            const nameMap = await resolveUserNames(userIds);
            result.messages = msgs.map((msg) => ({
              ts: msg.ts || "",
              user: msg.user || null,
              userName: msg.user ? nameMap.get(msg.user) || null : null,
              text: msg.text ? prepareUntrustedContent(msg.text, "slack_message") : "",
              permalink: buildPermalink(teamDomain, ch.id, msg.ts || ""),
            }));
            if (msgs.length > 0) {
              result.lastMessageTs = msgs[0].ts || null;
              result.lastMessagePreview = msgs[0].text ? prepareUntrustedContent(msgs[0].text.slice(0, 100), "slack_message") : null;
            }
          } else {
            const history = await slackBotClient.conversations.history({ channel: ch.id, limit: 1 });
            const latest = history.messages?.[0];
            if (latest) {
              result.lastMessageTs = latest.ts || null;
              result.lastMessagePreview = latest.text ? prepareUntrustedContent(latest.text.slice(0, 100), "slack_message") : null;
            }
          }
          return result;
        });

        const channels = results
          .filter((r) => r.result)
          .map((r) => r.result!)
          .sort((a, b) => (parseFloat(b.lastMessageTs || "0") || 0) - (parseFloat(a.lastMessageTs || "0") || 0));

        console.log(`✅ [getSlackUnreads] Found ${channels.length} channels with unreads`);
        return { channels, totalActiveChannels: channels.length, mode: "unread" as const, timeWindow: null };
      } catch (error) {
        console.error(`⚠️ [getSlackUnreads] User token mode failed, falling back to recent activity:`, error);
      }
    }

    // Path 2: Bot token — show recent activity since time window
    const oldest = sinceToOldest(since);
    const teamDomain = await getTeamDomain();
    const channelList = await slackBotClient.conversations.list({
      types: "public_channel,private_channel",
      exclude_archived: true,
      limit: maxChannels,
    });
    const memberChannels = (channelList.channels || [])
      .filter((ch) => ch.is_member)
      .map((ch) => ({ id: ch.id || "", name: ch.name || "", isPrivate: ch.is_private || false }));

    console.log(`🔍 [getSlackUnreads] Scanning ${memberChannels.length} channels for activity since ${since}`);

    type ActivityResult = {
      channelId: string; channelName: string; isPrivate: boolean;
      messageCount: number; lastMessageTs: string | null; lastMessagePreview: string | null;
      messages?: Array<{ ts: string; user: string | null; userName: string | null; text: string; permalink: string | null }>;
    };

    const batchResults = await batchProcess(memberChannels, 5, async (ch): Promise<ActivityResult> => {
      const fetchLimit = includeMessages ? messagesPerChannel : 1;
      const history = await slackBotClient.conversations.history({ channel: ch.id, oldest, limit: fetchLimit });
      const msgs = history.messages || [];
      const result: ActivityResult = {
        channelId: ch.id, channelName: ch.name, isPrivate: ch.isPrivate,
        messageCount: msgs.length + (history.has_more ? 1 : 0), // approximate — has_more means there are more
        lastMessageTs: msgs[0]?.ts || null,
        lastMessagePreview: msgs[0]?.text ? prepareUntrustedContent(msgs[0].text.slice(0, 100), "slack_message") : null,
      };
      if (includeMessages && msgs.length > 0) {
        const userIds = msgs.map((m) => m.user).filter(Boolean) as string[];
        const nameMap = await resolveUserNames(userIds);
        result.messages = msgs.map((msg) => ({
          ts: msg.ts || "",
          user: msg.user || null,
          userName: msg.user ? nameMap.get(msg.user) || null : null,
          text: msg.text ? prepareUntrustedContent(msg.text, "slack_message") : "",
          permalink: buildPermalink(teamDomain, ch.id, msg.ts || ""),
        }));
      }
      return result;
    });

    const activeChannels = batchResults
      .filter((r) => r.result && r.result.messageCount > 0)
      .map((r) => ({
        channelId: r.result!.channelId,
        channelName: r.result!.channelName,
        isPrivate: r.result!.isPrivate,
        unreadCount: null as number | null,
        recentMessageCount: r.result!.messageCount,
        lastMessageTs: r.result!.lastMessageTs,
        lastMessagePreview: r.result!.lastMessagePreview,
        messages: r.result!.messages,
      }))
      .sort((a, b) => (parseFloat(b.lastMessageTs || "0") || 0) - (parseFloat(a.lastMessageTs || "0") || 0));

    console.log(`✅ [getSlackUnreads] Found ${activeChannels.length} active channels in the last ${since}`);
    return { channels: activeChannels, totalActiveChannels: activeChannels.length, mode: "recent_activity" as const, timeWindow: since };
  },
});
