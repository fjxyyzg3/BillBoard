import { describe, expect, it } from "vitest";

import { normalizeCredentialEmail } from "@/lib/auth/credentials";

describe("normalizeCredentialEmail", () => {
  it("normalizes valid credential emails", () => {
    expect(normalizeCredentialEmail("  USER-A@EXAMPLE.COM  ")).toBe("user-a@example.com");
  });

  it("rejects empty, malformed, and overlong credential emails before database writes", () => {
    expect(normalizeCredentialEmail("")).toBeNull();
    expect(normalizeCredentialEmail("not-an-email")).toBeNull();
    expect(normalizeCredentialEmail(`${"a".repeat(245)}@example.com`)).toBeNull();
  });
});
