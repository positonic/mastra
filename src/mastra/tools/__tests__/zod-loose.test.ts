import { describe, expect, it } from "vitest";
import { z } from "zod";

import {
  looseBoolean,
  looseNumber,
  normalizeDateTime,
  resolveDateRange,
} from "../zod-loose.js";

describe("looseBoolean", () => {
  it("accepts native booleans", () => {
    expect(looseBoolean().parse(true)).toBe(true);
    expect(looseBoolean().parse(false)).toBe(false);
  });

  it("parses stringified booleans without inverting", () => {
    expect(looseBoolean().parse("false")).toBe(false);
    expect(looseBoolean().parse("true")).toBe(true);
  });
});

describe("looseNumber", () => {
  it("parses stringified numbers", () => {
    expect(looseNumber().parse("7")).toBe(7);
    expect(looseNumber(z.number().min(1).max(30)).parse("30")).toBe(30);
  });
});

describe("normalizeDateTime", () => {
  it("expands date-only values to UTC day boundaries", () => {
    expect(normalizeDateTime("2026-06-10", "start")).toBe("2026-06-10T00:00:00.000Z");
    expect(normalizeDateTime("2026-06-10", "end")).toBe("2026-06-10T23:59:59.999Z");
  });

  it("passes full ISO UTC datetimes through canonicalized", () => {
    expect(normalizeDateTime("2026-06-10T09:00:00Z", "start")).toBe(
      "2026-06-10T09:00:00.000Z",
    );
  });

  it("converts offset datetimes to UTC (backend rejects offsets)", () => {
    expect(normalizeDateTime("2026-06-10T09:00:00+02:00", "start")).toBe(
      "2026-06-10T07:00:00.000Z",
    );
  });

  it("throws a model-actionable error on garbage", () => {
    expect(() => normalizeDateTime("not-a-date", "start")).toThrow(/Could not parse/);
  });
});

describe("resolveDateRange", () => {
  // The exact failing call observed 2026-06-11: Zoe sent startDate/endDate
  // date-only aliases and the schema's timeMin/timeMax "Required" rejection
  // burned the turn.
  it("accepts the startDate/endDate alias shape the model actually sent", () => {
    expect(
      resolveDateRange({ startDate: "2026-06-10", endDate: "2026-06-10" }),
    ).toEqual({
      timeMin: "2026-06-10T00:00:00.000Z",
      timeMax: "2026-06-10T23:59:59.999Z",
    });
  });

  it("prefers canonical timeMin/timeMax when both shapes are present", () => {
    expect(
      resolveDateRange({
        timeMin: "2026-06-01T00:00:00Z",
        timeMax: "2026-06-02T00:00:00Z",
        startDate: "2099-01-01",
        endDate: "2099-01-02",
      }),
    ).toEqual({
      timeMin: "2026-06-01T00:00:00.000Z",
      timeMax: "2026-06-02T00:00:00.000Z",
    });
  });

  it("expands a one-day date-only range to a non-empty window", () => {
    const { timeMin, timeMax } = resolveDateRange({
      timeMin: "2026-06-10",
      timeMax: "2026-06-10",
    });
    expect(new Date(timeMax).getTime()).toBeGreaterThan(new Date(timeMin).getTime());
  });

  it("throws a clear error when the range is missing", () => {
    expect(() => resolveDateRange({})).toThrow(/timeMin/);
    expect(() => resolveDateRange({ startDate: "2026-06-10" })).toThrow(/timeMax/);
  });
});
