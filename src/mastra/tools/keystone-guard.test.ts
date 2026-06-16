import { describe, it, expect, vi } from 'vitest';

// ── Keystone guard ──────────────────────────────────────────────────────────
//
// Walks EVERY exported tool's `inputSchema` and fails the build on any
// model-facing scalar that isn't wrapped in the tolerant `zod-loose` helpers.
// This turns the "coerce to preserve intent" convention (ADR-0001) from tribal
// knowledge into a mechanically-enforced invariant: the next unwrapped
// `z.number()` / `z.boolean()` someone adds to a tool input fails CI.
//
// Scope grows one class at a time, in lock-step with the sweeps:
//   • scalars  (z.number / z.boolean)  — this ticket (deep.rune)
//   • enums    (z.enum)                — zippy.acorn
//   • arrays   (z.array)               — wet.llama
// The guard only enforces a class once that class has been swept, so CI is
// never red. Output schemas are exempt — they are produced by our code, never
// by the model.
//
// Introspection reaches into zod v3 `_def` internals (typeName, innerType,
// schema, effect, shape, type, options). That is intentional and pinned to the
// repo's zod version; if zod's internals change, this guard is the canary.

vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: vi.fn(),
  authenticatedTrpcQuery: vi.fn(),
}));

// Auto-discover every tool module. Glob picks up `*-tools.ts`; index.ts holds
// the remaining tools (and re-exports many of the others — deduped by identity
// below, so a tool is only checked once no matter how many modules export it).
// `import.meta.glob` is a Vitest/Vite build-time macro and MUST appear as a
// literal call for Vite to statically transform it (aliasing it breaks the
// transform). tsc lacks the `vite/client` ambient types for it; CI runs vitest,
// not tsc, so we silence the one type error here rather than pull in those
// ambient types globally.
// @ts-expect-error -- import.meta.glob is a Vite macro; no ambient type loaded
const toolModules = import.meta.glob('./*-tools.ts', { eager: true }) as Record<
  string,
  Record<string, unknown>
>;
toolModules['./index.ts'] = (await import('./index.js')) as Record<string, unknown>;

interface DiscoveredTool {
  id: string;
  exportName: string;
  module: string;
  inputSchema: any;
}

function discoverTools(): DiscoveredTool[] {
  const seen = new Set<unknown>();
  const tools: DiscoveredTool[] = [];
  for (const [module, mod] of Object.entries(toolModules)) {
    for (const [exportName, value] of Object.entries(mod)) {
      const v = value as any;
      const isTool =
        v &&
        typeof v === 'object' &&
        typeof v.id === 'string' &&
        v.inputSchema?._def?.typeName === 'ZodObject';
      if (!isTool || seen.has(v)) continue;
      seen.add(v);
      tools.push({ id: v.id, exportName, module, inputSchema: v.inputSchema });
    }
  }
  return tools;
}

// Strip the value-level wrappers that don't change the underlying type so the
// walk can reason about the core node (and so `looseX().optional().default()`
// is recognised as wrapped).
function unwrap(schema: any): any {
  let cur = schema;
  while (cur?._def) {
    const tn = cur._def.typeName;
    if (tn === 'ZodOptional' || tn === 'ZodNullable' || tn === 'ZodDefault') {
      cur = cur._def.innerType;
      continue;
    }
    break;
  }
  return cur;
}

// A node is "loose-wrapped" iff it sits behind a `z.preprocess(...)` (what
// looseNumber/looseBoolean/looseEnum produce) whose inner type is in the set.
function isLooseWrapped(schema: any, innerTypes: string[]): boolean {
  const u = unwrap(schema);
  if (u?._def?.typeName === 'ZodEffects' && u._def.effect?.type === 'preprocess') {
    return innerTypes.includes(unwrap(u._def.schema)?._def?.typeName);
  }
  return false;
}
const isLooseWrappedScalar = (s: any) => isLooseWrapped(s, ['ZodNumber', 'ZodBoolean']);
const isLooseWrappedEnum = (s: any) => isLooseWrapped(s, ['ZodEnum']);
// looseStringArray/looseEnumArray = preprocess over a ZodArray whose element is
// a string or enum.
function isLooseWrappedArray(schema: any): boolean {
  const u = unwrap(schema);
  if (u?._def?.typeName === 'ZodEffects' && u._def.effect?.type === 'preprocess') {
    const innerArr = unwrap(u._def.schema);
    if (innerArr?._def?.typeName !== 'ZodArray') return false;
    const el = unwrap(innerArr._def.type)?._def?.typeName;
    return el === 'ZodString' || el === 'ZodEnum';
  }
  return false;
}

// Does the optional/default/nullable/catch wrapper chain over this field
// contain a `.catch()` guarding a model-facing enum/scalar? `.catch(default)`
// silently substitutes a wrong value (ADR-0001 bans it on write tools) — and
// it works on bare OR loose-wrapped cores, so detect it on the chain directly.
function hasCatchOverGuardedClass(schema: any): boolean {
  let cur = schema;
  let sawCatch = false;
  while (cur?._def) {
    const tn = cur._def.typeName;
    if (tn === 'ZodCatch') {
      sawCatch = true;
      cur = cur._def.innerType;
      continue;
    }
    if (tn === 'ZodOptional' || tn === 'ZodNullable' || tn === 'ZodDefault') {
      cur = cur._def.innerType;
      continue;
    }
    break;
  }
  if (!sawCatch) return false;
  const core = cur?._def?.typeName;
  if (core === 'ZodNumber' || core === 'ZodBoolean' || core === 'ZodEnum') return true;
  // a loose-wrapped core (preprocess) also counts
  return core === 'ZodEffects' && cur._def.effect?.type === 'preprocess';
}

interface Violation {
  path: string;
  reason: string;
}

// Recursively collect every model-facing input that breaks a swept convention:
//   • bare z.number()/z.boolean()              (scalars — deep.rune)
//   • bare z.enum()                            (enums   — zippy.acorn)
//   • a `.catch()` over any of those           (banned  — zippy.acorn)
//   • bare z.array(z.string())/z.array(z.enum()) (arrays — wet.llama)
// Enums/strings nested inside an object that happens to live in an array (e.g.
// `tickets[].status`) are still walked as ordinary fields. Output schemas are
// never walked (not model-produced).
function findViolations(schema: any, path: string, out: Violation[]): void {
  if (hasCatchOverGuardedClass(schema)) {
    out.push({ path, reason: '.catch() is banned on model-facing enums/scalars — use looseEnum/looseNumber/looseBoolean (normalize-then-fail, never silent-default)' });
    return;
  }
  if (isLooseWrappedScalar(schema) || isLooseWrappedEnum(schema) || isLooseWrappedArray(schema)) {
    return; // properly wrapped
  }
  const u = unwrap(schema);
  if (!u?._def) return;
  const tn = u._def.typeName;

  if (tn === 'ZodNumber' || tn === 'ZodBoolean') {
    out.push({ path, reason: `bare ${tn} — wrap in looseNumber()/looseBoolean()` });
    return;
  }
  if (tn === 'ZodEnum') {
    out.push({ path, reason: 'bare ZodEnum — wrap in looseEnum()' });
    return;
  }
  if (tn === 'ZodObject') {
    const shape = typeof u._def.shape === 'function' ? u._def.shape() : u.shape;
    for (const key of Object.keys(shape)) {
      findViolations(shape[key], `${path}.${key}`, out);
    }
  } else if (tn === 'ZodArray') {
    // A bare array-of-string / array-of-enum must use looseStringArray() /
    // looseEnumArray() (the field itself was not loose-wrapped, else we'd have
    // returned above). Arrays of objects/other are not a string-array class —
    // recurse so their inner fields are still checked.
    const elType = unwrap(u._def.type)?._def?.typeName;
    if (elType === 'ZodString' || elType === 'ZodEnum') {
      out.push({
        path,
        reason:
          elType === 'ZodEnum'
            ? 'bare z.array(z.enum()) — wrap in looseEnumArray([...])'
            : 'bare z.array(z.string()) — wrap in looseStringArray()',
      });
      return;
    }
    findViolations(u._def.type, `${path}[]`, out);
  } else if (tn === 'ZodUnion') {
    (u._def.options ?? []).forEach((opt: any, i: number) =>
      findViolations(opt, `${path}|${i}`, out),
    );
  } else if (tn === 'ZodEffects') {
    // refine/transform (non-preprocess) — descend into the wrapped schema.
    findViolations(u._def.schema, path, out);
  }
}

describe('keystone guard: model-facing inputs must use the zod-loose helpers', () => {
  const tools = discoverTools();

  it('discovers the tool surface (sanity check the glob found tools)', () => {
    expect(tools.length).toBeGreaterThan(40);
  });

  it('every model-facing scalar/enum input is wrapped (and no .catch() on them)', () => {
    const violations: string[] = [];
    for (const tool of tools) {
      const found: Violation[] = [];
      findViolations(tool.inputSchema, tool.exportName, found);
      if (found.length) {
        violations.push(
          `  ${tool.exportName} (${tool.id}) [${tool.module}]\n` +
            found.map((v) => `      ${v.path} — ${v.reason}`).join('\n'),
        );
      }
    }
    if (violations.length) {
      throw new Error(
        `Found ${violations.length} tool(s) with model-facing inputs that bypass the ` +
          `coercion helpers (ADR-0001 — coerce to preserve intent, never invent it).\n` +
          `Scalars → looseNumber()/looseBoolean() (keep .min/.max inside the wrapper).\n` +
          `Enums   → looseEnum([...]) (normalize-then-fail; do NOT use .catch(default)).\n\n` +
          violations.join('\n'),
      );
    }
  });
});
