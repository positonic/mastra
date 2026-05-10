import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";
import { asAppContext } from "../types/request-context.js";

// ──────────────────────────────────────────────────────────────────────────────
// Document Tools
//
// Ported from one2b's document-tracker-agent. These tools call exponential's
// document tRPC router (workspace-scoped, member-checked) and the existing
// knowledgeChunk.semanticSearch procedure.
//
// Drive integration is intentionally NOT included here — it will land in a
// follow-up PR.
// ──────────────────────────────────────────────────────────────────────────────

interface IngestResultShape {
  documentId: string;
  chunksCreated: number;
  ingestionStatus: string;
}

export const ingestDocumentTool = createTool({
  id: "ingest-document",
  description:
    "Ingest a document into exponential's workspace knowledge base from base64 binary, a URL, or raw text. Stores the original (when applicable), extracts text, chunks it, and embeds it for semantic search. Use sourceType to tag where the document originated (upload, meeting, whatsapp, email, api).",
  inputSchema: z.object({
    source: z
      .enum(["base64", "url", "text"])
      .describe(
        "How the document content is being supplied. base64 = encoded file binary; url = remote URL to fetch; text = inline raw text",
      ),
    title: z.string().min(1).describe("Human-readable document title"),
    description: z.string().optional().describe("Optional description"),
    sourceType: z
      .string()
      .default("upload")
      .describe(
        "Where the document came from. Free-form. Common values: upload, meeting, whatsapp, email, api",
      ),
    sourceUri: z
      .string()
      .optional()
      .describe("Optional reference URI for provenance (e.g. message link)"),
    // base64 source fields
    base64Data: z
      .string()
      .optional()
      .describe("Required when source = base64. Base64-encoded file content"),
    filename: z
      .string()
      .optional()
      .describe("Required when source = base64. Original filename"),
    mimeType: z
      .string()
      .optional()
      .describe(
        "MIME type. Required when source = base64; optional hint when source = url",
      ),
    // url source fields
    url: z
      .string()
      .url()
      .optional()
      .describe("Required when source = url. Remote URL to fetch"),
    // text source fields
    text: z
      .string()
      .optional()
      .describe("Required when source = text. Raw text content"),
  }),
  outputSchema: z.object({
    documentId: z.string(),
    chunksCreated: z.number(),
    ingestionStatus: z.string(),
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

    // Build the discriminated payload that document.ingest expects.
    // The tRPC procedure infers shape from `source`, so missing required
    // siblings should be caught early here with a clear error.
    const basePayload: Record<string, unknown> = {
      workspaceId,
      title: inputData.title,
      description: inputData.description,
      sourceType: inputData.sourceType,
      sourceUri: inputData.sourceUri,
      source: inputData.source,
    };

    if (inputData.source === "base64") {
      if (!inputData.base64Data || !inputData.filename || !inputData.mimeType) {
        throw new Error(
          "ingestDocumentTool: base64 source requires base64Data, filename, and mimeType",
        );
      }
      basePayload.base64Data = inputData.base64Data;
      basePayload.filename = inputData.filename;
      basePayload.mimeType = inputData.mimeType;
    } else if (inputData.source === "url") {
      if (!inputData.url) {
        throw new Error("ingestDocumentTool: url source requires url");
      }
      basePayload.url = inputData.url;
      if (inputData.mimeType) {
        basePayload.mimeType = inputData.mimeType;
      }
    } else {
      // text
      if (!inputData.text) {
        throw new Error("ingestDocumentTool: text source requires text");
      }
      basePayload.text = inputData.text;
    }

    console.log(
      `📥 [ingestDocument] Ingesting "${inputData.title}" (source=${inputData.source}, sourceType=${inputData.sourceType}) into workspace ${workspaceId}`,
    );

    const { data: result } = await authenticatedTrpcCall<IngestResultShape>(
      "document.ingest",
      basePayload,
      { authToken, sessionId, userId },
    );

    if (!result?.documentId) {
      throw new Error("document.ingest returned no documentId");
    }

    const summary =
      `Ingested "${inputData.title}" (${result.chunksCreated} chunk` +
      `${result.chunksCreated === 1 ? "" : "s"} created, status: ${result.ingestionStatus})`;

    console.log(`✅ [ingestDocument] ${summary}`);

    return {
      documentId: result.documentId,
      chunksCreated: result.chunksCreated,
      ingestionStatus: result.ingestionStatus,
      summary,
    };
  },
});

interface SemanticSearchHit {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  id?: string | null;
  content?: string | null;
  similarity?: number | null;
  sourceType?: string | null;
  sourceId?: string | null;
  sourceTitle?: string | null;
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  sourceMeta?: Record<string, any> | null;
}

interface SemanticSearchResponse {
  results?: SemanticSearchHit[] | null;
}

export const searchDocumentsTool = createTool({
  id: "search-documents",
  description:
    "Semantic search across documents in the current workspace's knowledge base. Returns relevant text chunks with similarity scores. Use this when the user asks to find a document by topic or content.",
  inputSchema: z.object({
    query: z.string().min(1).describe("Natural language search query"),
    limit: z.number().min(1).max(50).default(10).describe("Max results"),
    similarityThreshold: z
      .number()
      .min(0)
      .max(1)
      .default(0.3)
      .describe("Minimum cosine similarity (0-1). Lower = broader matches."),
  }),
  outputSchema: z.array(
    z.object({
      documentId: z.string().nullable(),
      content: z.string(),
      similarity: z.number(),
      sourceTitle: z.string().optional(),
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      sourceMeta: z.record(z.any()).optional(),
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

    const { data } = await authenticatedTrpcCall<SemanticSearchResponse>(
      "knowledgeChunk.semanticSearch",
      {
        workspaceId,
        query: inputData.query,
        sourceType: "document",
        limit: inputData.limit,
        similarityThreshold: inputData.similarityThreshold,
      },
      { authToken, sessionId, userId },
    );

    const hits = Array.isArray(data?.results) ? data!.results! : [];

    return hits.map((hit) => ({
      // For document chunks, sourceId is the document id.
      documentId: hit.sourceId ?? null,
      content: hit.content ?? "",
      similarity: typeof hit.similarity === "number" ? hit.similarity : 0,
      sourceTitle: hit.sourceTitle ?? undefined,
      sourceMeta: hit.sourceMeta ?? undefined,
    }));
  },
});

interface DocumentRecordShape {
  id: string;
  title: string;
  description?: string | null;
  sourceType: string;
  mimeType?: string | null;
  byteSize?: number | null;
  ingestionStatus: string;
  chunkCount?: number | null;
  createdAt: string | Date;
}

interface DocumentListResponse {
  documents?: DocumentRecordShape[] | null;
  nextCursor?: string | null;
}

export const getDocumentsTool = createTool({
  id: "get-documents",
  description:
    "List documents in the current workspace, optionally filtered by sourceType or ingestionStatus. Returns metadata only (no chunk content).",
  inputSchema: z.object({
    sourceType: z
      .string()
      .optional()
      .describe(
        "Filter by source type (e.g. upload, meeting, whatsapp, email, api)",
      ),
    ingestionStatus: z
      .enum(["pending", "processing", "completed", "failed"])
      .optional()
      .describe("Filter by ingestion status"),
    limit: z.number().min(1).max(100).default(20),
  }),
  outputSchema: z.array(
    z.object({
      id: z.string(),
      title: z.string(),
      description: z.string().nullable(),
      sourceType: z.string(),
      mimeType: z.string().nullable(),
      byteSize: z.number().nullable(),
      ingestionStatus: z.string(),
      chunkCount: z.number().nullable(),
      createdAt: z.string(),
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

    const { data } = await authenticatedTrpcCall<DocumentListResponse>(
      "document.list",
      {
        workspaceId,
        sourceType: inputData.sourceType,
        ingestionStatus: inputData.ingestionStatus,
        limit: inputData.limit,
      },
      { authToken, sessionId, userId },
    );

    const docs = Array.isArray(data?.documents) ? data!.documents! : [];

    return docs.map((d) => {
      const createdAt: string =
        d.createdAt instanceof Date
          ? d.createdAt.toISOString()
          : (d.createdAt ?? new Date(0).toISOString());

      return {
        id: d.id,
        title: d.title,
        description: d.description ?? null,
        sourceType: d.sourceType,
        mimeType: d.mimeType ?? null,
        byteSize: typeof d.byteSize === "number" ? d.byteSize : null,
        ingestionStatus: d.ingestionStatus,
        chunkCount: typeof d.chunkCount === "number" ? d.chunkCount : null,
        createdAt,
      };
    });
  },
});

interface DownloadUrlResponse {
  url: string;
  expiresAt: string | Date;
}

export const getDocumentDownloadUrlTool = createTool({
  id: "get-document-download-url",
  description:
    "Get a short-lived presigned URL to download the original file for a document. Returns null-equivalent error if the document has no associated file (e.g. text-only ingestion).",
  inputSchema: z.object({
    documentId: z.string().describe("The document id"),
  }),
  outputSchema: z.object({
    url: z.string(),
    expiresAt: z.string(),
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

    const { data } = await authenticatedTrpcCall<DownloadUrlResponse>(
      "document.getDownloadUrl",
      { workspaceId, id: inputData.documentId },
      { authToken, sessionId, userId },
    );

    if (!data?.url) {
      throw new Error(
        `document.getDownloadUrl returned no URL for ${inputData.documentId}`,
      );
    }

    const expiresAt: string =
      data.expiresAt instanceof Date
        ? data.expiresAt.toISOString()
        : (data.expiresAt ?? new Date().toISOString());

    return {
      url: data.url,
      expiresAt,
    };
  },
});

interface DeleteResponse {
  deleted: boolean;
}

export const deleteDocumentTool = createTool({
  id: "delete-document",
  description:
    "Permanently delete a document from the workspace knowledge base, including its stored file (if any) and all embedded chunks. Always confirm with the user before calling.",
  inputSchema: z.object({
    documentId: z.string().describe("The document id to delete"),
  }),
  outputSchema: z.object({
    deleted: z.boolean(),
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

    const { data } = await authenticatedTrpcCall<DeleteResponse>(
      "document.delete",
      { workspaceId, id: inputData.documentId },
      { authToken, sessionId, userId },
    );

    return {
      deleted: Boolean(data?.deleted),
    };
  },
});
