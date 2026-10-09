import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";

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
  finishRunTool,
};
