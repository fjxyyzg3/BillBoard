import { describe, expect, it } from "vitest";
import { resolvePerspective } from "@/lib/perspective";

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
