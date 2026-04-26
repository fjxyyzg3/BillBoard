import { describe, expect, it } from "vitest";
import { assertHouseholdAccess, resolvePerspectiveMemberId } from "@/lib/auth/permissions";

describe("assertHouseholdAccess", () => {
  it("allows the matching household", () => {
    expect(() => assertHouseholdAccess("house-1", "house-1")).not.toThrow();
  });

  it("rejects a different household", () => {
    expect(() => assertHouseholdAccess("house-1", "house-2")).toThrow("Forbidden");
  });
});

describe("resolvePerspectiveMemberId", () => {
  it("returns the spouse member id for spouse perspective", () => {
    expect(
      resolvePerspectiveMemberId("spouse", "member-a", [
        { id: "member-a" },
        { id: "member-b" },
      ]),
    ).toBe("member-b");
  });
});
