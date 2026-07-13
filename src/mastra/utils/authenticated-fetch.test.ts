import { describe, it, expect } from 'vitest';
import SuperJSON from 'superjson';
import { unwrapSuperjson } from './authenticated-fetch.js';

// Regression tests for the superjson unwrap in the tRPC transport.
//
// The backend serializes responses with superjson, which encodes `undefined`
// values as `null` in `json` plus an "undefined" annotation in `meta.values`.
// The transport used to drop `meta`, so optional fields the server left unset
// (e.g. a Notion import preview row with no points/priority) arrived as `null`
// and failed the tools' zod output schemas — the "Cycle 11 import preview
// failed because tickets are missing points" incident.

describe('unwrapSuperjson', () => {
  it('restores undefined for annotated nulls inside arrays (import-preview shape)', () => {
    const payload = {
      connected: true,
      preview: [
        { title: 'A', points: undefined, priority: undefined },
        { title: 'B', points: 3, priority: undefined },
        { title: 'C', points: 5, priority: 1 },
      ],
    };
    // Round-trip through real superjson + JSON, exactly like the HTTP boundary.
    const envelope = JSON.parse(JSON.stringify(SuperJSON.serialize(payload)));

    // Sanity: the wire format is the broken-looking one (nulls in json).
    expect(envelope.json.preview[0].points).toBeNull();

    const result = unwrapSuperjson<typeof payload>(envelope);
    expect(result.preview[0].points).toBeUndefined();
    expect(result.preview[0].priority).toBeUndefined();
    expect(result.preview[1].points).toBe(3);
    expect(result.preview[1].priority).toBeUndefined();
    expect(result.preview[2]).toEqual({ title: 'C', points: 5, priority: 1 });
  });

  it('does NOT revive Dates (and other superjson types) — they stay JSON primitives', () => {
    const payload = {
      startDate: new Date('2026-01-01T00:00:00.000Z'),
      dueDate: undefined,
      tags: new Set(['a']),
    };
    const envelope = JSON.parse(JSON.stringify(SuperJSON.serialize(payload)));

    const result = unwrapSuperjson<Record<string, unknown>>(envelope);
    // Tool output schemas declare dates as ISO strings; reviving Date
    // instances here would break every one of them.
    expect(result.startDate).toBe('2026-01-01T00:00:00.000Z');
    expect(result.dueDate).toBeUndefined();
    expect('dueDate' in result).toBe(true);
    expect(result.tags).toEqual(['a']);
  });

  it('handles mixed annotations on sibling paths', () => {
    const payload = {
      items: [{ at: new Date('2026-01-01T00:00:00.000Z'), points: undefined }],
    };
    const envelope = JSON.parse(JSON.stringify(SuperJSON.serialize(payload)));

    const result = unwrapSuperjson<{ items: Array<Record<string, unknown>> }>(envelope);
    expect(result.items[0]!.at).toBe('2026-01-01T00:00:00.000Z');
    expect(result.items[0]!.points).toBeUndefined();
  });

  it('handles a root-level undefined annotation', () => {
    const envelope = JSON.parse(JSON.stringify(SuperJSON.serialize(undefined)));
    expect(envelope).toEqual({ json: null, meta: { values: ['undefined'], v: 1 } });
    expect(unwrapSuperjson(envelope)).toBeUndefined();
  });

  it('respects escaped dots in property names', () => {
    const payload = { 'a.b': { points: undefined } };
    const envelope = JSON.parse(JSON.stringify(SuperJSON.serialize(payload)));
    // superjson escapes the literal dot in the path key; keys must be copied
    // verbatim, never re-parsed by us.
    expect(Object.keys(envelope.meta.values)).toEqual(['a\\.b.points']);

    const result = unwrapSuperjson<Record<string, { points?: number }>>(envelope);
    expect(result['a.b']!.points).toBeUndefined();
  });

  it('returns json as-is when there is no meta', () => {
    expect(unwrapSuperjson({ json: { a: 1, b: null } })).toEqual({ a: 1, b: null });
    expect(unwrapSuperjson({ json: { a: 1 }, meta: {} })).toEqual({ a: 1 });
  });

  it('passes through payloads that are not superjson envelopes', () => {
    expect(unwrapSuperjson({ a: 1 })).toEqual({ a: 1 });
    expect(unwrapSuperjson(null)).toBeNull();
    expect(unwrapSuperjson('plain')).toBe('plain');
  });

  it('preserves explicit nulls the server actually returned', () => {
    const payload = { shortId: null, points: undefined };
    const envelope = JSON.parse(JSON.stringify(SuperJSON.serialize(payload)));

    const result = unwrapSuperjson<Record<string, unknown>>(envelope);
    expect(result.shortId).toBeNull();
    expect(result.points).toBeUndefined();
  });
});

describe('import-notion-cycle-tickets output schema', () => {
  it('accepts preview rows with missing OR null points/priority', async () => {
    const { importNotionCycleTicketsTool } = await import('../tools/ticket-tools.js');
    // Mastra types outputSchema as a StandardSchema; it is a zod schema at runtime.
    const schema = importNotionCycleTicketsTool.outputSchema as unknown as {
      safeParse: (value: unknown) => { success: boolean };
    };

    const result = schema.safeParse({
      connected: true,
      dryRun: true,
      cycle: { notionPageId: 'p1', notionTitle: 'Cycle 11', exponentialCycleId: null },
      totalFound: 2,
      created: [],
      skipped: [],
      failed: [],
      preview: [
        // undefined (fixed transport) and null (any other client) must both pass
        { title: 'A', status: 'BACKLOG', type: 'FEATURE', notionUrl: 'u', labels: [], warnings: [] },
        { title: 'B', status: 'BACKLOG', type: 'BUG', priority: null, points: null, notionUrl: 'u', labels: [], warnings: [] },
      ],
      warnings: [],
    });
    expect(result.success).toBe(true);
  });
});
