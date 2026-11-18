import { describe, expect, it } from "vitest";
import { matchesWhere, orderRows } from "@/lib/encryption/query";

describe("decrypted financial query semantics", () => {
  const rows = [
    { id: "a", amountFen: 12345, occurredAt: new Date("2026-10-01T00:00:00+08:00"), note: "午餐", sourceFingerprint: "source-a", refunds: ["r1"], category: { type: "EXPENSE" } },
    { id: "b", amountFen: 500, occurredAt: new Date("2026-09-30T23:59:59+08:00"), note: null, sourceFingerprint: "source-b", refunds: [], category: { type: "INCOME" } },
  ];
  it("filters before pagination using integer amounts, dates, relations and refund arrays", () => {
    const where = { AND: [{ amountFen: { gte: 1000 } }, { occurredAt: { gte: new Date("2026-10-01T00:00:00+08:00") } }], category: { is: { type: "EXPENSE" } }, refunds: { hasSome: ["r1"] } };
    expect(rows.filter((row) => matchesWhere(row, where)).map((row) => row.id)).toEqual(["a"]);
    expect(orderRows([...rows], [{ amountFen: "asc" }, { id: "asc" }]).map((row) => row.id)).toEqual(["b", "a"]);
  });
  it("preserves null, composite keys, empty OR and negation semantics", () => {
    expect(matchesWhere(rows[0], { id_sourceFingerprint: { id: "a", sourceFingerprint: "source-a" } })).toBe(true);
    expect(matchesWhere(rows[1], { note: null })).toBe(true);
    expect(matchesWhere(rows[0], { OR: [] })).toBe(false);
    expect(matchesWhere(rows[0], { NOT: [{ amountFen: { lt: 1000 } }, { note: null }] })).toBe(true);
    expect(() => matchesWhere(rows[0], { amountFen: { invented: 1 } })).toThrow();
  });
});
