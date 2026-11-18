import { describe, expect, it } from "vitest";
import { compareManifests, type MigrationManifest } from "../../ops/migrations/household-ledgers";

function manifest(): MigrationManifest {
  return { version: 1, createdAt: "2026-10-21T00:00:00Z", tables: [
    { name: "Transaction", key: "id", columns: ["id", "amount_fen"], rows: 2, sha256: "original-fields" },
    { name: "AppSession", key: "id", columns: ["id", "expires_at", "revoked_at"], rows: 1, sha256: "original-session" },
  ], transactionGroups: { groups: 2, sha256: "historical-total" } };
}

describe("migration original-field evidence", () => {
  it("accepts new structures while comparing every original row and original column", () => {
    const before = manifest();
    const after = structuredClone(before);
    after.tables.push({ name: "Ledger", key: "id", columns: ["id"], rows: 1, sha256: "new-ledger" });
    expect(compareManifests(before, after)).toEqual({ tables: 2, rows: 3, groups: 2 });
  });
  it.each(["Transaction", "AppSession"])("rejects changed original values in %s even when counts match", (name) => {
    const before = manifest();
    const after = structuredClone(before);
    after.tables.find((table) => table.name === name)!.sha256 = "changed";
    expect(() => compareManifests(before, after)).toThrow(`Original fields differ in ${name}`);
  });
  it("rejects a missing original table", () => {
    const before = manifest();
    const after = structuredClone(before);
    after.tables.pop();
    expect(() => compareManifests(before, after)).toThrow("Original fields differ in AppSession");
  });
  it("rejects changed historical aggregates independently of table counts", () => {
    const before = manifest();
    const after = structuredClone(before);
    after.transactionGroups.sha256 = "changed";
    expect(() => compareManifests(before, after)).toThrow("Historical transaction aggregates differ");
  });
});
