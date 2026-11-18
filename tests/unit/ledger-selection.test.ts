import { describe, expect, it } from "vitest";

const identity = { householdId: "household", memberId: "member" };
const ledgers = [
  { id: "default", name: "Daily", isDefault: true, archivedAt: null },
  { id: "travel", name: "Travel", isDefault: false, archivedAt: null },
  { id: "archive", name: "Archive", isDefault: false, archivedAt: "2026-10-20T00:00:00.000Z" },
];

describe("ledger selection", () => {
  it("starts at the household overview with the actual default entry target", async () => {
    const { resolveLedgerSelection } = await import("@/lib/ledgers/selection");
    expect(resolveLedgerSelection({ ledgers, identity })).toEqual({ scope: { kind: "household" }, entryLedgerId: "default" });
  });

  it("restores only the current identity's preference and preselects an active single ledger", async () => {
    const { resolveLedgerSelection } = await import("@/lib/ledgers/selection");
    const preference = { ...identity, scope: { kind: "ledger" as const, ledgerId: "travel" }, entryLedgerId: "default" };
    expect(resolveLedgerSelection({ ledgers, identity, preference })).toEqual({ scope: preference.scope, entryLedgerId: "travel" });
    expect(resolveLedgerSelection({ ledgers, identity: { ...identity, memberId: "rejoined" }, preference })).toEqual({
      scope: { kind: "household" }, entryLedgerId: "default",
    });
    expect(resolveLedgerSelection({ ledgers, identity: { ...identity, householdId: "other" }, preference })).toEqual({
      scope: { kind: "household" }, entryLedgerId: "default",
    });
  });

  it("keeps the last active entry target in the overview and gives explicit links priority", async () => {
    const { resolveLedgerSelection } = await import("@/lib/ledgers/selection");
    const preference = { ...identity, scope: { kind: "ledger" as const, ledgerId: "default" }, entryLedgerId: "travel" };
    expect(resolveLedgerSelection({ ledgers, identity, preference, ledger: "all" })).toEqual({
      scope: { kind: "household" }, entryLedgerId: "travel",
    });
    expect(resolveLedgerSelection({ ledgers, identity, preference, ledger: "travel", entryLedgerId: "default" })).toEqual({
      scope: { kind: "ledger", ledgerId: "travel" }, entryLedgerId: "default",
    });
  });

  it("allows viewing archives but falls back to the available default for new entries", async () => {
    const { resolveLedgerSelection } = await import("@/lib/ledgers/selection");
    expect(resolveLedgerSelection({ ledgers, identity, ledger: "archive" })).toEqual({
      scope: { kind: "ledger", ledgerId: "archive" }, entryLedgerId: "default",
    });
    expect(resolveLedgerSelection({ ledgers, identity, preference: {
      ...identity, scope: { kind: "household" }, entryLedgerId: "archive",
    } })).toEqual({ scope: { kind: "household" }, entryLedgerId: "default" });
  });

  it("recovers stale saved selections without hiding an invalid explicit target", async () => {
    const { resolveLedgerSelection } = await import("@/lib/ledgers/selection");
    expect(resolveLedgerSelection({ ledgers, identity, preference: {
      ...identity, scope: { kind: "ledger", ledgerId: "missing" }, entryLedgerId: "missing",
    } })).toEqual({ scope: { kind: "household" }, entryLedgerId: "default" });
    for (const ledger of ["outside", "", " all "]) {
      expect(() => resolveLedgerSelection({ ledgers, identity, ledger })).toThrow("Ledger is unavailable");
    }
    for (const entryLedgerId of ["outside", "archive", ""]) {
      expect(() => resolveLedgerSelection({ ledgers, identity, entryLedgerId })).toThrow("Ledger is unavailable");
    }
  });

  it("refuses a catalog without an active default instead of guessing a target", async () => {
    const { resolveLedgerSelection } = await import("@/lib/ledgers/selection");
    expect(() => resolveLedgerSelection({ ledgers: ledgers.filter((ledger) => !ledger.isDefault), identity })).toThrow("Ledger is unavailable");
  });

  it("round-trips only the bounded identity and ID preference through URI-encoded JSON", async () => {
    const { parseLedgerPreference, serializeLedgerPreference, LEDGER_PREFERENCE_COOKIE } = await import("@/lib/ledgers/selection");
    const preference = { ...identity, scope: { kind: "ledger" as const, ledgerId: "travel" }, entryLedgerId: "default" };
    const raw = serializeLedgerPreference(preference);
    expect(LEDGER_PREFERENCE_COOKIE).toBe("billboard-ledger-preference-v1");
    expect(raw).toBe(encodeURIComponent(JSON.stringify(preference)));
    expect(parseLedgerPreference(raw, identity)).toEqual(preference);
    expect(parseLedgerPreference(raw, { ...identity, memberId: "rejoined" })).toBeUndefined();
    for (const invalid of [undefined, "", "%", "{}", encodeURIComponent(JSON.stringify({ ...preference, note: "Financial text" })), "x".repeat(4097)]) {
      expect(parseLedgerPreference(invalid, identity)).toBeUndefined();
    }
  });
});
