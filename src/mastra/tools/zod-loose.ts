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

// The explicit return annotations matter. `z.preprocess` is typed against a
// `(v: unknown) => unknown` preprocessor, so its inferred type carries
// `unknown` for BOTH the input and output side. Mastra types a tool's
// `execute(inputData)` from the schema's *input* type, so an unannotated
// looseNumber/looseBoolean field surfaces in `inputData` as `unknown` / `{}`.
// That's invisible until a coerced field is used as a real number/boolean
// (arithmetic, comparisons, typed API params), at which point every such call
// site fails to typecheck.
//
// We pin BOTH generics to the inner scalar type. The runtime is unchanged —
// `.parse()` still accepts anything and coerces the stringified-scalar shapes
// the model emits. The third generic (input) is a deliberate, harmless white
// lie: by the time we read `inputData`, validation has already run and the
// value IS a number/boolean, which is exactly what call sites need.
export const looseBoolean = (
  inner: z.ZodBoolean = z.boolean(),
): z.ZodEffects<z.ZodBoolean, boolean, boolean> =>
  z.preprocess(toBoolean, inner) as z.ZodEffects<z.ZodBoolean, boolean, boolean>;

export const looseNumber = (
  inner: z.ZodNumber = z.number(),
): z.ZodEffects<z.ZodNumber, number, number> =>
  z.preprocess(toNumber, inner) as z.ZodEffects<z.ZodNumber, number, number>;
