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
} = await import('./index.js');

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
