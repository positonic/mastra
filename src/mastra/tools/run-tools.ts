import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall, authenticatedTrpcQuery } from "../utils/authenticated-fetch.js";

// ==================== Agent run tools ====================
// Tools only the `assistantRunAgent` carries (Exponential ADR-0067, Agent PRD
// D5). Every one calls back into the Exponential app's `mastra.*` router with
// the run JWT; the app appends the `AgentRunEvent` inside the procedure, so
// events are written by the app, never streamed from here. The run id is a
// claim on that JWT — no tool takes it as input, so a run cannot address
// another run.

function runAuth(requestContext: { get(key: string): unknown } | undefined) {
  const authToken = requestContext?.get("authToken") as string | undefined;
  const userId = requestContext?.get("userId") as string | undefined;
  if (!authToken) throw new Error("No authentication token available");
  return { authToken, userId };
}

export const getRunContextTool = createTool({
  id: "get-run-context",
  description:
    "Load everything about the action you were assigned: the brief (title, description, project, status, dates), who else is assigned, the project's members (so you can delegate to a person or another Assistant), recent comments on the action, and — when you are resuming after asking your owner — the previous run's summary and the owner's reply. Call this first.",
  inputSchema: z.object({}),
  outputSchema: z.object({
    action: z.object({
      id: z.string(),
      name: z.string(),
      description: z.string().nullable(),
      status: z.string(),
      priority: z.string().nullable(),
      dueDate: z.string().nullable(),
      project: z.object({ id: z.string(), name: z.string() }).nullable(),
      workspaceId: z.string().nullable(),
    }),
    assignees: z.array(z.object({ id: z.string(), name: z.string().nullable(), isAgent: z.boolean() })),
    members: z.array(
      z.object({
        id: z.string(),
        name: z.string().nullable(),
        isAgent: z.boolean(),
        assistantOwner: z.object({ id: z.string(), name: z.string().nullable() }).nullable(),
      }),
    ),
    comments: z.array(
      z.object({ id: z.string(), authorName: z.string().nullable(), markdown: z.string(), createdAt: z.string() }),
    ),
    owner: z.object({ id: z.string(), name: z.string().nullable() }),
    predecessor: z
      .object({ summary: z.string().nullable(), wakeComment: z.string().nullable() })
      .nullable(),
  }),
  async execute(_inputData, { requestContext }) {
    const auth = runAuth(requestContext);
    console.log(`📋 [getRunContext] loading`);
    const { data } = await authenticatedTrpcQuery("mastra.getRunContext", auth);
    return data;
  },
});

export const reportProgressTool = createTool({
  id: "report-progress",
  description:
    "Post a one-line progress note to the run's transcript (visible to your owner only). Use it when you move to a new phase of the work — e.g. 'Searching the CRM for venue contacts'. Not a comment: nobody is notified.",
  inputSchema: z.object({
    text: z.string().min(1).max(500).describe("One line, present tense, what you are doing now."),
  }),
  outputSchema: z.object({ ok: z.literal(true) }),
  async execute(inputData, { requestContext }) {
    const auth = runAuth(requestContext);
    await authenticatedTrpcCall("mastra.reportProgress", { text: inputData.text }, auth);
    return { ok: true as const };
  },
});

export const commentOnActionTool = createTool({
  id: "comment-on-action",
  description:
    "Post a comment on the action you are working on, as yourself. Everyone with access to the action sees it and mentioned people are notified — use `@[Name](userId)` markup to mention someone (ids come from get-run-context). Use it for findings worth a permanent record or to hand something to a person. To ask your owner a question that pauses the run, use ask-owner instead.",
  inputSchema: z.object({
    markdown: z.string().min(1).describe("The comment body, Markdown."),
  }),
  outputSchema: z.object({ commentId: z.string() }),
  async execute(inputData, { requestContext }) {
    const auth = runAuth(requestContext);
    console.log(`💬 [commentOnAction] ${inputData.markdown.length} chars`);
    const { data } = await authenticatedTrpcCall(
      "mastra.commentOnAction",
      { markdown: inputData.markdown },
      auth,
    );
    return data;
  },
});

export const reassignActionTool = createTool({
  id: "reassign-action",
  description:
    "Add a person or another Assistant as an assignee of this action (ids come from get-run-context's members). Assigning another Assistant starts its own run. Say why in a comment first so the new assignee has context. You stay assigned; finish your run afterwards.",
  inputSchema: z.object({
    userId: z.string().describe("The member's user id from get-run-context."),
  }),
  outputSchema: z.object({
    assigned: z.object({ id: z.string(), name: z.string().nullable(), isAgent: z.boolean() }),
  }),
  async execute(inputData, { requestContext }) {
    const auth = runAuth(requestContext);
    console.log(`👉 [reassignAction] userId=${inputData.userId}`);
    const { data } = await authenticatedTrpcCall(
      "mastra.reassignAction",
      { userId: inputData.userId },
      auth,
    );
    return data;
  },
});

export const askOwnerTool = createTool({
  id: "ask-owner",
  description:
    "Ask your owner a question you cannot answer yourself and PAUSE the run. Posts a comment on the action that mentions your owner and moves the run to waiting-on-owner. When they reply, a new run resumes with the thread so far. Because the run ends here, this must be your LAST call: do not call finish-run after it, and do not keep working — stop immediately and end your turn.",
  inputSchema: z.object({
    question: z
      .string()
      .min(1)
      .describe("The question, with enough context that the owner can answer from their inbox without opening anything else."),
  }),
  outputSchema: z.object({
    stop: z.literal(true),
    status: z.literal("WAITING_ON_OWNER"),
    message: z.string(),
  }),
  async execute(inputData, { requestContext }) {
    const auth = runAuth(requestContext);
    console.log(`🙋 [askOwner] ${inputData.question.length} chars`);
    await authenticatedTrpcCall("mastra.askOwner", { question: inputData.question }, auth);
    return {
      stop: true as const,
      status: "WAITING_ON_OWNER" as const,
      message:
        "Your question was posted and the run is now waiting on your owner. Stop here: make no further tool calls and end your turn. A new run will resume when they reply.",
    };
  },
});

export const finishRunTool = createTool({
  id: "finish-run",
  description:
    "Finish this run. Call it exactly once, as your last action, with a summary written for everyone who can see the action (it is public — the requester, the owner and their teammates all read it) and whether the action is ready for the owner to close. Never mark the action complete yourself; the owner confirms from their inbox.",
  inputSchema: z.object({
    summary: z
      .string()
      .min(1)
      .describe("What you did, found, or delegated, in a few sentences. Public — write it knowing teammates will read it."),
    readyToClose: z
      .boolean()
      .describe("true when the action's work is done and the owner only needs to confirm; false when follow-up is still needed."),
  }),
  outputSchema: z.object({
    finished: z.literal(true),
  }),
  async execute(inputData, { requestContext }) {
    const auth = runAuth(requestContext);
    console.log(`🏁 [finishRun] readyToClose=${inputData.readyToClose}`);
    await authenticatedTrpcCall(
      "mastra.finishRun",
      { summary: inputData.summary, readyToClose: inputData.readyToClose },
      auth,
    );
    return { finished: true as const };
  },
});

/** The run tools, keyed as they appear on `assistantRunTools`. */
export const runTools = {
  getRunContextTool,
  reportProgressTool,
  commentOnActionTool,
  reassignActionTool,
  askOwnerTool,
  finishRunTool,
};
