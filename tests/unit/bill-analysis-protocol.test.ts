import { describe, expect, it } from "vitest";
import {
  BILL_ANALYSIS_SCHEMA_VERSION, validateBillAnalysisRequest, validateBillAnalysisResponse,
} from "../../src/lib/reports/bill-analysis-protocol";

const request = {
  schemaVersion: "bill-analysis.v1", stage: "batch", batchId: "b1", batchCount: 1, locale: "zh-CN",
  range: { from: "2026-10-01", to: "2026-10-31" }, snapshotAt: "2026-11-01T00:00:00.000Z",
  metrics: [{ ref: "current.expenseFen", label: "支出", value: 1000, unit: "fen" }],
  comparisons: [], limitations: [],
  rows: [{ ref: "r1", date: "2026-10-10", type: "expense", amountFen: 1000,
    categoryName: "餐饮", memberAlias: "m1", ledgerAlias: "l1", note: "Lunch" }],
};
const body = { overview: "Recorded spending", observations: [{ title: "Food", detail: "Review eating out", evidenceRefs: ["r1"] }], recommendations: [], limitations: [] };

describe("bill analysis protocol", () => {
  it("rejects unrecognized evidence instead of accepting model invented facts", () => {
    const input = validateBillAnalysisRequest(request);
    expect(() => validateBillAnalysisResponse(input, { schemaVersion: BILL_ANALYSIS_SCHEMA_VERSION,
      batchId: "b1", body: { ...body, observations: [{ ...body.observations[0], evidenceRefs: ["r999"] }] } })).toThrow();
  });

  it("accepts supplied facts and rejects a mismatched batch envelope", () => {
    const input = validateBillAnalysisRequest(request);
    expect(validateBillAnalysisResponse(input, { schemaVersion: BILL_ANALYSIS_SCHEMA_VERSION, batchId: "b1", body })).toEqual(body);
    expect(() => validateBillAnalysisResponse(input, { schemaVersion: BILL_ANALYSIS_SCHEMA_VERSION, batchId: "b2", body })).toThrow();
    expect(() => validateBillAnalysisResponse(input, { schemaVersion: BILL_ANALYSIS_SCHEMA_VERSION, batchId: "b1", body, explanation: "private" })).toThrow();
  });

  it.each([
    ["extra household context", { ...request, householdId: "foreign" }],
    ["impossible date", { ...request, range: { from: "2026-02-30", to: "2026-03-01" } }],
    ["fractional transaction", { ...request, rows: [{ ...request.rows[0], amountFen: 1.5 }] }],
    ["fractional persisted money metric", { ...request, metrics: [{ ...request.metrics[0], value: 1.5 }] }],
    ["fractional count metric", { ...request, metrics: [{ ...request.metrics[0], unit: "count", value: 1.5 }] }],
    ["real member field", { ...request, rows: [{ ...request.rows[0], memberId: "private-member" }] }],
    ["duplicate row", { ...request, rows: [request.rows[0], request.rows[0]] }],
    ["out-of-range row", { ...request, rows: [{ ...request.rows[0], date: "2026-09-30" }] }],
    ["too many rows", { ...request, rows: Array.from({ length: 501 }, (_, index) => ({ ...request.rows[0], ref: `r${index + 1}` })) }],
    ["oversized note", { ...request, rows: [{ ...request.rows[0], note: "x".repeat(256 * 1024) }] }],
    ["excess batch count", { ...request, batchCount: 25 }],
  ])("rejects %s before upstream work", (_name, value) => {
    expect(() => validateBillAnalysisRequest(value)).toThrow("Invalid bill analysis request");
  });

  it("bounds intermediate generated text and requires evidence for concrete advice", () => {
    const input = validateBillAnalysisRequest(request);
    for (const invalid of [
      { ...body, overview: "汉".repeat(1500) },
      { ...body, recommendations: [{ title: "Unsupported", detail: "No supplied fact", evidenceRefs: [] }] },
      { ...body, observations: [{ ...body.observations[0], evidenceRefs: ["r1", "r1"] }] },
    ]) expect(() => validateBillAnalysisResponse(input, { schemaVersion: BILL_ANALYSIS_SCHEMA_VERSION, batchId: "b1", body: invalid })).toThrow();
  });

  it("allows fractional ratios without treating them as financial amounts", () => {
    expect(validateBillAnalysisRequest({ ...request, metrics: [{ ref: "current.share", label: "Share", unit: "ratio", value: 0.5 }] }).metrics[0].value).toBe(0.5);
  });
});
