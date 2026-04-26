import { describe, expect, it } from "vitest";
import { parsePerspective, resolvePerspective } from "@/lib/perspective";

describe("parsePerspective", () => {
  it("defaults to household for missing values", () => {
    expect(parsePerspective(null)).toBe("household");
  });

  it("defaults to household for invalid values", () => {
    expect(parsePerspective("invalid")).toBe("household");
  });

  it("keeps supported perspective values", () => {
    expect(parsePerspective("me")).toBe("me");
    expect(parsePerspective("spouse")).toBe("spouse");
  });
});

describe("resolvePerspective", () => {
  it("returns all household members for household perspective", () => {
    expect(resolvePerspective("household", "member-a", ["member-a", "member-b"])).toEqual([
      "member-a",
      "member-b",
    ]);
  });

  it("returns the current member for me perspective", () => {
    expect(resolvePerspective("me", "member-a", ["member-a", "member-b"])).toEqual(["member-a"]);
  });

  it("returns the other household member for spouse perspective", () => {
    expect(resolvePerspective("spouse", "member-a", ["member-a", "member-b"])).toEqual(["member-b"]);
  });
});
