import { randomUUID } from "node:crypto";
import { expect, it, vi } from "vitest";

const state = vi.hoisted(() => ({ submit: vi.fn(async () => ({ status: "processing" })) }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireAppSession: async () => ({
  id: "account", memberId: "member", householdId: "household", appSessionId: "session",
}) }));
vi.mock("@/lib/encryption/request", () => ({ parseEncryptionInput: () => undefined, withHouseholdEncryption: vi.fn() }));
vi.mock("@/lib/i18n-server", () => ({ getServerLocale: async () => "zh-CN" }));
vi.mock("@/lib/reports/bill-analysis-service", () => ({ billAnalysisErrorCode: () => "UNAVAILABLE" }));
vi.mock("@/lib/reports/bill-analysis-runtime", () => ({ submitBillAnalysisTask: (...args: unknown[]) => state.submit(...args as []) }));
vi.mock("@/lib/reports/bill-analysis-task-context", () => ({ createBillAnalysisTaskContext: async () => ({}) }));
vi.mock("@/lib/reports/bill-analysis-store", () => ({
  queryBillAnalysisRequest: vi.fn(), cancelBillAnalysisRequest: vi.fn(), readBillAnalysisReport: vi.fn(),
  listBillAnalysisReports: vi.fn(), listBillAnalysisEntries: vi.fn(), BillAnalysisStoreError: class extends Error {},
}));
vi.mock("@/lib/reports/bill-analysis-owner", () => ({ abortBillAnalysisExecution: vi.fn(), reapStoppedBillAnalysisExecutions: vi.fn() }));

import { POST } from "@/app/api/reports/analyze/route";

it("refuses new legacy analysis jobs without starting an owner or borrowing consent", async () => {
  const response = await POST(new Request("http://127.0.0.1:2500/api/reports/analyze", {
    method: "POST", headers: { origin: "http://127.0.0.1:2500", host: "127.0.0.1:2500", "content-type": "application/json", "sec-fetch-site": "same-origin" },
    body: JSON.stringify({ operation: "generate", requestId: randomUUID(), locale: "zh-CN", scope: { mode: "month", period: "2026-10", ledgerId: null, actorMemberId: null } }),
  }));
  expect(response.status).toBe(410);
  expect(await response.json()).toEqual({ error: "INVALID" });
  expect(response.headers.get("cache-control")).toBe("no-store");
  expect(state.submit).not.toHaveBeenCalled();
});
