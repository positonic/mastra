import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcQuery } from "../utils/authenticated-fetch.js";
import { asAppContext } from "../types/request-context.js";

// ──────────────────────────────────────────────────────────────────────────────
// Agent guidance tools (exponential feature "Agent principles: method-aware
// agents", Phase 2, ticket shiny.walnut)
//
// In-app agents (Zoe, the Assistant, Assistant runs) get the same two
// capabilities MCP and CLI agents have, from the same place: the app's
// `agentGuidance` tRPC router (protectedProcedure, deliberately not
// human-only). These tools are thin wrappers; the method text, its version
// and hash, and the assembled scope instructions are all computed by the
// server, never here.
// ──────────────────────────────────────────────────────────────────────────────

/** The server's NOT_FOUND message while no method is visible to the caller. */
export const NO_PUBLISHED_METHOD_MESSAGE = "No published method yet";

function getAuth(ctx: { requestContext?: Parameters<typeof asAppContext>[0] }) {
  const requestContext = asAppContext(ctx.requestContext);
  const authToken = requestContext?.get("authToken");
  const sessionId = requestContext?.get("whatsappSession");
  const userId = requestContext?.get("userId");
  const workspaceId = requestContext?.get("workspaceId");
  if (!authToken) {
    throw new Error("No authentication token available in request context");
  }
  return { authToken, sessionId, userId, workspaceId };
}

const methodDocumentSchema = z.object({
  id: z.string(),
  title: z.string(),
  href: z.string(),
  markdown: z.string(),
});

const methodPayloadSchema = z.object({
  version: z.string(),
  status: z.enum(["draft", "published"]),
  contentHash: z.string(),
  publishedAt: z.string().nullable(),
  canonicalSource: z.object({
    repo: z.string(),
    path: z.string(),
    url: z.string().nullable(),
  }),
  documents: z.array(methodDocumentSchema),
});

type MethodPayload = z.infer<typeof methodPayloadSchema>;

export const getMethodTool = createTool({
  id: "get-method",
  description:
    "Load the Exponential Method: the current method version, its status, content hash, and the text of the method, glossary and agent principles. Call it once per conversation/thread before substantive workspace work, and again only if you have reason to think the version changed — never before every tool call. If it reports no method available, carry on without it.",
  inputSchema: z.object({}),
  outputSchema: z.union([
    methodPayloadSchema.extend({ available: z.literal(true) }),
    z.object({ available: z.literal(false), message: z.string() }),
  ]),
  execute: async (_inputData, ctx) => {
    const { authToken, sessionId, userId, workspaceId } = getAuth(ctx);
    // The workspace lets the server apply its draft-preview rule (a draft is
    // served only inside a preview workspace). tRPC GET input is {"json": ...}.
    const input = JSON.stringify({ json: workspaceId ? { workspaceId } : {} });
    try {
      const { data } = await authenticatedTrpcQuery<MethodPayload>(
        `agentGuidance.method?input=${encodeURIComponent(input)}`,
        { authToken, sessionId, userId },
      );
      return { available: true as const, ...data };
    } catch (error) {
      // No method visible yet (draft, caller outside a preview workspace) is
      // an expected state, not a failure: say so and let the agent proceed.
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(NO_PUBLISHED_METHOD_MESSAGE)) {
        return { available: false as const, message: NO_PUBLISHED_METHOD_MESSAGE };
      }
      throw error;
    }
  },
});
