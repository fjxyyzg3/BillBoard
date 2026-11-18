import { describe, expect, it } from "vitest";
import { buildLedgerSelectionHref } from "@/components/ledger-provider";

describe("ledger selection navigation", () => {
  it("keeps management free of a fixed write target so archiving that target remains recoverable", () => {
    expect(buildLedgerSelectionHref("/ledgers", "entryLedger=travel", { kind: "ledger", ledgerId: "travel" }, "travel", false)).toBe("/ledgers?ledger=travel");
  });
  it("drops scope-bound search and amount tokens while retaining the time window and ordinary filters", () => {
    const href = buildLedgerSelectionHref("/records", "mode=custom&start=2026-01-01&end=2026-02-01&type=expense&search=private-token&amount=amount-token&record=record-id&page=4&filterError=invalidSearch", { kind: "ledger", ledgerId: "travel" }, "travel", true);
    const target = new URL(href, "http://localhost");
    expect(Object.fromEntries(target.searchParams)).toEqual({ mode: "custom", start: "2026-01-01", end: "2026-02-01", type: "expense", ledger: "travel", entryLedger: "travel" });
  });

  it("keeps a read scope and its search token when only the next entry target changes", () => {
    const href = buildLedgerSelectionHref("/records", "mode=year&year=2026&search=scope-token", { kind: "household" }, "travel", false);
    expect(Object.fromEntries(new URL(href, "http://localhost").searchParams)).toEqual({ mode: "year", year: "2026", search: "scope-token", ledger: "all", entryLedger: "travel" });
  });
});
