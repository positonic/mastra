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

/**
 * Tolerant enum input schemas for tool parameters.
 *
 * Models emit near-miss enum members constantly: `"In Progress"` for
 * `IN_PROGRESS`, `"Binance"` for `binance`, `"1st priority"` for
 * `"1st Priority"`. A bare `z.enum()` rejects all of these and the model burns
 * a retry (or, with `.catch(default)`, the value is silently replaced with a
 * wrong one — a data-integrity bug, see ADR-0001).
 *
 * `looseEnum` normalizes obvious near-misses to the canonical member, then
 * validates. The match is done on a separator/case-insensitive key
 * (lowercased, non-alphanumerics stripped), and we return the enum's OWN
 * canonical spelling — so this works for `UPPER_SNAKE`, lowercase, and
 * human-cased (`"1st Priority"`) enums alike, NOT just blind uppercasing.
 *
 * A value that can't be normalized to a member is returned UNCHANGED, so the
 * inner `z.enum()` fails loud with the real Zod error listing valid values.
 * That is correct self-correction (the model retries), not a bug — we coerce
 * to preserve intent, we never invent it. Do NOT add `.catch(default)`: that
 * substitutes a wrong value silently (the guard test bans it).
 */
const enumKey = (s: string): string => s.toLowerCase().replace(/[^a-z0-9]+/g, "");

export const normalizeEnumValue = (
  values: readonly string[],
  v: unknown,
): unknown => {
  if (typeof v !== "string") return v;
  if (values.includes(v)) return v; // already canonical
  const key = enumKey(v);
  if (key === "") return v;
  // First canonical member whose normalized key matches. Real enums here have
  // no key collisions; if two ever did, first-declared wins (deterministic).
  return values.find((val) => enumKey(val) === key) ?? v; // unmappable → fail loud
};

// `values` is passed straight to `z.enum` so its overloads drive literal-tuple
// inference (re-specifying the generics here widens the members to `string`).
// Output AND input are pinned to the inner enum's literal union — same white
// lie as the scalar helpers: by the time `inputData` is read the value has been
// normalized-and-validated into a real member, which is what call sites need
// (e.g. indexing a Record keyed by the union).
export const looseEnum = <U extends string, T extends Readonly<[U, ...U[]]>>(
  values: T,
) => {
  const inner = z.enum(values);
  return z.preprocess(
    (v) => normalizeEnumValue(values, v),
    inner,
  ) as z.ZodEffects<typeof inner, z.infer<typeof inner>, z.infer<typeof inner>>;
};
