import { describe, expect, it } from "vitest";
import { canExposeAppEventBusiness } from "@/lib/ops/event-metadata";

describe("business event visibility", () => {
  it("preserves only stable unencrypted or legacy behavior", () => {
    expect(canExposeAppEventBusiness(undefined)).toBe(true);
    expect(canExposeAppEventBusiness(null)).toBe(true);
    expect(canExposeAppEventBusiness({ mode: "UNENCRYPTED", activeOperationId: null })).toBe(true);
  });

  it("hides all business fields while encrypted, changing mode, rotating or in an unknown mode", () => {
    for (const mode of ["ENABLING", "ENCRYPTED", "DISABLING", "unknown"]) {
      expect(canExposeAppEventBusiness({ mode, activeOperationId: null })).toBe(false);
    }
    expect(canExposeAppEventBusiness({ mode: "UNENCRYPTED", activeOperationId: "operation-1" })).toBe(false);
  });
});
