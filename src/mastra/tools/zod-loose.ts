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
  const rawMin = input.timeMin ?? input.startDate;
  const rawMax = input.timeMax ?? input.endDate;
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
