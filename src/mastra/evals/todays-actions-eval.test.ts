import { describe, it, expect } from 'vitest';
import { readFileSync } from 'fs';
import { casesFileSchema, buildFrozenPrefix } from './replay.js';

/**
 * Eval case for the "Pay Malte" deflection (ADR-0034 in the exponential repo,
 * ticket mega.zenith). On /today the user asked Zoe to "mark the Malte ones
 * done" and she deflected ("which project? should I search your Notion?") — a
 * Grounded + No-deflection contract violation whose root cause was a missing
 * discovery tool (get-todays-actions, shipped in lean.shard).
 *
 * The case lives as a committed fixture so it can be fed to the live runner:
 *   npm run eval-replay -- src/mastra/evals/fixtures/todays-actions-cases.json
 * (the contract judge runs exponential-side; the runner only regenerates the
 * turn and records tool intents). Against the pre-fix brain the candidate had
 * no get-todays-actions tool and deflected (red); against the post-fix brain —
 * with the tool registered on assistantTools — it calls get-todays-actions
 * (green). This test is the deterministic, CI-safe guard: it keeps the fixture
 * schema-valid and pins the expectation so the no-deflection contract can't
 * silently rot.
 */
const raw = readFileSync(
  new URL('./fixtures/todays-actions-cases.json', import.meta.url),
  'utf8',
);

describe('todays-actions eval cases', () => {
  it('is a schema-valid cases file the replay runner can consume', () => {
    const parsed = casesFileSchema.safeParse(JSON.parse(raw));
    expect(parsed.success).toBe(true);
  });

  it('encodes "call get-todays-actions, do not deflect" as the expectation', () => {
    const { cases } = casesFileSchema.parse(JSON.parse(raw));
    const malte = cases.find(
      (c) => c.id === 'todays-actions-mark-malte-done-no-deflection',
    );
    expect(malte).toBeDefined();
    // Must require the discovery tool...
    expect(malte!.expectation).toMatch(/get-todays-actions/);
    // ...and forbid deflection (asking which project / searching Notion).
    expect(malte!.expectation).toMatch(/not deflect|never ask|which project/i);
  });

  it('frozen prefix surfaces the "mark the Malte ones done" request for the candidate to answer', () => {
    const { cases } = casesFileSchema.parse(JSON.parse(raw));
    const malte = cases.find(
      (c) => c.id === 'todays-actions-mark-malte-done-no-deflection',
    )!;
    const prefix = buildFrozenPrefix(malte);
    expect(prefix.at(-1)!.role).toBe('user');
    expect(prefix.at(-1)!.content).toMatch(/malte/i);
  });
});
