import { describe, expect, it } from "vitest";
import {
  buildReportRangeOptions,
  buildSharedReportParams,
  clampReportRangeSelection,
  getReportComparisonBounds,
  getReportRangeBounds,
  isValidReportDate,
  parseReportRangeSearchParams,
  type ReportRange,
  type ReportRangeSelection,
} from "@/lib/reports/report-range";

describe("report range helpers", () => {
  it("parses month, year, and all-time report ranges in Asia/Shanghai", () => {
    const now = new Date("2026-05-17T02:30:00.000Z");

    expect(
      parseReportRangeSearchParams(
        { mode: "unsupported", month: "not-a-month", year: "x" },
        now,
      ),
    ).toEqual({
      mode: "month",
      month: "2026-05",
      year: "2026",
    });

    expect(
      getReportRangeBounds(
        { mode: "month", month: "2026-02", year: "2026" },
        now,
        null,
        "Asia/Shanghai",
      ),
    ).toEqual({
      from: new Date("2026-01-31T16:00:00.000Z"),
      to: new Date("2026-02-28T15:59:59.999Z"),
    });
    expect(
      getReportRangeBounds(
        { mode: "year", month: "2026-05", year: "2025" },
        now,
        null,
        "Asia/Shanghai",
      ),
    ).toEqual({
      from: new Date("2024-12-31T16:00:00.000Z"),
      to: new Date("2025-12-31T15:59:59.999Z"),
    });
    expect(
      getReportRangeBounds(
        { mode: "all", month: "2026-05", year: "2026" },
        now,
        new Date("2024-03-03T19:00:00.000Z"),
        "Asia/Shanghai",
      ),
    ).toEqual({
      from: new Date("2024-03-03T16:00:00.000Z"),
      to: new Date("2026-05-17T15:59:59.999Z"),
    });
  });

  it("builds month and year options from now back to the first transaction month", () => {
    const options = buildReportRangeOptions(
      new Date("2024-03-03T19:00:00.000Z"),
      new Date("2026-05-17T02:30:00.000Z"),
      "Asia/Shanghai",
    );

    expect(options.years).toEqual(["2026", "2025", "2024"]);
    expect(options.months[0]).toBe("2026-05");
    expect(options.months.at(-1)).toBe("2024-03");
    expect(options.months).toHaveLength(27);
  });

  it.each(["2026-05-17T16:00:00.000Z", "2026-06-01T04:00:00.000Z"])(
    "uses today for an all-time range when the first transaction is in the future at %s",
    (firstOccurredAt) => {
      expect(
        getReportRangeBounds(
          { mode: "all", month: "2026-05", year: "2026" },
          new Date("2026-05-17T15:00:00.000Z"),
          new Date(firstOccurredAt),
          "Asia/Shanghai",
        ),
      ).toEqual({
        from: new Date("2026-05-16T16:00:00.000Z"),
        to: new Date("2026-05-17T15:59:59.999Z"),
      });
    },
  );

  it("clamps selected month and year to the available report options", () => {
    const options = {
      months: ["2026-05", "2026-04", "2026-03", "2026-02", "2026-01"],
      years: ["2026"],
    };

    expect(
      clampReportRangeSelection(
        { mode: "month", month: "2025-12", year: "2025" },
        options,
      ),
    ).toEqual({ mode: "month", month: "2026-01", year: "2026" });
    expect(
      clampReportRangeSelection(
        { mode: "year", month: "2026-06", year: "2030" },
        options,
      ),
    ).toEqual({ mode: "year", month: "2026-05", year: "2026" });
  });

  it("ends the current month and year at the end of today in Shanghai", () => {
    const now = new Date("2026-05-17T16:30:00.000Z");

    for (const mode of ["month", "year"] as const) {
      expect(
        getReportRangeBounds(
          { mode, month: "2026-05", year: "2026" },
          now,
          null,
          "Asia/Shanghai",
        ).to,
      ).toEqual(new Date("2026-05-18T15:59:59.999Z"));
    }
  });

  it("covers this month and the preceding two months across a year boundary", () => {
    const now = new Date("2026-01-14T16:00:00.000Z");
    const selection = parseReportRangeSearchParams({ mode: "recent" }, now);

    expect(selection).toEqual({ mode: "recent", month: "2026-01", year: "2026" });
    expect(getReportRangeBounds(selection, now, null, "Asia/Shanghai")).toEqual({
      from: new Date("2025-10-31T16:00:00.000Z"),
      to: new Date("2026-01-15T15:59:59.999Z"),
    });
  });

  it("parses an inclusive custom range and clamps future endpoints to today", () => {
    const now = new Date("2026-05-17T02:30:00.000Z");
    const selection = parseReportRangeSearchParams(
      { mode: "custom", start: "2026-05-01", end: "2026-05-31" },
      now,
    );

    expect(selection).toEqual({
      mode: "custom", month: "2026-05", year: "2026", start: "2026-05-01", end: "2026-05-17",
    });
    expect(getReportRangeBounds(selection, now, null, "Asia/Shanghai")).toEqual({
      from: new Date("2026-04-30T16:00:00.000Z"),
      to: new Date("2026-05-17T15:59:59.999Z"),
    });
    expect(
      parseReportRangeSearchParams({ mode: "custom", start: "2026-06-01", end: "2026-06-30" }, now),
    ).toMatchObject({ mode: "custom", start: "2026-05-17", end: "2026-05-17" });
  });

  it.each([
    ["2026-02-29", "2026-03-01"],
    ["2026-04-31", "2026-05-01"],
    ["2026-5-01", "2026-05-02"],
    ["2026-05-03", "2026-05-02"],
    ["", "2026-05-02"],
    [undefined, undefined],
  ])("falls back to the current month for invalid custom dates %s / %s", (start, end) => {
    expect(
      parseReportRangeSearchParams(
        { mode: "custom", month: "2024-01", year: "2024", start, end },
        new Date("2026-05-17T02:30:00.000Z"),
      ),
    ).toEqual({ mode: "month", month: "2026-05", year: "2026" });
  });

  it("validates real calendar dates including leap days", () => {
    expect(isValidReportDate("2024-02-29")).toBe(true);
    expect(isValidReportDate("2025-02-29")).toBe(false);
    expect(isValidReportDate("2026-04-31")).toBe(false);
    expect(isValidReportDate("2026-01-01T00:00:00Z")).toBe(false);
  });

  it("retains custom endpoints while clamping month and year options", () => {
    expect(
      clampReportRangeSelection(
        { mode: "custom", month: "2024-01", year: "2024", start: "2024-02-29", end: "2024-03-01" },
        { months: ["2026-05"], years: ["2026"] },
      ),
    ).toEqual({ mode: "custom", month: "2026-05", year: "2026", start: "2024-02-29", end: "2024-03-01" });
  });

  it("keeps a custom range before the first recorded transaction", () => {
    const now = new Date("2026-05-17T02:30:00.000Z");
    const firstOccurredAt = new Date("2026-05-03T02:00:00.000Z");
    const selection = clampReportRangeSelection(
      parseReportRangeSearchParams({ mode: "custom", start: "0001-01-01", end: "2026-05-17" }, now),
      buildReportRangeOptions(firstOccurredAt, now, "Asia/Shanghai"),
    );

    expect(selection).toMatchObject({ mode: "custom", start: "0001-01-01", end: "2026-05-17" });
    expect(getReportRangeBounds(selection, now, firstOccurredAt, "Asia/Shanghai")).toEqual({
      from: new Date("0001-01-01T00:00:00.000+08:00"),
      to: new Date("2026-05-17T15:59:59.999Z"),
    });
  });

  it("serializes custom endpoints separately from detail filters", () => {
    const selection: ReportRangeSelection = {
      mode: "custom", month: "2026-05", year: "2026", start: "2026-04-01", end: "2026-05-17",
    };

    expect(buildSharedReportParams(selection).toString()).toBe(
      "mode=custom&month=2026-05&year=2026&start=2026-04-01&end=2026-05-17",
    );
    expect(buildSharedReportParams({ ...selection, mode: "recent" }).toString()).toBe(
      "mode=recent&month=2026-05&year=2026",
    );
  });
});

describe("report comparison ranges", () => {
  function resolveRange(selection: ReportRangeSelection, now: Date): ReportRange {
    return { ...selection, ...getReportRangeBounds(selection, now, null, "Asia/Shanghai") };
  }

  it("clamps March 31 to the last day of February for the previous month", () => {
    const now = new Date("2026-03-31T02:00:00.000Z");
    const range = resolveRange({ mode: "month", month: "2026-03", year: "2026" }, now);

    expect(getReportComparisonBounds(range, "previous", now)).toEqual({
      from: new Date("2026-01-31T16:00:00.000Z"),
      to: new Date("2026-02-28T15:59:59.999Z"),
    });
  });

  it("compares a completed short month with the entire preceding month", () => {
    const now = new Date("2026-05-17T02:00:00.000Z");
    const range = resolveRange({ mode: "month", month: "2026-04", year: "2026" }, now);

    expect(getReportComparisonBounds(range, "previous", now)).toEqual({
      from: new Date("2026-02-28T16:00:00.000Z"),
      to: new Date("2026-03-31T15:59:59.999Z"),
    });
  });

  it("compares an ongoing month with the same day of the previous month", () => {
    const now = new Date("2026-05-16T16:01:00.000Z");
    const range = resolveRange({ mode: "month", month: "2026-05", year: "2026" }, now);

    expect(getReportComparisonBounds(range, "previous", now)).toEqual({
      from: new Date("2026-03-31T16:00:00.000Z"),
      to: new Date("2026-04-17T15:59:59.999Z"),
    });
  });

  it("clamps a leap day to February 28 for last-year comparisons", () => {
    const now = new Date("2024-02-29T02:00:00.000Z");
    const range = resolveRange(
      { mode: "custom", month: "2024-02", year: "2024", start: "2024-02-29", end: "2024-02-29" },
      now,
    );

    expect(getReportComparisonBounds(range, "yearAgo", now)).toEqual({
      from: new Date("2023-02-27T16:00:00.000Z"),
      to: new Date("2023-02-28T15:59:59.999Z"),
    });
  });

  it("compares an ongoing year with the same Shanghai date last year", () => {
    const now = new Date("2024-02-29T02:00:00.000Z");
    const range = resolveRange({ mode: "year", month: "2024-02", year: "2024" }, now);

    expect(getReportComparisonBounds(range, "previous", now)).toEqual({
      from: new Date("2022-12-31T16:00:00.000Z"),
      to: new Date("2023-02-28T15:59:59.999Z"),
    });
  });

  it("compares recent months with the previous three-month group at the same progress", () => {
    const now = new Date("2026-05-17T02:00:00.000Z");
    const range = resolveRange({ mode: "recent", month: "2026-05", year: "2026" }, now);

    expect(getReportComparisonBounds(range, "previous", now)).toEqual({
      from: new Date("2025-11-30T16:00:00.000Z"),
      to: new Date("2026-02-17T15:59:59.999Z"),
    });
  });

  it("uses an adjacent equally long period for an inclusive custom range", () => {
    const now = new Date("2026-05-17T02:00:00.000Z");
    const range = resolveRange(
      { mode: "custom", month: "2026-05", year: "2026", start: "2026-03-01", end: "2026-03-03" },
      now,
    );

    expect(getReportComparisonBounds(range, "previous", now)).toEqual({
      from: new Date("2026-02-25T16:00:00.000Z"),
      to: new Date("2026-02-28T15:59:59.999Z"),
    });
  });

  it("does not invent comparison periods for all-time reports", () => {
    const now = new Date("2026-05-17T02:00:00.000Z");
    const range = resolveRange({ mode: "all", month: "2026-05", year: "2026" }, now);

    expect(getReportComparisonBounds(range, "previous", now)).toBeNull();
    expect(getReportComparisonBounds(range, "yearAgo", now)).toBeNull();
  });

  it.each(["previous", "yearAgo"] as const)("omits %s comparisons that begin before year 0001", (kind) => {
    const now = new Date("2026-05-17T02:00:00.000Z");
    const range = resolveRange(
      { mode: "custom", month: "2026-05", year: "2026", start: "0001-01-01", end: "2026-05-17" },
      now,
    );

    expect(getReportComparisonBounds(range, kind, now)).toBeNull();
  });

  it("omits an out-of-bounds previous period while preserving a representable year-ago period", () => {
    const now = new Date("2026-05-17T02:00:00.000Z");
    const range = resolveRange(
      { mode: "custom", month: "2026-05", year: "2026", start: "1000-01-01", end: "2026-05-17" },
      now,
    );

    expect(getReportComparisonBounds(range, "previous", now)).toBeNull();
    expect(getReportComparisonBounds(range, "yearAgo", now)).toEqual({
      from: new Date("0999-01-01T00:00:00.000+08:00"),
      to: new Date("2025-05-17T15:59:59.999Z"),
    });
  });

  it("allows a previous period beginning on Shanghai January 1 of year 0001", () => {
    const now = new Date("2026-05-17T02:00:00.000Z");
    const range = resolveRange(
      { mode: "custom", month: "2026-05", year: "2026", start: "0001-01-02", end: "0001-01-02" },
      now,
    );

    expect(getReportComparisonBounds(range, "previous", now)).toEqual({
      from: new Date("0001-01-01T00:00:00.000+08:00"),
      to: new Date("0001-01-01T23:59:59.999+08:00"),
    });
  });
});
