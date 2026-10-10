import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { ImportPositionsResult } from './routing-tools.js';

// Mock the authenticated tRPC transport so no network call is made.
const authenticatedTrpcCall = vi.fn();
vi.mock('../utils/authenticated-fetch.js', () => ({
  authenticatedTrpcCall: (...args: unknown[]) => authenticatedTrpcCall(...args),
  authenticatedTrpcQuery: vi.fn(),
}));

const {
  importPositionsTool,
  importPositionsInputSchema,
  importPositionsOutputSchema,
  toImportManyPayload,
} = await import('./routing-tools.js');

/**
 * `import-positions` (Exponential ADR-0068, Agent PRD D10): Zoe's draft-and-
 * confirm import of a roles document. The tool is a thin, honest pass-through
 * to the app's `position.importMany` — dry run and real run alike — with the
 * workspace from the chat context and the app's refusals turned into
 * instructions the model can act on.
 */

function makeRequestContext(overrides: Record<string, string> = {}) {
  return new Map<string, string>([
    ['authToken', 'token-123'],
    ['userId', 'james'],
    ['workspaceId', 'ws-clear'],
    ...Object.entries(overrides),
  ]);
}

const ctx = (requestContext: Map<string, string> = makeRequestContext()) => ({ requestContext }) as never;

/** Rows as Zoe drafts them from the CLEAR roles table. */
const ROWS = [
  {
    title: 'Travel researcher',
    remit: 'Trips, venues, hotels and itineraries.',
    notAccountableFor: 'Booking or paying for anything.',
    holderUserIds: ['aria'],
  },
  { title: 'Delivery lead', remit: 'Delivery plans, milestones and progress reporting.', holderUserIds: ['andi'] },
];

async function runImport(input: unknown, context = ctx()): Promise<ImportPositionsResult> {
  const parsed = importPositionsInputSchema.parse(input);
  return (await importPositionsTool.execute!(parsed, context)) as ImportPositionsResult;
}

const PLAN = {
  written: false,
  results: [
    { title: 'Travel researcher', outcome: 'create', notAccountableFor: 'Booking or paying for anything.', holderUserIds: ['aria'] },
    { title: 'Delivery Lead', outcome: 'update', notAccountableFor: 'Hiring.', holderUserIds: ['sam', 'andi'] },
  ],
};

describe('importPositionsTool', () => {
  beforeEach(() => authenticatedTrpcCall.mockReset());

  it('has the id the prompt names', () => {
    expect(importPositionsTool.id).toBe('import-positions');
  });

  it('passes a dry run through to position.importMany as the user, with the workspace from context', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: PLAN });

    const result = await runImport({ dryRun: true, positions: ROWS });

    expect(authenticatedTrpcCall).toHaveBeenCalledTimes(1);
    expect(authenticatedTrpcCall).toHaveBeenCalledWith(
      'position.importMany',
      {
        workspaceId: 'ws-clear',
        dryRun: true,
        positions: [
          {
            title: 'Travel researcher',
            remit: 'Trips, venues, hotels and itineraries.',
            notAccountableFor: 'Booking or paying for anything.',
            holderUserIds: ['aria'],
          },
          // No notAccountableFor key at all: an update keeps the stored value.
          { title: 'Delivery lead', remit: 'Delivery plans, milestones and progress reporting.', holderUserIds: ['andi'] },
        ],
      },
      expect.objectContaining({ authToken: 'token-123', userId: 'james' }),
    );
    expect(result).toEqual({
      written: false,
      created: 1,
      updated: 1,
      results: PLAN.results,
    });
    expect(importPositionsOutputSchema.safeParse(result).success).toBe(true);
  });

  it('passes a real run through and reports written from the app', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { ...PLAN, written: true } });

    const result = await runImport({ dryRun: false, positions: ROWS });

    expect((authenticatedTrpcCall.mock.lastCall![1] as { dryRun: boolean }).dryRun).toBe(false);
    expect(result.written).toBe(true);
    expect(result).toMatchObject({ created: 1, updated: 1 });
  });

  it('never reports written unless the app says so', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: { results: PLAN.results } });
    expect((await runImport({ dryRun: false, positions: ROWS })).written).toBe(false);
    authenticatedTrpcCall.mockResolvedValue({ data: null });
    expect(await runImport({ dryRun: false, positions: ROWS })).toEqual({ written: false, created: 0, updated: 0, results: [] });
  });

  it('accepts the stringified booleans and comma-string ids models emit', async () => {
    authenticatedTrpcCall.mockResolvedValue({ data: PLAN });
    await runImport({
      dryRun: 'true',
      positions: [{ title: 'Travel researcher', remit: 'Trips.', holderUserIds: 'aria, andi' }],
    });
    const payload = authenticatedTrpcCall.mock.lastCall![1] as { dryRun: unknown; positions: { holderUserIds: string[] }[] };
    expect(payload.dryRun).toBe(true);
    expect(payload.positions[0]!.holderUserIds).toEqual(['aria', 'andi']);
    // "false" must not coerce to true.
    expect(importPositionsInputSchema.parse({ dryRun: 'false', positions: ROWS }).dryRun).toBe(false);
  });

  it('leaves a holder-less row with no holders, and de-duplicates repeated ids', () => {
    const input = importPositionsInputSchema.parse({
      dryRun: true,
      positions: [
        { title: 'Funder relations', remit: 'Funder reporting.' },
        { title: 'Ops', remit: 'Office admin.', holderUserIds: ['andi', 'andi'] },
      ],
    });
    const payload = toImportManyPayload('ws-clear', input);
    expect(payload.positions.map((p) => p.holderUserIds)).toEqual([[], ['andi']]);
  });

  it('keeps the stored "not accountable for" on null or omitted, and clears it only on ""', () => {
    const input = importPositionsInputSchema.parse({
      dryRun: true,
      positions: [
        { title: 'A', remit: 'a', notAccountableFor: null },
        { title: 'B', remit: 'b' },
        { title: 'C', remit: 'c', notAccountableFor: '' },
        { title: 'D', remit: 'd', notAccountableFor: '  Hiring.  ' },
      ],
    });
    const rows = toImportManyPayload('ws-clear', input).positions;
    expect('notAccountableFor' in rows[0]!).toBe(false);
    expect('notAccountableFor' in rows[1]!).toBe(false);
    expect(rows[2]!.notAccountableFor).toBe('');
    expect(rows[3]!.notAccountableFor).toBe('Hiring.');
  });

  it('enforces the app\'s row limits before calling it', () => {
    const row = { title: 'T', remit: 'r', holderUserIds: [] };
    expect(importPositionsInputSchema.safeParse({ dryRun: true, positions: [] }).success).toBe(false);
    expect(
      importPositionsInputSchema.safeParse({ dryRun: true, positions: Array.from({ length: 51 }, (_, i) => ({ ...row, title: `T${i}` })) }).success,
    ).toBe(false);
    expect(importPositionsInputSchema.safeParse({ dryRun: true, positions: [{ ...row, title: '   ' }] }).success).toBe(false);
    expect(importPositionsInputSchema.safeParse({ dryRun: true, positions: [{ ...row, title: 'x'.repeat(81) }] }).success).toBe(false);
    expect(importPositionsInputSchema.safeParse({ dryRun: true, positions: [{ ...row, remit: '' }] }).success).toBe(false);
    expect(importPositionsInputSchema.safeParse({ dryRun: true, positions: [{ ...row, remit: 'r'.repeat(2001) }] }).success).toBe(false);
    expect(
      importPositionsInputSchema.safeParse({ dryRun: true, positions: [{ ...row, holderUserIds: Array.from({ length: 51 }, (_, i) => `u${i}`) }] }).success,
    ).toBe(false);
    // dryRun is required: there is no default that could write by accident.
    expect(importPositionsInputSchema.safeParse({ positions: [row] }).success).toBe(false);
  });

  const NOT_FOUND = () => new Error('Request failed: 404 Not Found - {"error":{"json":{"message":"Member not found in this workspace","data":{"code":"NOT_FOUND"}}}}');
  const BAD_REQUEST = () =>
    new Error('Request failed: 400 Bad Request - {"error":{"json":{"message":"\\"Travel researcher\\" appears more than once in this import","data":{"code":"BAD_REQUEST"}}}}');

  it('turns a holder NOT_FOUND into "nothing written, check the roster, ask the user"', async () => {
    authenticatedTrpcCall.mockRejectedValueOnce(NOT_FOUND());
    const error = await runImport({ dryRun: true, positions: ROWS }).catch((e: Error) => e);
    expect(String(error)).toMatch(/^Error: NOT_FOUND: one of the holder ids is not a member of this workspace/);
    expect(String(error)).toMatch(/Nothing was written/);
    expect(String(error)).toMatch(/list-assignable-members/);
    expect(String(error)).toMatch(/ask the user/);
    expect(String(error)).toMatch(/never substitute a guessed id/);
    expect(authenticatedTrpcCall).toHaveBeenCalledTimes(1);
  });

  it('turns a BAD_REQUEST into "nothing written", with the app\'s reason and ask-the-user guidance', async () => {
    authenticatedTrpcCall.mockRejectedValueOnce(BAD_REQUEST());
    const error = await runImport({ dryRun: true, positions: ROWS }).catch((e: Error) => e);
    expect(String(error)).toMatch(/^Error: BAD_REQUEST: the app refused this import/);
    expect(String(error)).toMatch(/appears more than once in this import/);
    expect(String(error)).toMatch(/Nothing was written/);
    expect(String(error)).toMatch(/ask the user/);
  });

  it('tells the model only an owner or admin can import on FORBIDDEN', async () => {
    authenticatedTrpcCall.mockRejectedValueOnce(new Error('Request failed: 403 Forbidden - {"code":"FORBIDDEN"}'));
    await expect(runImport({ dryRun: true, positions: ROWS })).rejects.toThrow(
      /FORBIDDEN: only a workspace owner or admin can import Positions\. Nothing was written\. Tell the user an owner or admin/,
    );
  });

  it('asks for a fresh dry run on CONFLICT', async () => {
    authenticatedTrpcCall.mockRejectedValueOnce(new Error('Request failed: 409 Conflict - {"code":"CONFLICT"}'));
    await expect(runImport({ dryRun: false, positions: ROWS })).rejects.toThrow(
      /CONFLICT[\s\S]*Nothing was written[\s\S]*Run the dry run again and show the user the new plan before writing/,
    );
  });

  it('says the import is unavailable when the app build has no position.importMany', async () => {
    authenticatedTrpcCall.mockRejectedValueOnce(
      new Error('Request failed: 404 Not Found - No "mutation"-procedure on path "position.importMany"'),
    );
    const error = await runImport({ dryRun: true, positions: ROWS }).catch((e: Error) => e);
    expect(String(error)).toMatch(/cannot import Positions yet/);
    expect(String(error)).not.toMatch(/NOT_FOUND: one of the holder ids/);
  });

  it('passes other failures through unchanged', async () => {
    authenticatedTrpcCall.mockRejectedValueOnce(new Error('Request failed: 500 Internal Server Error - boom'));
    await expect(runImport({ dryRun: true, positions: ROWS })).rejects.toThrow(/boom/);
  });

  it('refuses without a workspace in context (blank counts as none), and without a token', async () => {
    for (const workspaceId of [undefined, '', '  ']) {
      const rc = makeRequestContext();
      if (workspaceId === undefined) rc.delete('workspaceId');
      else rc.set('workspaceId', workspaceId);
      await expect(runImport({ dryRun: true, positions: ROWS }, ctx(rc))).rejects.toThrow(
        /No workspace in this chat\. Nothing was written/,
      );
    }
    await expect(runImport({ dryRun: true, positions: ROWS }, ctx(new Map()))).rejects.toThrow(/authentication token/i);
    expect(authenticatedTrpcCall).not.toHaveBeenCalled();
  });

  it('takes no credential or workspace in its input', () => {
    const keys = Object.keys((importPositionsTool.inputSchema as unknown as { shape: Record<string, unknown> }).shape);
    expect(keys.sort()).toEqual(['dryRun', 'positions']);
  });

  it('mandates draft-and-confirm in its description', () => {
    const d = importPositionsTool.description;
    expect(d).toMatch(/call list-assignable-members and match each named holder to exactly one member by name — never guess an id/);
    expect(d).toMatch(/name you cannot match is left out and listed as "no member found"/);
    expect(d).toMatch(/call this tool with `dryRun: true`/);
    expect(d).toMatch(/Position · Remit \(summary\) · Not accountable for · Holders \(names\) · create\/update/);
    expect(d).toMatch(/ask ONE yes\/no for the whole import/);
    expect(d).toMatch(/only after an explicit yes, call again with `dryRun: false` and exactly the rows you showed/);
    expect(d).toMatch(/If the user changes anything, dry-run again/);
    expect(d).toMatch(/holders are only ever added — an import never removes anyone/);
    expect(d).toMatch(/`written` true means saved[\s\S]*false means nothing was saved/);
    expect(d).toMatch(/FORBIDDEN means only a workspace owner or admin can import/);
  });
});
