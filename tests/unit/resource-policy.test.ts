import { describe, expect, it } from "vitest";
import { consumeResourceWindow, RESOURCE_POLICIES, ResourceBusyError } from "@/lib/resources/policy";

describe("resource admission windows", () => {
  const start = new Date("2026-10-21T02:00:00.000Z");

  it("keeps the existing parser and Agent hard limits and bounds each household and member", () => {
    expect(RESOURCE_POLICIES.import.concurrent.global).toBe(2);
    expect(RESOURCE_POLICIES.ai.concurrent.global).toBe(1);
    for (const policy of Object.values(RESOURCE_POLICIES)) {
      expect(policy.concurrent.member).toBeLessThanOrEqual(policy.concurrent.household);
      expect(policy.concurrent.household).toBeLessThanOrEqual(policy.concurrent.global);
      expect(policy.leaseMs).toBeGreaterThan(30_000);
      expect(policy.leaseMs).toBeLessThanOrEqual(180_000);
    }
  });

  it("admits the last token then rejects until the exact window boundary", () => {
    const first = consumeResourceWindow({ startedAt: start, used: 1 }, new Date(start.getTime() + 1), 2);
    expect(first).toEqual({ startedAt: start, used: 2 });
    expect(() => consumeResourceWindow(first, new Date(start.getTime() + 59_999), 2)).toThrow(ResourceBusyError);
    expect(consumeResourceWindow(first, new Date(start.getTime() + 60_000), 2)).toEqual({
      startedAt: new Date(start.getTime() + 60_000), used: 1,
    });
  });

  it("does not refill a future window after a database clock step backwards", () => {
    try {
      consumeResourceWindow({ startedAt: start, used: 2 }, new Date(start.getTime() - 1000), 2);
      throw new Error("Expected rate rejection");
    } catch (error) {
      expect(error).toBeInstanceOf(ResourceBusyError);
      expect((error as ResourceBusyError).retryAfterSeconds).toBe(61);
    }
  });
});
