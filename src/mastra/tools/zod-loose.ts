import { z } from "zod";

/**
 * Tolerant scalar input schemas for tool parameters.
 *
 * Models — Haiku especially — sometimes emit JSON-stringified scalars
 * (`"false"`, `"7"`) instead of native `false` / `7`. A plain
 * `z.boolean()` / `z.number()` rejects those, Mastra returns a tool
 * input-validation error, and the model burns a full extra round-trip
 * retrying the same call. (Observed: `getAllProjectsTool` fanned out to
 * 3 calls because `includeAll: "false"` kept failing validation.)
 *
 * These helpers preprocess the value into the right type *before*
 * validation, so a stringified scalar is accepted on the first try.
 *
 * IMPORTANT: do NOT replace these with `z.coerce.boolean()`. Coercion
 * uses `Boolean("false")`, which is `true` — it would silently invert
 * the argument. These helpers parse the string contents instead.
 *
 * Pass a constrained inner schema when you need `.min()/.max()` etc.
 * (those live on ZodNumber, not on the ZodEffects this returns):
 *   days: looseNumber(z.number().min(1).max(30)).default(7)
 */

const toBoolean = (v: unknown): unknown => {
  if (typeof v === "boolean") return v;
  if (typeof v === "number") return v !== 0;
  if (typeof v === "string") {
    const s = v.trim().toLowerCase();
    if (s === "true" || s === "1" || s === "yes" || s === "y") return true;
    if (s === "false" || s === "0" || s === "no" || s === "n" || s === "") return false;
  }
  return v; // fall through — inner z.boolean() rejects anything unexpected
};

const toNumber = (v: unknown): unknown => {
  if (typeof v === "number") return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s !== "" && !Number.isNaN(Number(s))) return Number(s);
  }
  return v; // fall through — inner z.number() rejects anything unexpected
};

export const looseBoolean = (inner: z.ZodBoolean = z.boolean()) =>
  z.preprocess(toBoolean, inner);

export const looseNumber = (inner: z.ZodNumber = z.number()) =>
  z.preprocess(toNumber, inner);
