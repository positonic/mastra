# Robust tool inputs: coerce to preserve intent, never invent it

## Context

Agent tools (called by Zoe et al. from the exponential chat surface) repeatedly
fail at the AI-SDK input-validation layer — *before* `execute()` runs — when the
model emits plausible-but-wrong argument shapes. Three recurring shapes account
for nearly all of it:

1. **Stringified scalars** — `"7"`, `"false"` where the schema wants a native
   number/boolean (Haiku especially). A bare `z.number()`/`z.boolean()` rejects
   them, the model burns a retry, and often gives up.
2. **Near-miss enum members** — `"In Progress"` for `IN_PROGRESS`, `"Binance"`
   for `binance`. Case/separator/casing drift against `z.enum()`.
3. **Comma-strings for arrays** — `"investor, advisor"` (or a JSON-string
   `'["investor","advisor"]'`) where the schema wants `string[]`.

`zod-loose.ts` (`looseNumber`/`looseBoolean`) already fixed (1) for *some*
fields, but it was applied unevenly — 7 of 13 tool files don't even import it.

## Decision

**Coerce model-facing tool inputs to preserve the model's intent; never invent
intent.** Concretely:

- **Scalars** — every model-facing `z.number()`/`z.boolean()` input (including
  *required* fields and confirmation gates like `userConfirmed`) is wrapped in
  `looseNumber()`/`looseBoolean()`. Output schemas are exempt (not
  model-produced). String fields are untouched, so no ID/zip/leading-zero
  coercion risk — only fields *already declared* numeric/boolean are affected.
- **Enums** — a normalizing `preprocess` maps obvious near-misses to the
  canonical member (trim + uppercase + spaces/hyphens→underscores, or the
  enum's own casing). A value that genuinely can't be normalized **fails loud**
  so the model retries against the Zod error listing valid values.
- **Arrays** — `looseStringArray()` accepts an array, a JSON-string array, or a
  comma-string (trim, drop empties). `z.array(z.enum())` composes split +
  the enum normalizer. Per-element `.email()` on read **filter** fields is
  relaxed to plain string (a bad email matches nothing — harmless).
- A **keystone guard test** walks every exported tool's `inputSchema` and fails
  the build on any unwrapped model-facing scalar/array/enum, turning the
  convention from tribal knowledge into an enforced invariant. The guard only
  enforces a class once that class has been swept, so CI is never red.

## Considered options

- **`.catch(default)` on enums** — *rejected.* It substitutes a wrong value
  silently: `status: "In Progress"` → caught → ticket lands in `BACKLOG` with no
  error. That converts a visible retry failure into a silent data-integrity bug
  — strictly worse, especially for write tools. Silent defaults are banned on
  write tools.
- **`z.coerce.boolean()`** — *rejected.* `Boolean("false") === true` silently
  inverts the flag. `looseBoolean` parses the string contents instead.
- **Per-field exception lists in the guard** — *rejected.* Exceptions are where
  the next person quietly reintroduces the bug. One blanket, mechanically
  checkable rule.

## Landing rule (consequences)

This repo had no CI; the guard is inert without it. So the work lands in order:

1. **PR 0** — add CI (`npm ci && npm run test`) gating every PR. The full suite
   is sub-second and offline (frozen-prefix evals, no API keys), so it gates
   everything with no nightly split.
2. **PR 1** — keystone guard (scalars) + scalar sweep + expanded
   `tool-input-coercion.test.ts`. Mechanical and intent-preserving, safe as one
   PR because the existing harness proves both directions (and that garbage
   still throws).
3. **PR 2…N** — enum normalization, then arrays (each carries per-field
   judgment, so smaller PRs). The guard grows to cover each class as it's swept.

The unifying principle for reviewers: **coerce to preserve intent; never invent
intent.** Stringified scalar → scalar preserves; near-miss → canonical
preserves; near-miss → arbitrary default invents.
