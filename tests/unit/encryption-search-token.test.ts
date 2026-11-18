import { expect, it } from "vitest";
import { createHouseholdCode, createKeyRing } from "@/lib/encryption/crypto";
import { runEncryptionContext } from "@/lib/encryption/request-context";
import { createRecordSearchToken, decodeRecordSearchToken } from "@/lib/records/search-token";
it("uses family material and rejects a legacy AUTH_SECRET search token in encrypted mode", async () => {
  process.env.AUTH_SECRET = "replace-me";
  const context = { householdId: "search-household", memberId: "search-member", scope: { kind: "household" as const } };
  const legacy = createRecordSearchToken("PRIVATE_SEARCH", context)!;
  const ring = createKeyRing(createHouseholdCode(context.householdId));
  await runEncryptionContext({ session: { id: "search-account", householdId: context.householdId, memberId: context.memberId, appSessionId: "search-session", role: "OWNER" }, mode: "ENCRYPTED", configMode: "ENCRYPTED", revision: 7, ring, expiresAt: Date.now() + 60000, disposed: false, readOnly: true }, async () => {
    const encrypted = createRecordSearchToken("PRIVATE_SEARCH", context)!;
    expect(encrypted.startsWith("v4.")).toBe(true);
    expect(decodeRecordSearchToken(legacy, context)).toBeUndefined();
    expect(decodeRecordSearchToken(encrypted, context)).toBe("PRIVATE_SEARCH");
    expect(encrypted).not.toContain("PRIVATE_SEARCH");
  });
});
