import { describe, expect, it } from "vitest";
import { formatAppVersion } from "@/lib/app-version";

describe("formatAppVersion", () => {
  it("prefixes a package version for display", () => {
    expect(formatAppVersion("0.1.0")).toBe("v0.1.0");
  });

  it("falls back to v0.0.0 when the package version is empty", () => {
    expect(formatAppVersion("")).toBe("v0.0.0");
    expect(formatAppVersion(undefined)).toBe("v0.0.0");
  });
});
