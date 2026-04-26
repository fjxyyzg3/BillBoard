import { describe, expect, it } from "vitest";
import { getRangeBounds } from "@/lib/time-range";

describe("getRangeBounds", () => {
  it("returns month bounds in Asia/Shanghai", () => {
    const now = new Date("2026-04-18T09:30:00+08:00");
    const range = getRangeBounds("this-month", now, "Asia/Shanghai");

    expect(range.from.toISOString()).toBe("2026-03-31T16:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-04-30T15:59:59.999Z");
  });

  it("returns the last 7 days as Shanghai day boundaries", () => {
    const now = new Date("2026-04-18T09:30:00+08:00");
    const range = getRangeBounds("last-7-days", now, "Asia/Shanghai");

    expect(range.from.toISOString()).toBe("2026-04-11T16:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-04-18T15:59:59.999Z");
  });

  it("returns the last 30 days as Shanghai day boundaries", () => {
    const now = new Date("2026-04-18T09:30:00+08:00");
    const range = getRangeBounds("last-30-days", now, "Asia/Shanghai");

    expect(range.from.toISOString()).toBe("2026-03-19T16:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-04-18T15:59:59.999Z");
  });

  it("returns the last 12 months as Shanghai month boundaries", () => {
    const now = new Date("2026-04-18T09:30:00+08:00");
    const range = getRangeBounds("last-12-months", now, "Asia/Shanghai");

    expect(range.from.toISOString()).toBe("2025-04-30T16:00:00.000Z");
    expect(range.to.toISOString()).toBe("2026-04-30T15:59:59.999Z");
  });
});
