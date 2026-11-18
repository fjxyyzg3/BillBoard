import { describe, expect, it } from "vitest";
import { buildEntryRecordsHref } from "@/lib/transactions/result-records-link";
import { resolveLedgerSelection } from "@/lib/ledgers/selection";

describe("entry result record navigation", () => {
  it("opens the original ledger across all dates and members without narrowing result visibility", () => {
    const link = new URL(buildEntryRecordsHref({ ledgerId: "original-ledger" }), "https://example.test");
    expect(link.pathname).toBe("/records");
    expect(Object.fromEntries(link.searchParams)).toEqual({ mode: "all", ledger: "original-ledger" });
  });

  it("keeps archived result history readable with the current writable target", () => {
    const params = new URL(buildEntryRecordsHref({ ledgerId: "archived-original" }), "https://example.test").searchParams;
    const identity = { householdId: "household", memberId: "member" };
    const selected = resolveLedgerSelection({
      identity,
      ledgers: [
        { id: "default", name: "Default", isDefault: true, archivedAt: null },
        { id: "archived-original", name: "Original", isDefault: false, archivedAt: "2026-10-22T00:00:00Z" },
        { id: "current-writable", name: "Current", isDefault: false, archivedAt: null },
      ],
      preference: { ...identity, scope: { kind: "ledger", ledgerId: "current-writable" }, entryLedgerId: "current-writable" },
      ledger: params.get("ledger"), entryLedgerId: params.get("entryLedger"),
    });
    expect(selected).toEqual({ scope: { kind: "ledger", ledgerId: "archived-original" }, entryLedgerId: "current-writable" });
  });

  it("uses an explicit household scope for legacy feedback without a known original context", () => {
    expect(buildEntryRecordsHref()).toBe("/records?mode=all&ledger=all");
  });

  it("encodes the ledger identifier without adding financial or identity details to the URL", () => {
    const params = new URL(buildEntryRecordsHref({ ledgerId: "ledger & number/one" }), "https://example.test").searchParams;
    expect(params.get("ledger")).toBe("ledger & number/one");
    expect([...params.keys()]).toEqual(["mode", "ledger"]);
  });
});
