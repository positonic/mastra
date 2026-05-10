import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";
import { asAppContext } from "../types/request-context.js";

// ──────────────────────────────────────────────────────────────────────────────
// Meeting Context Tools
//
// Ported from one2b's meeting-context-agent. These tools call exponential's
// knowledgeChunk and transcriptionSessionParticipant routers via tRPC.
//
// IMPORTANT: Embedding generation, chunking, and vector storage are handled
// entirely server-side by knowledgeChunk.ingestTranscription on the
// exponential side. This module never touches embeddings directly — that was
// one2b's old Voyage/Jina path and is now replaced by the server pipeline.
//
// Workspace allowlisting is enforced at the agent registration layer
// (MASTRA_ONE2B_AGENTS_ENABLED in mastra/index.ts) and by tRPC procedures
// themselves (workspaceId is required and authorized server-side).
// ──────────────────────────────────────────────────────────────────────────────

// ─── Tool A: Ingest Transcript ────────────────────────────────────

interface IngestTranscriptionResult {
  chunksCreated: number;
  transcriptionSessionId: string;
  embeddingProvider: string;
  embeddingModel: string;
  embeddingDim: number;
}

export const ingestTranscriptTool = createTool({
  id: "ingest-transcript",
  description:
    "Chunk and vectorize a meeting transcript for semantic search. Accepts a transcriptionSessionId. The exponential server handles all chunking, embedding generation, and vector storage; this tool just kicks off the pipeline and reports counts back.",
  inputSchema: z.object({
    transcriptionSessionId: z
      .string()
      .describe("The exponential TranscriptionSession ID to ingest"),
  }),
  outputSchema: z.object({
    chunksCreated: z.number(),
    embeddingProvider: z.string(),
    embeddingModel: z.string(),
    embeddingDim: z.number(),
    summary: z.string(),
  }),
  execute: async (inputData, ctx) => {
    const requestContext = asAppContext(ctx.requestContext);
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");
    const workspaceId = requestContext?.get("workspaceId");

    if (!authToken) {
      throw new Error("No authentication token available in request context");
    }
    if (!workspaceId) {
      throw new Error(
        "No workspaceId available in request context — agent must be invoked with a workspace scope",
      );
    }

    console.log(
      `📥 [ingestTranscript] Ingesting transcription ${inputData.transcriptionSessionId} into workspace ${workspaceId}`,
    );

    const { data: result } =
      await authenticatedTrpcCall<IngestTranscriptionResult>(
        "knowledgeChunk.ingestTranscription",
        {
          transcriptionSessionId: inputData.transcriptionSessionId,
          workspaceId,
        },
        { authToken, sessionId, userId },
      );

    const chunksCreated = result?.chunksCreated ?? 0;
    const embeddingProvider = result?.embeddingProvider ?? "unknown";
    const embeddingModel = result?.embeddingModel ?? "unknown";
    const embeddingDim = result?.embeddingDim ?? 0;

    const summary =
      `Created ${chunksCreated} chunk${chunksCreated === 1 ? "" : "s"} ` +
      `from transcript ${inputData.transcriptionSessionId} ` +
      `using ${embeddingProvider}/${embeddingModel} (${embeddingDim}d)`;

    console.log(`✅ [ingestTranscript] ${summary}`);

    return {
      chunksCreated,
      embeddingProvider,
      embeddingModel,
      embeddingDim,
      summary,
    };
  },
});

// ─── Tool B: Search Context ───────────────────────────────────────

interface SemanticSearchResult {
  id: string;
  content: string;
  sourceType: string;
  sourceId: string;
  similarity: number;
  speakerName?: string | null;
  speakerEmail?: string | null;
  startTimeMs?: number | null;
  endTimeMs?: number | null;
  meetingTitle?: string | null;
  meetingDate?: string | Date | null;
}

export const searchContextTool = createTool({
  id: "search-context",
  description:
    "Search the meeting knowledge base using semantic similarity. Returns relevant transcript sections with meeting metadata, speaker info, and timestamps. Use this to find historical context about topics, decisions, or discussions.",
  inputSchema: z.object({
    query: z.string().describe("Natural language search query"),
    limit: z.number().min(1).max(50).default(10),
    participantEmail: z
      .string()
      .email()
      .optional()
      .describe(
        "Filter results to chunks from meetings this email attended. Note: this is a 'transcript-attended' filter (passes if the participant attended the meeting), not a 'speaker-spoke' filter (chunks where they specifically spoke).",
      ),
    sourceType: z
      .enum(["transcription", "document", "resource"])
      .optional()
      .describe("Restrict search to a specific source type"),
  }),
  outputSchema: z.array(
    z.object({
      content: z.string(),
      meetingTitle: z.string().nullable(),
      meetingDate: z.string().nullable(),
      speakerName: z.string().nullable(),
      speakerEmail: z.string().nullable(),
      similarity: z.number(),
      startTimeMs: z.number().nullable(),
    }),
  ),
  execute: async (inputData, ctx) => {
    const requestContext = asAppContext(ctx.requestContext);
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");
    const workspaceId = requestContext?.get("workspaceId");

    if (!authToken) {
      throw new Error("No authentication token available in request context");
    }
    if (!workspaceId) {
      throw new Error("No workspaceId available in request context");
    }

    // Zod .default() leaves `limit` typed as optional at compile time even
    // though it's always populated at runtime — normalize once here so the
    // rest of the function can rely on a concrete number.
    const requestedLimit = inputData.limit ?? 10;

    // Note: the server-side participantEmail filter is "transcript-attended"
    // (passes chunks from meetings the participant attended via a workspace-
    // scoped EXISTS join), not "speaker-spoke" (chunks where they specifically
    // spoke). This matches the documented semantic of
    // knowledgeChunk.semanticSearch.
    const { data } = await authenticatedTrpcCall<SemanticSearchResult[]>(
      "knowledgeChunk.semanticSearch",
      {
        query: inputData.query,
        workspaceId,
        sourceType: inputData.sourceType,
        participantEmail: inputData.participantEmail,
        limit: requestedLimit,
      },
      { authToken, sessionId, userId },
    );

    const records = Array.isArray(data) ? data : [];

    return records.map((r) => {
      const meetingDate: string | null =
        r.meetingDate instanceof Date
          ? r.meetingDate.toISOString()
          : ((r.meetingDate as string | null | undefined) ?? null);

      return {
        content: r.content,
        meetingTitle: r.meetingTitle ?? null,
        meetingDate,
        speakerName: r.speakerName ?? null,
        speakerEmail: r.speakerEmail ?? null,
        similarity: Number(r.similarity ?? 0),
        startTimeMs:
          typeof r.startTimeMs === "number" ? r.startTimeMs : null,
      };
    });
  },
});

// ─── Tool C: Get Participant History ──────────────────────────────

interface ParticipantHistoryResponse {
  participant: {
    email: string;
    name: string | null;
    isWorkspaceMember: boolean;
    userId: string | null;
    meetingCount: number;
  };
  recentMeetings: Array<{
    transcriptionSessionId: string;
    title: string | null;
    meetingDate: string | Date | null;
    isHost: boolean;
    speakerLabel: string | null;
    summary: string | null;
  }>;
}

export const getParticipantHistoryTool = createTool({
  id: "get-participant-history",
  description:
    "Get meeting history and profile for a specific participant by email. Returns their workspace membership status, total meeting count, and a list of recent meetings they joined (with titles, dates, host flag, and summary).",
  inputSchema: z.object({
    email: z.string().email().describe("Participant email address"),
    limit: z.number().min(1).max(50).default(10),
  }),
  outputSchema: z.object({
    profile: z.object({
      email: z.string(),
      name: z.string().nullable(),
      isWorkspaceMember: z.boolean(),
      meetingCount: z.number(),
    }),
    recentMeetings: z.array(
      z.object({
        transcriptionSessionId: z.string(),
        title: z.string().nullable(),
        meetingDate: z.string().nullable(),
        isHost: z.boolean(),
        summary: z.string().nullable(),
      }),
    ),
  }),
  execute: async (inputData, ctx) => {
    const requestContext = asAppContext(ctx.requestContext);
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");
    const workspaceId = requestContext?.get("workspaceId");

    if (!authToken) {
      throw new Error("No authentication token available in request context");
    }
    if (!workspaceId) {
      throw new Error("No workspaceId available in request context");
    }

    const { data } = await authenticatedTrpcCall<ParticipantHistoryResponse>(
      "transcriptionSessionParticipant.getHistory",
      {
        email: inputData.email,
        workspaceId,
        limit: inputData.limit,
      },
      { authToken, sessionId, userId },
    );

    if (!data?.participant) {
      // Defensive default — surface an empty profile rather than throwing
      // so the agent can keep composing a brief even when a participant
      // has no recorded history yet.
      return {
        profile: {
          email: inputData.email,
          name: null,
          isWorkspaceMember: false,
          meetingCount: 0,
        },
        recentMeetings: [],
      };
    }

    return {
      profile: {
        email: data.participant.email,
        name: data.participant.name ?? null,
        isWorkspaceMember: Boolean(data.participant.isWorkspaceMember),
        meetingCount: data.participant.meetingCount ?? 0,
      },
      recentMeetings: (data.recentMeetings ?? []).map((m) => {
        const meetingDate: string | null =
          m.meetingDate instanceof Date
            ? m.meetingDate.toISOString()
            : ((m.meetingDate as string | null | undefined) ?? null);

        return {
          transcriptionSessionId: m.transcriptionSessionId,
          title: m.title ?? null,
          meetingDate,
          isHost: Boolean(m.isHost),
          summary: m.summary ?? null,
        };
      }),
    };
  },
});

// ─── Tool D: Get Meeting Action Items ─────────────────────────────
// We re-export the existing getActionItemsTool from action-items-tools.ts
// rather than duplicate logic. The meeting-context-agent imports it
// directly (see meeting-context-agent.ts). Keeping this comment as a
// breadcrumb for future maintainers — there's no fourth tool object in
// this file by design.
