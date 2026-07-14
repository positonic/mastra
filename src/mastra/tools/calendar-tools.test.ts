import { describe, it, expect } from 'vitest';

// Regression for the Zoe "retrieving calendar events failed" bug.
//
// The exponential tRPC calendar endpoints return events whose optional fields
// (location, description, and the unused one of date/dateTime) arrive on the
// wire as `null` — `undefined` is serialized to `null` through tRPC/superjson.
// The tools' outputSchema declared these as `.optional()` (string | undefined),
// which REJECTS `null`, so Mastra's tool-output validation threw on every real
// calendar response even though the backend returned HTTP 200 with valid data.
//
// These tests assert the tool outputSchemas accept the real null-bearing
// payloads (both timed and all-day events).
const {
  getCalendarEventsTool,
  getTodayCalendarEventsTool,
  getUpcomingCalendarEventsTool,
  getCalendarEventsInRangeTool,
  createCalendarEventTool,
} = await import('./index.js');
const { normalizeDateTime } = await import('./zod-loose.js');

describe('calendar tool outputSchemas tolerate null wire fields', () => {
  it('get-today-calendar-events accepts timed + all-day events with null fields', () => {
    const payload = {
      events: [
        {
          id: 'e1',
          summary: 'Daily: CLEAR',
          start: { dateTime: '2026-06-16T10:00:00+02:00', date: null },
          end: { dateTime: '2026-06-16T10:15:00+02:00', date: null },
          location: null,
          attendees: null,
          provider: 'google',
        },
        {
          id: 'e2',
          summary: 'All-day offsite',
          start: { dateTime: null, date: '2026-06-17' },
          end: { dateTime: null, date: '2026-06-18' },
          location: 'Berlin',
          attendees: [{ email: 'a@b.com' }],
          provider: 'google',
        },
      ],
      date: '2026-06-16T08:00:00.000Z',
    };
    expect(() => getTodayCalendarEventsTool.outputSchema!.parse(payload)).not.toThrow();
  });

  it('get-calendar-events (flat) accepts null location/description/status/htmlLink', () => {
    const payload = {
      events: [
        {
          id: 'e1',
          summary: 'Daily: CLEAR',
          description: null,
          start: '2026-06-16T10:00:00+02:00',
          end: '2026-06-16T10:15:00+02:00',
          location: null,
          attendees: ['a@b.com'],
          htmlLink: null,
          status: null,
        },
      ],
      calendarConnected: true,
    };
    expect(() => getCalendarEventsTool.outputSchema!.parse(payload)).not.toThrow();
  });

  it('get-upcoming-calendar-events accepts null fields', () => {
    const payload = {
      events: [
        {
          id: 'e1',
          summary: 'Standup',
          start: { dateTime: '2026-06-17T09:00:00+02:00', date: null },
          end: { dateTime: '2026-06-17T09:15:00+02:00', date: null },
          location: null,
          provider: 'google',
        },
      ],
      days: 7,
    };
    expect(() => getUpcomingCalendarEventsTool.outputSchema!.parse(payload)).not.toThrow();
  });

  it('get-calendar-events-in-range accepts null fields', () => {
    const payload = {
      events: [
        {
          id: 'e1',
          summary: 'Review',
          description: null,
          start: { dateTime: '2026-06-18T14:00:00+02:00', date: null },
          end: { dateTime: '2026-06-18T15:00:00+02:00', date: null },
          location: null,
          attendees: null,
          calendarId: null,
          calendarName: null,
          provider: 'google',
        },
      ],
    };
    expect(() => getCalendarEventsInRangeTool.outputSchema!.parse(payload)).not.toThrow();
  });
});

// Regression for the Pyro "create calendar event" bug (2026-07-14): the model
// passed `attendees` in a non-canonical shape (bare/array-of email strings),
// the tool's strict `z.array(z.object({ email }))` inputSchema rejected it at
// the input-validation layer, and after 4 failed attempts the agent gave up
// and told the user to create the event by hand. The inputSchema must accept
// every attendee shape models actually emit and normalize it to the canonical
// `[{ email, displayName? }]` the backend expects.
describe('create-calendar-event tolerates model-emitted attendee shapes', () => {
  const base = {
    summary: 'Splinternet grant',
    startDateTime: '2026-07-14T12:00:00Z',
    endDateTime: '2026-07-14T12:30:00Z',
    userConfirmed: true,
  };

  const parseInput = (value: unknown): { attendees?: Array<{ email: string; displayName?: string }> } =>
    (createCalendarEventTool.inputSchema as unknown as { parse: (v: unknown) => { attendees?: Array<{ email: string; displayName?: string }> } }).parse(value);

  it('accepts the canonical array of attendee objects unchanged', () => {
    const parsed = parseInput({ ...base, attendees: [{ email: 'andi@syntro.fi', displayName: 'Andy' }] });
    expect(parsed.attendees).toEqual([{ email: 'andi@syntro.fi', displayName: 'Andy' }]);
  });

  it('accepts an array of bare email strings', () => {
    const parsed = parseInput({ ...base, attendees: ['andi@syntro.fi'] });
    expect(parsed.attendees).toEqual([{ email: 'andi@syntro.fi' }]);
  });

  it('accepts a single email string', () => {
    const parsed = parseInput({ ...base, attendees: 'andi@syntro.fi' });
    expect(parsed.attendees).toEqual([{ email: 'andi@syntro.fi' }]);
  });

  it('accepts a comma-string of emails', () => {
    const parsed = parseInput({ ...base, attendees: 'andi@syntro.fi, james@syntro.fi' });
    expect(parsed.attendees).toEqual([{ email: 'andi@syntro.fi' }, { email: 'james@syntro.fi' }]);
  });

  it('accepts "Name <email>" strings and extracts the display name', () => {
    const parsed = parseInput({ ...base, attendees: ['Andy <andi@syntro.fi>'] });
    expect(parsed.attendees).toEqual([{ email: 'andi@syntro.fi', displayName: 'Andy' }]);
  });

  it('accepts a single attendee object not wrapped in an array', () => {
    const parsed = parseInput({ ...base, attendees: { email: 'andi@syntro.fi' } });
    expect(parsed.attendees).toEqual([{ email: 'andi@syntro.fi' }]);
  });

  it('treats null attendees as an empty list', () => {
    const parsed = parseInput({ ...base, attendees: null });
    expect(parsed.attendees).toEqual([]);
  });

  it('still rejects garbage that is not an attendee (fail loud, never invent)', () => {
    expect(() => parseInput({ ...base, attendees: [42] })).toThrow();
    expect(() => parseInput({ ...base, attendees: ['not-an-email'] })).toThrow();
  });
});

// The backend's createCalendarEvent validates start/end with
// z.string().datetime(), which rejects offset timestamps ("+01:00") and
// date-only strings. The tool normalizes with normalizeDateTime before
// sending so any valid instant survives the trip.
describe('create-calendar-event datetime normalization', () => {
  it('converts offset timestamps to canonical UTC ISO', () => {
    expect(normalizeDateTime('2026-07-14T12:00:00+01:00', 'start')).toBe('2026-07-14T11:00:00.000Z');
  });

  it('passes through UTC timestamps unchanged (canonicalized)', () => {
    expect(normalizeDateTime('2026-07-14T12:00:00Z', 'start')).toBe('2026-07-14T12:00:00.000Z');
  });

  it('throws a model-actionable error on unparseable input', () => {
    expect(() => normalizeDateTime('noon-ish', 'start')).toThrow(/ISO 8601/);
  });
});
