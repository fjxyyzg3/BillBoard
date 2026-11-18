import { describe, expect, it } from "vitest";
import {
  describeSessionDevice,
  shouldRefreshAppSessionLastSeen,
} from "@/lib/auth/app-sessions";

describe("describeSessionDevice", () => {
  it("describes common browser and OS combinations from the user agent", () => {
    expect(
      describeSessionDevice(
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
          "(KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
      ),
    ).toBe("Chrome on Windows");

    expect(
      describeSessionDevice(
        "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) " +
          "AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
      ),
    ).toBe("Safari on iPhone");
  });

  it("falls back to Unknown for missing legacy session user agents", () => {
    expect(describeSessionDevice(null)).toBe("Unknown");
    expect(describeSessionDevice("")).toBe("Unknown");
  });
});

describe("shouldRefreshAppSessionLastSeen", () => {
  const now = new Date("2026-05-16T10:00:00.000Z");

  it("updates lastSeenAt only after the five minute throttle window", () => {
    expect(
      shouldRefreshAppSessionLastSeen(
        new Date("2026-05-16T09:54:59.000Z"),
        now,
      ),
    ).toBe(true);

    expect(
      shouldRefreshAppSessionLastSeen(
        new Date("2026-05-16T09:56:00.000Z"),
        now,
      ),
    ).toBe(false);
  });
});
