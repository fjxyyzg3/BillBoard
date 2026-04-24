import { describe, expect, it } from "vitest";
import { applyFailedAttempt } from "@/lib/auth/login-guard";

describe("applyFailedAttempt", () => {
  it("locks after five failed attempts", () => {
    const state = Array.from({ length: 5 }).reduce(
      (current) => applyFailedAttempt(current, new Date("2026-04-18T00:00:00.000Z")),
      null,
    );

    expect(state?.attemptCount).toBe(5);
    expect(state?.lockedUntil?.toISOString()).toBe("2026-04-18T00:15:00.000Z");
  });

  it("resets the attempt counter after an expired lockout", () => {
    const state = applyFailedAttempt(
      {
        attemptCount: 5,
        lockedUntil: new Date("2026-04-18T00:15:00.000Z"),
      },
      new Date("2026-04-18T00:16:00.000Z"),
    );

    expect(state.attemptCount).toBe(1);
    expect(state.lockedUntil).toBeNull();
  });

  it("resets stale failed attempts outside the lockout window", () => {
    const previous = {
      attemptCount: 4,
      lockedUntil: null,
      updatedAt: new Date("2026-04-18T00:00:00.000Z"),
    };
    const state = applyFailedAttempt(previous, new Date("2026-04-18T00:16:00.000Z"));

    expect(state.attemptCount).toBe(1);
    expect(state.lockedUntil).toBeNull();
  });
});
