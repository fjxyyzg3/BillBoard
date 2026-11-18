import { describe, expect, it } from "vitest";
import { buildAppHref } from "@/lib/app-navigation";

describe("app navigation", () => {
  it("preserves the selected historical member alongside ledger and date scopes", () => {
    const params = new URLSearchParams("mode=all&ledger=travel&entryLedger=default&member=former-member&type=expense");
    expect(buildAppHref("/home", params)).toBe("/home?mode=all&ledger=travel&entryLedger=default&member=former-member");
    expect(buildAppHref("/records", params)).toBe("/records?mode=all&ledger=travel&entryLedger=default&member=former-member");
  });
  it("carries the read scope and explicit entry target across app navigation", () => {
    expect(buildAppHref("/add", new URLSearchParams("ledger=all&entryLedger=travel&search=private")))
      .toBe("/add?ledger=all&entryLedger=travel");
  });
  it("preserves review scopes in the new sidebar destinations without changing the entry target on ledger management", () => {
    const params = new URLSearchParams("mode=month&month=2026-05&ledger=travel&entryLedger=daily&member=former-member&search=private");
    expect(buildAppHref("/records/reconcile", params)).toBe("/records/reconcile?mode=month&month=2026-05&ledger=travel&entryLedger=daily&member=former-member");
    expect(buildAppHref("/ledgers", params)).toBe("/ledgers?mode=month&month=2026-05&ledger=travel&member=former-member");
  });
  it.each(["me", "spouse"])("keeps the time range and drops legacy %s perspective for app pages", (perspective) => {
    const params = new URLSearchParams(
      `mode=month&month=2026-04&year=2026&perspective=${perspective}&type=expense&categoryType=income&record=abc`,
    );

    expect(buildAppHref("/records", params)).toBe("/records?mode=month&month=2026-04&year=2026");
    expect(buildAppHref("/add", params)).toBe("/add?mode=month&month=2026-04&year=2026");
    expect(buildAppHref("/home", params)).toBe("/home?mode=month&month=2026-04&year=2026");
  });

  it("drops invalid shared dashboard filters", () => {
    const params = new URLSearchParams(
      "perspective=household&mode=custom&month=2026-13&year=26&record=record-1",
    );

    expect(buildAppHref("/records", params)).toBe("/records");
  });

  it("preserves custom endpoints and drops narrower record filters", () => {
    const params = new URLSearchParams(
      "mode=custom&month=2026-05&year=2026&start=2026-04-01&end=2026-05-17&from=2026-05-01&to=2026-05-02&type=expense&amount=secret&page=2",
    );

    expect(buildAppHref("/home", params)).toBe(
      "/home?mode=custom&month=2026-05&year=2026&start=2026-04-01&end=2026-05-17",
    );
  });

  it("preserves recent mode without stale custom endpoints", () => {
    const params = new URLSearchParams(
      "mode=recent&month=2026-05&year=2026&start=2026-04-01&end=2026-05-17",
    );

    expect(buildAppHref("/add", params)).toBe("/add?mode=recent&month=2026-05&year=2026");
  });

  it("does not propagate impossible or reversed custom dates", () => {
    for (const dates of ["start=2026-02-29&end=2026-03-01", "start=2026-05-02&end=2026-05-01"]) {
      expect(buildAppHref("/home", new URLSearchParams(`mode=custom&${dates}`))).toBe("/home");
    }
  });
});
