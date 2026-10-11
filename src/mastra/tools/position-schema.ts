import { z } from "zod";

/**
 * A Position as the app sends it (Exponential ADR-0068, Agent PRD D8): the
 * one shape shared by list-assignable-members and get-run-context, so the two
 * cannot drift. Validated loosely — a null or missing title/remit from an
 * older app build becomes "" rather than failing the whole tool output.
 */
export const positionSummarySchema = z.object({
  id: z.string(),
  title: z.string().nullish().transform((v) => v ?? ""),
  remit: z.string().nullish().transform((v) => v ?? ""),
  notAccountableFor: z.string().nullish().transform((v) => v ?? null),
});

export type PositionSummary = z.infer<typeof positionSummarySchema>;
