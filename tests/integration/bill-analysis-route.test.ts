import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { parseReconciliationApplyInput } from "@/lib/reports/bill-reconciliation-application-protocol";

const state = vi.hoisted(() => ({
  session: { id: "account", householdId: "household", memberId: "member", appSessionId: "session", role: "OWNER" },
  generate: vi.fn(), query: vi.fn(), cancel: vi.fn(), read: vi.fn(), list: vi.fn(), entries: vi.fn(), abort: vi.fn(), apply: vi.fn(), queryApplication: vi.fn(), trackingFails: false,
  tracked: [] as Promise<void>[], contexts: [] as Array<{ disposed: boolean }>, readOptions: [] as Array<{ readOnly?: boolean }>,
}));
vi.mock("next/server", () => ({ after: (completion: Promise<void>) => {
  if (state.trackingFails) throw new Error("Tracking unavailable");
  state.tracked.push(completion);
} }));
vi.mock("@/lib/auth/session", () => ({ requireAppSession: async () => state.session }));
vi.mock("@/lib/i18n-server", () => ({ getServerLocale: async () => "zh-CN" }));
vi.mock("@/lib/encryption/request", () => ({
  parseEncryptionInput: (input: unknown) => input,
  withHouseholdEncryption: async (_input: unknown, work: (session: typeof state.session) => Promise<unknown>, options: { readOnly?: boolean }) => {
    state.readOptions.push(options);
    return work(state.session);
  },
}));
vi.mock("@/lib/reports/bill-analysis-task-context", async (importOriginal) => {
  const actual = await importOriginal<typeof import("@/lib/reports/bill-analysis-task-context")>();
  return { ...actual, createBillAnalysisTaskContext: async () => {
    const context = { session: state.session, mode: "UNENCRYPTED", configMode: "UNENCRYPTED", revision: 0,
      ring: null, expiresAt: Date.now() + 600_000, disposed: false, readOnly: false };
    state.contexts.push(context);
    return context;
  } };
});
vi.mock("@/lib/reports/bill-analysis-service", () => ({
  generateBillAnalysis: (...args: unknown[]) => state.generate(...args),
  billAnalysisErrorCode: (error: unknown) => error instanceof Error && error.message === "Unauthorized" ? "UNAUTHORIZED" : "UNAVAILABLE",
}));
vi.mock("@/lib/reports/bill-analysis-store", () => ({
  BillAnalysisStoreError: class extends Error { constructor(readonly code: string) { super(code); } },
  queryBillAnalysisRequest: (...args: unknown[]) => state.query(...args),
  cancelBillAnalysisRequest: (...args: unknown[]) => state.cancel(...args),
  readBillAnalysisReport: (...args: unknown[]) => state.read(...args),
  listBillAnalysisReports: (...args: unknown[]) => state.list(...args),
  listBillAnalysisEntries: (...args: unknown[]) => state.entries(...args),
}));
vi.mock("@/lib/reports/bill-analysis-owner", () => ({ abortBillAnalysisExecution: (...args: unknown[]) => state.abort(...args), reapStoppedBillAnalysisExecutions: async () => 0 }));
vi.mock("@/lib/reports/bill-reconciliation-application", () => ({ applyBillReconciliation: (...args: unknown[]) => state.apply(...args), queryBillReconciliationApplication: (...args: unknown[]) => state.queryApplication(...args) }));

import { POST } from "@/app/api/reports/reconcile/route";
import { BillAnalysisStoreError } from "@/lib/reports/bill-analysis-store";

const scope = { mode: "month", period: "2026-10", ledgerId: null, actorMemberId: null };
function request(body: unknown, headers: Record<string, string> = {}, signal?: AbortSignal) {
  return new Request("http://127.0.0.1:2500/api/reports/reconcile", { method: "POST", headers: {
    origin: "http://127.0.0.1:2500", host: "127.0.0.1:2500", "content-type": "application/json", "sec-fetch-site": "same-origin", ...headers,
  }, body: JSON.stringify(body), signal });
}
beforeEach(async () => {
  await Promise.all(state.tracked);
  vi.clearAllMocks(); state.trackingFails = false; state.tracked = []; state.contexts = []; state.readOptions = [];
  state.generate.mockImplementation(async (_session, input, _signal, emit) => {
    emit({ type: "progress", requestId: input.requestId, phase: "preparing" });
    return { requestId: input.requestId, status: "success", reportId: "report", generation: 1 };
  });
  state.query.mockImplementation(async (_session, requestId) => ({ requestId, status: "error", error: "NOT_ACCEPTED" }));
  state.entries.mockResolvedValue({ entries: [], cursor: null, active: null });
});

describe("analysis POST submission and observation boundary", () => {
  it("passes only the validated application contract across the HTTP envelope", async () => {
    state.apply.mockImplementation(async (_session, value) => {
      const input = parseReconciliationApplyInput(value);
      return { requestId: input.requestId, status: "success", reportId: input.reportId, generation: input.generation, suggestionIds: input.suggestionIds };
    });
    const input = { requestId: randomUUID(), reportId: "report", generation: 1, suggestionIds: ["s1"] };
    const response = await POST(request({ operation: "apply", ...input }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { ...input, status: "success" } });
    expect(state.apply).toHaveBeenCalledWith(state.session, input);
  });

  it("rejects cross-origin, oversized, invalid-scope and client-budget requests before generation", async () => {
    const body = { operation: "generate", requestId: randomUUID(), scope, locale: "zh-CN" };
    expect((await POST(request(body, { origin: "https://example.com" }))).status).toBe(403);
    expect((await POST(request(body, { "content-length": "17000" }))).status).toBe(413);
    expect((await POST(request({ ...body, scope: { ...scope, period: "2026-99" } }))).status).toBe(400);
    expect((await POST(request({ ...body, timeoutMs: 900000 }))).status).toBe(400);
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("returns a JSON submission receipt with private no-store headers", async () => {
    const requestId = randomUUID();
    const response = await POST(request({ operation: "generate", requestId, scope, locale: "zh-CN" }));
    expect(response.headers.get("cache-control")).toBe("no-store");
    expect(response.headers.get("referrer-policy")).toBe("no-referrer");
    expect(response.headers.get("content-type")).toContain("application/json");
    expect(await response.json()).toEqual({ result: { requestId, status: "success", reportId: "report", generation: 1 } });
  });

  it("preserves unknown status when background completion cannot confirm its database result", async () => {
    state.generate.mockRejectedValue(new Error("Commit result unavailable"));
    const requestId = randomUUID();
    const response = await POST(request({ operation: "generate", requestId, scope, locale: "zh-CN" }));
    expect(await response.json()).toEqual({ result: { requestId, status: "unknown" } });
  });

  it("returns before analysis completes and does not cancel the execution when the client disconnects", async () => {
    const requestId = randomUUID();
    const client = new AbortController();
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    let executionSignal: AbortSignal | undefined;
    state.generate.mockImplementation(async (_session, _input, signal, _emit, _startedAt, submitted) => {
      executionSignal = signal;
      submitted({ requestId, status: "processing" });
      await waiting;
      return { requestId, status: "success", reportId: "report", generation: 1 };
    });
    try {
      const response = await POST(request({ operation: "generate", requestId, scope, locale: "zh-CN" }, {}, client.signal));
      expect(await response.json()).toEqual({ result: { requestId, status: "processing" } });
      expect(state.contexts[0].disposed).toBe(false);
      client.abort();
      expect(executionSignal?.aborted).toBe(false);
    } finally { finish(); await Promise.all(state.tracked); }
    expect(state.contexts[0].disposed).toBe(true);
  });

  it("tracks cleanup before executing and disposes its context if tracking registration fails", async () => {
    state.trackingFails = true;
    const response = await POST(request({ operation: "generate", requestId: randomUUID(), scope, locale: "zh-CN" }));
    expect(response.status).toBe(503);
    expect(state.generate).not.toHaveBeenCalled();
    expect(state.contexts[0].disposed).toBe(true);
  });

  it("runs one local execution for repeated UUIDs and rejects changed input", async () => {
    const requestId = randomUUID();
    let finish!: () => void;
    const waiting = new Promise<void>((resolve) => { finish = resolve; });
    state.generate.mockImplementation(async (_session, _input, _signal, _emit, _startedAt, submitted) => {
      submitted({ requestId, status: "processing" });
      await waiting;
      return { requestId, status: "success", reportId: "report", generation: 1 };
    });
    const body = { operation: "generate", requestId, scope, locale: "zh-CN" };
    try {
      await POST(request(body));
      expect(await (await POST(request(body))).json()).toEqual({ result: { requestId, status: "processing" } });
      expect(await (await POST(request({ ...body, scope: { ...scope, period: "2026-09" } }))).json()).toEqual({ result: { requestId, status: "error", error: "CONFLICT" } });
      expect(state.generate).toHaveBeenCalledTimes(1);
      expect(state.contexts.map((context) => context.disposed)).toEqual([false, true, true]);
    } finally { finish(); await Promise.all(state.tracked); }
  });

  it("discovers family entries through a read-only operation without closing UUIDs", async () => {
    const response = await POST(request({ operation: "entries" }));
    expect(await response.json()).toEqual({ entries: [], cursor: null, active: null });
    expect(state.readOptions).toEqual([{ readOnly: true, receiptQuery: false }]);
    expect(state.query).not.toHaveBeenCalled();
    expect(state.cancel).not.toHaveBeenCalled();
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("queries without original financial input and treats another original session as conflict without logging out", async () => {
    const requestId = randomUUID();
    expect(await (await POST(request({ operation: "query", requestId }))).json()).toEqual({ result: { requestId, status: "error", error: "NOT_ACCEPTED" } });
    state.query.mockRejectedValue(new BillAnalysisStoreError("CONFLICT"));
    const response = await POST(request({ operation: "query", requestId }));
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ result: { requestId, status: "error", error: "CONFLICT" } });
    expect(state.generate).not.toHaveBeenCalled();
  });

  it("aborts a local execution only after the durable stopping result", async () => {
    const requestId = randomUUID();
    state.cancel.mockResolvedValue({ requestId, status: "stopping" });
    expect(await (await POST(request({ operation: "cancel", requestId }))).json()).toEqual({ result: { requestId, status: "stopping" } });
    expect(state.abort).toHaveBeenCalledWith(state.session, requestId);
    state.abort.mockClear();
    state.cancel.mockResolvedValue({ requestId, status: "success", reportId: "report", generation: 1 });
    await POST(request({ operation: "cancel", requestId }));
    expect(state.abort).not.toHaveBeenCalled();
  });
});
