import { describe, expect, it } from "vitest";
import { resolveBillAnalysisRange } from "@/lib/reports/bill-analysis-snapshot";

const scope = { mode: "month" as const, period: "2026-03", ledgerId: null, actorMemberId: null };
describe("bill analysis uses the existing Shanghai comparison rules", () => {
  it("aligns an incomplete month to the Shanghai day and clamps the previous short month", () => {
    const result = resolveBillAnalysisRange(scope, new Date("2026-03-30T16:01:00Z"));
    expect(result.range).toEqual({ from: "2026-03-01", to: "2026-03-31" });
    expect(result.previous).toMatchObject({ range: { from: "2026-02-01", to: "2026-02-28" } });
    expect(result.yearAgo).toMatchObject({ range: { from: "2025-03-01", to: "2025-03-31" } });
  });
  it("uses one previous-year summary for annual reports and rejects future or invalid periods", () => {
    const result = resolveBillAnalysisRange({ ...scope, mode: "year", period: "2026" }, new Date("2026-11-02T02:00:00Z"));
    expect(result.range).toEqual({ from: "2026-01-01", to: "2026-11-02" });
    expect(result.previous).toMatchObject({ range: { from: "2025-01-01", to: "2025-11-02" } });
    expect(result.yearAgo).toBeNull();
    expect(() => resolveBillAnalysisRange({ ...scope, period: "2026-13" }, new Date())).toThrow();
    expect(() => resolveBillAnalysisRange({ ...scope, period: "9999-01" }, new Date())).toThrow();
  });
});
