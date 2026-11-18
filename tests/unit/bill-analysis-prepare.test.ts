import { describe, expect, it } from "vitest";
import { buildBillAnalysisSummary, prepareBillAnalysis, type BillAnalysisSourceSnapshot } from "../../src/lib/reports/bill-analysis-prepare";
import { billAnalysisBytes, MAX_BILL_ANALYSIS_BODY_BYTES, validateBillAnalysisResponse } from "../../src/lib/reports/bill-analysis-protocol";

function snapshot(count = 2): BillAnalysisSourceSnapshot {
  return {
    scope: { mode: "month", period: "2026-10", ledgerId: null, actorMemberId: null }, locale: "zh-CN",
    snapshotAt: "2026-11-01T00:00:00.000Z", range: { from: "2026-10-01", to: "2026-10-31" }, firstRecordedDate: "2025-01-01",
    current: Array.from({ length: count }, (_, index) => ({
      id: `private-row-${index}`, ledgerId: "private-ledger", actorMemberId: index % 2 ? "private-member-b" : "private-member-a",
      occurredAt: new Date(`2026-10-${String(index % 31 + 1).padStart(2, "0")}T08:00:00+08:00`),
      type: "EXPENSE" as const, amountFen: 1000, categoryId: "private-category", categoryName: "Dining", note: `原文备注 ${index}`,
    })),
    previous: { range: { from: "2026-09-01", to: "2026-09-30" }, rows: [{
      id: "private-comparison-row", ledgerId: "private-ledger", actorMemberId: "private-member-a", occurredAt: new Date("2026-09-01T00:00:00+08:00"),
      type: "EXPENSE", amountFen: 1000, categoryId: "private-category", categoryName: "Dining", note: "PRIVATE-COMPARISON-NOTE",
    }] }, yearAgo: null,
  };
}

describe("complete bill analysis preparation", () => {
  it("rounds a half-fen median to the nearest fen before persisting financial metrics", () => {
    const input = snapshot();
    input.current[0].amountFen = 1;
    input.current[1].amountFen = 2;
    const prepared = prepareBillAnalysis(input);
    expect(prepared.metrics.find(({ ref }) => ref === "current.medianFen")).toMatchObject({ value: 2, unit: "fen" });
    expect(prepared.metrics.filter(({ unit }) => unit !== "ratio").every(({ value }) => Number.isSafeInteger(value))).toBe(true);
  });

  it("partitions 5000 full records exactly once into ten bounded batches without leaking internal identifiers", () => {
    const input = snapshot(5000);
    const prepared = prepareBillAnalysis(input);
    expect(prepared.batches).toHaveLength(10);
    const rows = prepared.batches.flatMap((batch) => batch.stage === "batch" ? batch.rows : []);
    expect(rows).toHaveLength(5000);
    expect(new Set(rows.map(({ ref }) => ref)).size).toBe(5000);
    expect(new Set(rows.map(({ note }) => note))).toEqual(new Set(input.current.map(({ note }) => note)));
    expect(prepared.batches.every((batch) => billAnalysisBytes(batch) <= MAX_BILL_ANALYSIS_BODY_BYTES)).toBe(true);
    const wire = JSON.stringify(prepared.batches);
    expect(wire).not.toContain("private-");
    expect(wire).not.toContain("PRIVATE-COMPARISON-NOTE");
    expect(prepared.metrics.find(({ ref }) => ref === "current.expenseFen")?.value).toBe(5_000_000);
  });

  it("keeps income and expenses separate and calculates Shanghai date/category and comparison facts", () => {
    const input = snapshot();
    input.current[0] = { ...input.current[0], type: "INCOME", amountFen: 3000, categoryName: "Salary", categoryId: "private-salary" };
    input.current[1].occurredAt = new Date("2026-10-01T16:30:00Z");
    const prepared = prepareBillAnalysis(input);
    expect(prepared.metrics).toEqual(expect.arrayContaining([
      expect.objectContaining({ ref: "current.incomeFen", value: 3000 }),
      expect.objectContaining({ ref: "current.expenseFen", value: 1000 }),
      expect.objectContaining({ ref: "current.netFen", value: 2000 }),
    ]));
    expect(prepared.evidence.find(({ type }) => type === "expense")?.date).toBe("2026-10-02");
    expect(prepared.batches[0].comparisons[0]).toMatchObject({ period: "previous", availability: "available", metrics: expect.arrayContaining([
      expect.objectContaining({ ref: "previous.expenseFen", value: 1000 }),
    ]) });
  });

  it("keeps the transaction reference map server-only and excludes it from every model request", () => {
    const input = snapshot(2);
    const prepared = prepareBillAnalysis(input);
    expect(prepared.transactionRefs).toEqual({ r1: "private-row-0", r2: "private-row-1" });
    const results = prepared.batches.map((batch) => ({ overview: "Recorded facts",
      observations: [{ title: "Review", detail: "Use the supplied evidence", evidenceRefs: [batch.rows[0].ref] }], recommendations: [], limitations: [] }));
    const summary = buildBillAnalysisSummary(prepared, results);
    expect(JSON.stringify(prepared.batches)).not.toContain("private-row-");
    expect(JSON.stringify(summary)).not.toContain("private-row-");
    expect(summary).not.toHaveProperty("transactionRefs");
  });

  it("does not invent comparable percentages from zero or missing baselines", () => {
    const input = snapshot();
    input.previous!.rows = [];
    const prepared = prepareBillAnalysis(input);
    expect(prepared.batches[0].comparisons[0].availability).toBe("missing");
    expect(prepared.metrics.some(({ ref }) => ref.includes("Ratio"))).toBe(false);
    expect(prepared.batches[0].limitations.length).toBeGreaterThan(0);
  });

  it("fails rather than truncating one oversized note or a too-large record range", () => {
    const tooMany = snapshot(10_001);
    expect(() => prepareBillAnalysis(tooMany)).toThrow(expect.objectContaining({ code: "TOO_LARGE" }));
    const tooLong = snapshot(1);
    tooLong.current[0].note = "秘".repeat(100_000);
    expect(() => prepareBillAnalysis(tooLong)).toThrow(expect.objectContaining({ code: "TOO_LARGE" }));
    expect(() => prepareBillAnalysis(snapshot(0))).toThrow(expect.objectContaining({ code: "NO_DATA" }));
  });

  it("constructs the final summary from all validated batches without repeating raw notes", () => {
    const prepared = prepareBillAnalysis(snapshot(501));
    const results = prepared.batches.map((batch) => validateBillAnalysisResponse(batch, {
      schemaVersion: batch.schemaVersion, batchId: batch.batchId,
      body: { overview: "Recorded facts", observations: [{ title: "Review", detail: "Compare spending", evidenceRefs: [batch.stage === "batch" ? batch.rows[0].ref : ""] }], recommendations: [], limitations: [] },
    }));
    const summary = buildBillAnalysisSummary(prepared, results);
    expect(summary.stage).toBe("summary");
    if (summary.stage !== "summary") throw new Error("Expected summary");
    expect(summary.findings.map(({ batchId }) => batchId)).toEqual(["b1", "b2"]);
    expect(summary.evidence).toHaveLength(2);
    expect(JSON.stringify(summary)).not.toContain("原文备注");
    expect(billAnalysisBytes(summary)).toBeLessThanOrEqual(MAX_BILL_ANALYSIS_BODY_BYTES);
    expect(() => buildBillAnalysisSummary(prepared, results.slice(0, 1))).toThrow();
  });

  it("splits UTF-8-heavy notes by serialized bytes without losing their exact content", () => {
    const input = snapshot(7);
    input.current.forEach((row, index) => { row.note = `${index} ${"笔记😀".repeat(6000)}`; });
    const prepared = prepareBillAnalysis(input);
    expect(prepared.batches.length).toBeGreaterThan(1);
    expect(prepared.batches.flatMap(({ rows }) => rows).map(({ note }) => note).sort()).toEqual(input.current.map(({ note }) => note).sort());
    expect(prepared.batches.every((batch) => billAnalysisBytes(batch) <= MAX_BILL_ANALYSIS_BODY_BYTES)).toBe(true);
  });

  it("uses monthly facts for year reports and marks partial comparisons without ratio claims", () => {
    const input = snapshot();
    input.scope = { ...input.scope, mode: "year", period: "2026" };
    input.range = { from: "2026-01-01", to: "2026-10-31" };
    input.firstRecordedDate = "2026-09-10";
    const prepared = prepareBillAnalysis(input);
    expect(prepared.metrics.some(({ ref }) => ref === "current.time.2026-10.expenseFen")).toBe(true);
    expect(prepared.batches[0].comparisons[0].availability).toBe("partial");
    expect(prepared.batches[0].comparisons[0].metrics.some(({ ref }) => ref.includes("ChangeRatio"))).toBe(false);
  });

  it("rejects repeated source IDs and unsafe money instead of double-counting", () => {
    const repeated = snapshot();
    repeated.current[1].id = repeated.current[0].id;
    expect(() => prepareBillAnalysis(repeated)).toThrow(expect.objectContaining({ code: "INVALID" }));
    const unsafe = snapshot();
    unsafe.current[0].amountFen = Number.MAX_SAFE_INTEGER;
    expect(() => prepareBillAnalysis(unsafe)).toThrow(expect.objectContaining({ code: "TOO_LARGE" }));
  });
});
