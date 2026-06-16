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

// A scalar is "loose-wrapped" iff it sits behind a `z.preprocess(...)`
// (what looseNumber/looseBoolean produce) whose inner type is the scalar.
function isLooseWrappedScalar(schema: any): boolean {
  const u = unwrap(schema);
  if (u?._def?.typeName === 'ZodEffects' && u._def.effect?.type === 'preprocess') {
    const inner = unwrap(u._def.schema)?._def?.typeName;
    return inner === 'ZodNumber' || inner === 'ZodBoolean';
  }
  return false;
}

// Recursively collect dotted paths to any bare (unwrapped) scalar input.
function findBareScalars(schema: any, path: string, out: string[]): void {
  if (isLooseWrappedScalar(schema)) return; // properly wrapped — stop here
  const u = unwrap(schema);
  if (!u?._def) return;
  const tn = u._def.typeName;

  if (tn === 'ZodNumber' || tn === 'ZodBoolean') {
    out.push(`${path} (${tn})`);
    return;
  }
  if (tn === 'ZodObject') {
    const shape = typeof u._def.shape === 'function' ? u._def.shape() : u.shape;
    for (const key of Object.keys(shape)) {
      findBareScalars(shape[key], `${path}.${key}`, out);
    }
  } else if (tn === 'ZodArray') {
    findBareScalars(u._def.type, `${path}[]`, out);
  } else if (tn === 'ZodUnion') {
    (u._def.options ?? []).forEach((opt: any, i: number) =>
      findBareScalars(opt, `${path}|${i}`, out),
    );
  } else if (tn === 'ZodEffects') {
    // refine/transform (non-preprocess) — descend into the wrapped schema.
    findBareScalars(u._def.schema, path, out);
  }
}

describe('keystone guard: model-facing scalar inputs must use zod-loose', () => {
  const tools = discoverTools();

  it('discovers the tool surface (sanity check the glob found tools)', () => {
    expect(tools.length).toBeGreaterThan(40);
  });

  it('every model-facing z.number()/z.boolean() input is wrapped in looseNumber()/looseBoolean()', () => {
    const violations: string[] = [];
    for (const tool of tools) {
      const bare: string[] = [];
      findBareScalars(tool.inputSchema, tool.exportName, bare);
      if (bare.length) {
        violations.push(
          `  ${tool.exportName} (${tool.id}) [${tool.module}]\n` +
            bare.map((b) => `      ${b}`).join('\n'),
        );
      }
    }
    if (violations.length) {
      throw new Error(
        `Found ${violations.length} tool(s) with unwrapped model-facing scalar inputs.\n` +
          `Wrap each in looseNumber()/looseBoolean() from ./zod-loose.js — see ADR-0001.\n` +
          `Keep .min()/.max() INSIDE the wrapper, .optional()/.default()/.describe() outside:\n` +
          `  limit: looseNumber(z.number().min(1).max(100)).optional().default(25).describe(...)\n\n` +
          violations.join('\n'),
      );
    }
  });
});
