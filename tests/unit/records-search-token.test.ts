import { afterEach, describe, expect, it, vi } from "vitest";
import { createCipheriv, createHash, randomBytes } from "node:crypto";
import {
  createRecordSearchToken,
  decodeRecordSearchToken,
  createRecordAmountToken,
  decodeRecordAmountToken,
} from "@/lib/records/search-token";

const tokenContext = { householdId: "household-1", memberId: "member-1", ledgerId: "ledger-1" };

describe("record search tokens", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("binds family filters to the read scope independently of a new entry target", () => {
    vi.stubEnv("AUTH_SECRET", "record-search-test-secret");
    const family = { householdId: "household-1", memberId: "member-1", scope: { kind: "household" as const } };
    const token = createRecordSearchToken("family travel", family);
    expect(token).toEqual(expect.any(String));
    expect(decodeRecordSearchToken(token, family)).toBe("family travel");
    expect(decodeRecordSearchToken(token, { ...family, scope: { kind: "ledger", ledgerId: "ledger-1" } })).toBeUndefined();
    expect(decodeRecordSearchToken(token, { ...family, memberId: "new-identity" })).toBeUndefined();
  });

  it("round-trips a trimmed search value without putting plaintext in the token", () => {
    vi.stubEnv("AUTH_SECRET", "record-search-test-secret");

    const token = createRecordSearchToken("  Dining reimbursement  ", tokenContext);

    expect(token).toEqual(expect.any(String));
    expect(token).not.toContain("Dining reimbursement");
    expect(decodeRecordSearchToken(token, tokenContext)).toBe("Dining reimbursement");
  });

  it("binds private filters to the exact household member identity and ledger", () => {
    vi.stubEnv("AUTH_SECRET", "record-search-test-secret");
    const context = { householdId: "household-1", memberId: "member-1", ledgerId: "ledger-1" };
    const token = createRecordSearchToken("private rejoin search", context);
    expect(decodeRecordSearchToken(token, context)).toBe("private rejoin search");
    expect(decodeRecordSearchToken(token, { ...context, memberId: "rejoined-member" })).toBeUndefined();
    expect(decodeRecordSearchToken(token, { ...context, ledgerId: "ledger-2" })).toBeUndefined();
  });

  it("ignores valid legacy household-only tokens whose original member identity cannot be recovered", () => {
    vi.stubEnv("AUTH_SECRET", "record-search-test-secret");
    const iv = randomBytes(12);
    const cipher = createCipheriv("aes-256-gcm", createHash("sha256").update("record-search-test-secret").digest(), iv);
    cipher.setAAD(Buffer.from("billboard-record-search:v1:household-1"));
    const encrypted = Buffer.concat([cipher.update(JSON.stringify({ householdId: "household-1", search: "Legacy private text" })), cipher.final()]);
    const legacy = ["v1", iv.toString("base64url"), cipher.getAuthTag().toString("base64url"), encrypted.toString("base64url")].join(".");
    expect(decodeRecordSearchToken(legacy, tokenContext)).toBeUndefined();
  });

  it("rejects tokens outside the issuing household and malformed values", () => {
    vi.stubEnv("AUTH_SECRET", "record-search-test-secret");

    const token = createRecordSearchToken("private note", tokenContext);

    expect(decodeRecordSearchToken(token, { ...tokenContext, householdId: "household-2" })).toBeUndefined();
    expect(decodeRecordSearchToken("not-a-search-token", tokenContext)).toBeUndefined();
    expect(decodeRecordSearchToken(undefined, tokenContext)).toBeUndefined();
  });

  it("protects amount filters and binds them to the household and token purpose", () => {
    vi.stubEnv("AUTH_SECRET", "record-search-test-secret");
    const filter = { mode: "range" as const, minFen: 19999, maxFen: 30000 };
    const token = createRecordAmountToken(filter, tokenContext);
    const searchToken = createRecordSearchToken("private note", tokenContext);

    expect(token).toEqual(expect.any(String));
    expect(token).not.toContain("19999");
    expect(decodeRecordAmountToken(token, tokenContext)).toEqual(filter);
    expect(decodeRecordAmountToken(token, { ...tokenContext, householdId: "household-2" })).toBeUndefined();
    expect(decodeRecordAmountToken(searchToken, tokenContext)).toBeUndefined();
    expect(decodeRecordSearchToken(token, tokenContext)).toBeUndefined();
    const parts = token!.split(".");
    parts[2] = `${parts[2][0] === "A" ? "B" : "A"}${parts[2].slice(1)}`;
    expect(decodeRecordAmountToken(parts.join("."), tokenContext)).toBeUndefined();
  });

  it("round-trips exact and one-sided amount filters but rejects invalid bounds", () => {
    vi.stubEnv("AUTH_SECRET", "record-search-test-secret");
    for (const filter of [
      { mode: "exact" as const, valueFen: 29999 },
      { mode: "range" as const, minFen: 0 },
      { mode: "range" as const, maxFen: 30000 },
    ]) {
      expect(decodeRecordAmountToken(createRecordAmountToken(filter, tokenContext), tokenContext))
        .toEqual(filter);
    }
    expect(createRecordAmountToken({ mode: "exact", valueFen: 0.1 }, tokenContext)).toBeUndefined();
    expect(createRecordAmountToken({ mode: "range", minFen: 2, maxFen: 1 }, tokenContext))
      .toBeUndefined();
    expect(decodeRecordAmountToken("v1.invalid", tokenContext)).toBeUndefined();
  });
});
