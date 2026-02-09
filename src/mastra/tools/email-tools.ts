import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";

// ==================== Email Tools ====================
// Per-user email access via the Exponential backend (IMAP/SMTP).
// Each user connects their email in Settings → Integrations.
// These tools call backend tRPC endpoints — same pattern as calendar tools.

export const checkEmailConnectionTool = createTool({
  id: "check-email-connection",
  description:
    "Check if the user has connected their email in account settings. Always call this before attempting to read or send email.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    isConnected: z.boolean(),
    email: z.string().optional(),
    error: z.string().optional(),
  }),
  execute: async (_inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    console.log(`📧 [checkEmailConnection] Checking email connection for user`);

    const { data } = await authenticatedTrpcCall<{ isConnected: boolean; email?: string; error?: string }>(
      "mastra.checkEmailConnectionStatus",
      {},
      { authToken, sessionId, userId }
    );

    console.log(`✅ [checkEmailConnection] Connected: ${data.isConnected}, email: ${data.email || "none"}`);
    return data;
  },
});

export const getRecentEmailsTool = createTool({
  id: "get-recent-emails",
  description:
    "Get recent emails from the user's inbox. Returns summaries (no full body). Use get-email-by-id to read full content.",
  inputSchema: z.object({
    maxResults: z
      .number()
      .min(1)
      .max(50)
      .default(10)
      .describe("Maximum number of emails to return (default 10)"),
    unreadOnly: z
      .boolean()
      .default(false)
      .describe("Only return unread emails"),
    since: z
      .string()
      .optional()
      .describe("Only return emails since this ISO date (e.g., '2024-02-01')"),
  }),
  outputSchema: z.object({
    emails: z.array(
      z.object({
        id: z.string(),
        from: z.string(),
        subject: z.string(),
        snippet: z.string(),
        date: z.string(),
        isUnread: z.boolean(),
      })
    ),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    console.log(`📧 [getRecentEmails] Fetching emails: maxResults=${inputData.maxResults}, unreadOnly=${inputData.unreadOnly}`);

    const { data } = await authenticatedTrpcCall<{ emails: any[] }>(
      "mastra.getEmails",
      {
        maxResults: inputData.maxResults,
        unreadOnly: inputData.unreadOnly,
        since: inputData.since,
      },
      { authToken, sessionId, userId }
    );

    console.log(`✅ [getRecentEmails] Retrieved ${data.emails?.length || 0} emails`);
    return data;
  },
});

export const getEmailByIdTool = createTool({
  id: "get-email-by-id",
  description:
    "Read the full content of a specific email by its ID. Also marks the email as read.",
  inputSchema: z.object({
    emailId: z.string().describe("The email ID (UID) from the inbox listing"),
  }),
  outputSchema: z.object({
    email: z.object({
      id: z.string(),
      from: z.string(),
      to: z.string(),
      cc: z.string(),
      subject: z.string(),
      body: z.string(),
      date: z.string(),
      isUnread: z.boolean(),
      attachments: z.array(
        z.object({
          filename: z.string(),
          contentType: z.string(),
          size: z.number(),
        })
      ),
    }),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    console.log(`📧 [getEmailById] Fetching email: ${inputData.emailId}`);

    const { data } = await authenticatedTrpcCall<{ email: any }>(
      "mastra.getEmailById",
      { emailId: inputData.emailId },
      { authToken, sessionId, userId }
    );

    console.log(`✅ [getEmailById] Retrieved email: "${data.email?.subject}"`);
    return data;
  },
});

export const searchEmailsTool = createTool({
  id: "search-emails",
  description:
    "Search the user's inbox by sender, subject, or content. Returns email summaries matching the query.",
  inputSchema: z.object({
    query: z
      .string()
      .describe("Search query — matches against sender, subject, and body"),
    maxResults: z
      .number()
      .min(1)
      .max(50)
      .default(10)
      .describe("Maximum number of results (default 10)"),
  }),
  outputSchema: z.object({
    emails: z.array(
      z.object({
        id: z.string(),
        from: z.string(),
        subject: z.string(),
        snippet: z.string(),
        date: z.string(),
        isUnread: z.boolean(),
      })
    ),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    console.log(`🔍 [searchEmails] Query: "${inputData.query}", maxResults: ${inputData.maxResults}`);

    const { data } = await authenticatedTrpcCall<{ emails: any[] }>(
      "mastra.searchEmails",
      { query: inputData.query, maxResults: inputData.maxResults },
      { authToken, sessionId, userId }
    );

    console.log(`✅ [searchEmails] Found ${data.emails?.length || 0} results`);
    return data;
  },
});

export const sendEmailTool = createTool({
  id: "send-email",
  description:
    "Send an email from the user's connected email address. ALWAYS show the user the full email (To, Subject, Body) and get explicit confirmation before calling this tool.",
  inputSchema: z.object({
    to: z.string().describe("Recipient email address"),
    cc: z.string().optional().describe("CC email address (optional)"),
    subject: z.string().describe("Email subject line"),
    body: z.string().describe("Email body (plain text)"),
    inReplyTo: z
      .string()
      .optional()
      .describe("Message-ID to reply to (for threading)"),
    references: z
      .string()
      .optional()
      .describe("References header (for threading)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    messageId: z.string(),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    console.log(`🎯 [sendEmail] Sending to: ${inputData.to}, subject: "${inputData.subject}"`);

    const { data } = await authenticatedTrpcCall<{ success: boolean; messageId: string }>(
      "mastra.sendEmail",
      inputData,
      { authToken, sessionId, userId }
    );

    console.log(`✅ [sendEmail] Sent! messageId: ${data.messageId}`);
    return data;
  },
});

export const replyToEmailTool = createTool({
  id: "reply-to-email",
  description:
    "Reply to a specific email in the user's inbox. Automatically sets threading headers. ALWAYS show the user the draft reply and get explicit confirmation before calling this tool.",
  inputSchema: z.object({
    emailId: z.string().describe("The email ID (UID) to reply to"),
    body: z.string().describe("Reply body (plain text)"),
  }),
  outputSchema: z.object({
    success: z.boolean(),
    messageId: z.string(),
  }),
  execute: async (inputData, { requestContext }) => {
    const authToken = requestContext?.get("authToken") as string | undefined;
    const sessionId = requestContext?.get("whatsappSession") as string | undefined;
    const userId = requestContext?.get("userId") as string | undefined;

    if (!authToken) {
      throw new Error("No authentication token available");
    }

    console.log(`🎯 [replyToEmail] Replying to email: ${inputData.emailId}`);

    const { data } = await authenticatedTrpcCall<{ success: boolean; messageId: string }>(
      "mastra.replyToEmail",
      { emailId: inputData.emailId, body: inputData.body },
      { authToken, sessionId, userId }
    );

    console.log(`✅ [replyToEmail] Reply sent! messageId: ${data.messageId}`);
    return data;
  },
});
