import { describe, expect, it } from "vitest";
import { buildMemberFilterOptions, parseMemberFilter, selectMemberIds } from "@/lib/records/member-filter";
import { buildMemberFilterHref } from "@/components/member-filter";

describe("household member filters", () => {
  it("keeps historical memberships distinct and rejects foreign or ambiguous selections", () => {
    const members = [{ id: "former" }, { id: "current" }];
    expect(selectMemberIds(members)).toEqual(["former", "current"]);
    expect(selectMemberIds(members, "former")).toEqual(["former"]);
    expect(() => selectMemberIds(members, "foreign")).toThrow("Unauthorized");
    for (const value of [["former", "current"], "../former", "x".repeat(129)]) {
      expect(() => parseMemberFilter(value)).toThrow("Unauthorized");
    }
  });

  it.each(["zh-CN", "en-US"] as const)("labels same-name old and current identities separately in %s", (locale) => {
    const rows = [
      { id: "old-1", memberName: "Sam", leftAt: new Date(), user: { status: "ACTIVE" } },
      { id: "old-2", memberName: "Sam", leftAt: new Date(), user: { status: "DEACTIVATED" } },
      { id: "new", memberName: "Sam", leftAt: null, user: { status: "ACTIVE" } },
    ];
    const options = buildMemberFilterOptions(rows, locale);
    expect(options.map(({ id }) => id)).toEqual(["old-1", "old-2", "new"]);
    expect(new Set(options.map(({ label }) => label)).size).toBe(3);
    expect(options[2].label).toBe("Sam");
  });

  it("changes only the member selection and stale page/record when keeping a search and date range", () => {
    const query = "ledger=travel&mode=month&month=2026-10&search=opaque-token&amount=amount-token&category=dining&page=2&record=record-1";
    const selected = new URL(`https://example.test${buildMemberFilterHref("/records", query, "former")}`);
    expect(Object.fromEntries(selected.searchParams)).toEqual({ ledger: "travel", mode: "month", month: "2026-10", search: "opaque-token", amount: "amount-token", category: "dining", member: "former" });
    expect(new URL(`https://example.test${buildMemberFilterHref("/records", selected.search.slice(1), "")}`).searchParams.has("member")).toBe(false);
  });
});
