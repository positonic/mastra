import { createTool } from "@mastra/core/tools";
import { z } from "zod";
import { authenticatedTrpcCall } from "../utils/authenticated-fetch.js";
import { asAppContext } from "../types/request-context.js";

// ──────────────────────────────────────────────────────────────────────────────
// Feature Ideation Tools
//
// Conversational entry point (V2) to the SAME feature-ideation path the
// "Ideate features" button uses in exponential (V1). There is exactly ONE
// write path: the tRPC procedure `transcription.generateDraftFeatures`, which
// runs the deterministic ideation service server-side and stores DRAFT
// features awaiting human review.
//
// This tool deliberately does NOT create Features or Tickets itself — doing so
// would fork the write path and bypass the human review card. If you are
// extending this file and reach for create-ticket / any feature-creation
// endpoint: stop. Call the procedure.
// ──────────────────────────────────────────────────────────────────────────────

interface GenerateDraftFeaturesResult {
  success: boolean;
  featuresCreated: number;
  draftCount: number;
  alreadyDrafted: boolean;
  errors: string[];
}

export const ideateFeaturesTool = createTool({
  // The exponential client keys off this exact id to render the draft-feature
  // review card. Do NOT rename it.
  id: "ideate-features",
  description:
    "Turn a MEETING transcript into DRAFT product features for a human to review. Use this when the user asks to ideate, brainstorm, or extract product features/ideas from a meeting or call (e.g. \"ideate features from this meeting\", \"what features come out of that call?\", optionally with a steering hint like \"focus on the ingestion parts\"). It calls exponential's server-side ideation service, which stores the results as DRAFT features only — NOTHING is written to the product backlog until the user accepts them in the review card, so no confirmation is needed before calling. This is NOT how you create actions, tasks, or tickets (use quick-create-action / create-ticket for those), and it does not create features directly. You need the meeting's transcriptionId — resolve it first with get-meeting-transcriptions if the user referred to the meeting by name.",
  inputSchema: z.object({
    transcriptionId: z
      .string()
      .describe(
        "The exponential TranscriptionSession id of the meeting to ideate features from",
      ),
    focus: z
      .string()
      .optional()
      .describe(
        "An optional steering hint from the user, e.g. 'focus on the onboarding parts'. Omit unless the user actually expressed a focus — do not invent one.",
      ),
  }),
  outputSchema: z.object({
    draftCount: z.number(),
    alreadyDrafted: z.boolean(),
    summary: z.string(),
  }),
  execute: async (inputData, ctx) => {
    const requestContext = asAppContext(ctx.requestContext);
    const authToken = requestContext?.get("authToken");
    const sessionId = requestContext?.get("whatsappSession");
    const userId = requestContext?.get("userId");

    if (!authToken) {
      throw new Error("No authentication token available in request context");
    }

    console.log(
      `💡 [ideateFeatures] Generating draft features from transcription ${inputData.transcriptionId}` +
        (inputData.focus ? ` (focus: "${inputData.focus}")` : ""),
    );

    // Access is authorized server-side (the procedure throws BAD_REQUEST /
    // FORBIDDEN / NOT_FOUND). Let those surface as tool errors so the model
    // reports the real reason rather than inventing one.
    const { data } = await authenticatedTrpcCall<GenerateDraftFeaturesResult>(
      "transcription.generateDraftFeatures",
      {
        transcriptionId: inputData.transcriptionId,
        focus: inputData.focus,
      },
      { authToken, sessionId, userId },
    );

    const draftCount = Number(data?.draftCount ?? 0);
    const alreadyDrafted = Boolean(data?.alreadyDrafted);
    const errors = Array.isArray(data?.errors) ? data.errors : [];

    const base = alreadyDrafted
      ? `This meeting already has ${draftCount} draft feature${draftCount === 1 ? "" : "s"} awaiting review — nothing new was generated.`
      : `Generated ${draftCount} draft feature${draftCount === 1 ? "" : "s"} from transcript ${inputData.transcriptionId}` +
        (inputData.focus ? ` with a focus on "${inputData.focus}"` : "") +
        `. They are DRAFTS only — the user must accept them in the review card before anything lands in the product backlog.`;

    const summary =
      errors.length > 0 ? `${base} Reported problems: ${errors.join("; ")}` : base;

    console.log(`✅ [ideateFeatures] ${summary}`);

    return {
      draftCount,
      alreadyDrafted,
      summary,
    };
  },
});
