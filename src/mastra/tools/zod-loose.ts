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

/**
 * Tolerant string-array input schemas for tool parameters.
 *
 * Models routinely emit a `string[]` field as a comma-string (`"investor,
 * advisor"`) or a JSON-string array (`'["investor","advisor"]'`) instead of a
 * native array. A bare `z.array(z.string())` rejects both. `toStringArray`
 * accepts a native array (pass through), a JSON-string array (parse), or a
 * comma-string (split on commas + optional whitespace, trim, and drop empties
 * so an empty string becomes an empty array).
 */
const toStringArray = (v: unknown): unknown => {
  if (Array.isArray(v)) return v;
  if (typeof v === "string") {
    const s = v.trim();
    if (s === "") return [];
    if (s.startsWith("[")) {
      try {
        const parsed: unknown = JSON.parse(s);
        if (Array.isArray(parsed)) return parsed;
      } catch {
        // not valid JSON — fall through to comma-splitting
      }
    }
    return s
      .split(/,\s*/)
      .map((x) => x.trim())
      .filter((x) => x !== "");
  }
  return v; // fall through — inner z.array() rejects anything unexpected
};

export const looseStringArray = (
  inner: z.ZodArray<z.ZodString> = z.array(z.string()),
): z.ZodEffects<z.ZodArray<z.ZodString>, string[], string[]> =>
  z.preprocess(toStringArray, inner) as z.ZodEffects<
    z.ZodArray<z.ZodString>,
    string[],
    string[]
  >;

/**
 * Tolerant `z.array(z.enum())` input. Splits the comma/JSON-string shapes the
 * same way as {@link looseStringArray}, then runs each element through the enum
 * normalizer ({@link normalizeEnumValue}) so near-miss members coerce to
 * canonical. Any element that still can't be mapped is left unchanged, so the
 * inner `z.array(z.enum())` fails loud — coerce to preserve intent, never invent.
 */
export const looseEnumArray = <U extends string, T extends Readonly<[U, ...U[]]>>(
  values: T,
) => {
  const inner = z.array(z.enum(values));
  return z.preprocess((v) => {
    const arr = toStringArray(v);
    return Array.isArray(arr) ? arr.map((el) => normalizeEnumValue(values, el)) : arr;
  }, inner) as z.ZodEffects<typeof inner, z.infer<typeof inner>, z.infer<typeof inner>>;
};

/**
 * Tolerant date-range resolution for tool parameters.
 *
 * Models invent argument names and shapes for date ranges: observed 2026-06-11,
 * Zoe called get-calendar-events-in-range with `{ startDate: "2026-06-10",
 * endDate: "2026-06-10" }` against a schema requiring `timeMin`/`timeMax` ISO
 * datetimes — the validation error burned the turn and the model reported a
 * fake "backend" failure to the user instead of retrying.
 *
 * Tools should declare BOTH canonical fields and aliases as optional strings
 * in their inputSchema (so the JSON schema the model sees stays a plain
 * object), then call `resolveDateRange` in execute. It:
 *  - maps `startDate`/`endDate` aliases onto `timeMin`/`timeMax`
 *  - expands date-only values (`YYYY-MM-DD`) to UTC day boundaries
 *  - normalizes any parseable datetime (incl. `+02:00` offsets, which the
 *    backend's `z.string().datetime()` would reject) to canonical UTC ISO
 *  - throws a model-actionable error when the range is missing or unparseable
 */

const DATE_ONLY = /^\d{4}-\d{2}-\d{2}$/;

export function normalizeDateTime(value: string, boundary: "start" | "end"): string {
  const s = value.trim();
  const expanded = DATE_ONLY.test(s)
    ? `${s}T${boundary === "start" ? "00:00:00.000" : "23:59:59.999"}Z`
    : s;
  const parsed = new Date(expanded);
  if (Number.isNaN(parsed.getTime())) {
    throw new Error(
      `Could not parse "${value}" as a date. Use ISO 8601 datetime (e.g. "2026-06-10T09:00:00Z") or a date-only "YYYY-MM-DD".`
    );
  }
  return parsed.toISOString();
}

export interface LooseDateRangeInput {
  timeMin?: string;
  timeMax?: string;
  startDate?: string;
  endDate?: string;
}

export function resolveDateRange(input: LooseDateRangeInput): { timeMin: string; timeMax: string } {
  // Treat a blank/whitespace string as absent so an empty `timeMin` doesn't
  // shadow a valid `startDate` alias (`??` would keep the empty string).
  const blankToUndef = (v?: string) => (v && v.trim() !== "" ? v : undefined);
  const rawMin = blankToUndef(input.timeMin) ?? blankToUndef(input.startDate);
  const rawMax = blankToUndef(input.timeMax) ?? blankToUndef(input.endDate);
  if (!rawMin || !rawMax) {
    throw new Error(
      'Date range required: provide "timeMin" and "timeMax" as ISO 8601 datetimes or date-only "YYYY-MM-DD" values.'
    );
  }
  return {
    timeMin: normalizeDateTime(rawMin, "start"),
    timeMax: normalizeDateTime(rawMax, "end"),
  };
}
