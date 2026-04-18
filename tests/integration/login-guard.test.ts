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
});
