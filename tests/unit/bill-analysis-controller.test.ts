import { describe, expect, it, vi } from "vitest";
import { BillAnalysisController, billAnalysisScopeKey } from "@/lib/reports/bill-analysis-controller";
import type { BillAnalysisEntryDto, BillAnalysisOutcome, BillAnalysisScope } from "@/lib/reports/bill-analysis-types";

const requestId = "00000000-0000-4000-8000-000000000001";
const scope: BillAnalysisScope = { mode: "month", period: "2026-10", ledgerId: null, actorMemberId: null };
const success: BillAnalysisOutcome = { requestId, status: "success", reportId: "report", generation: 1 };

function setup(request: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<Response>, identity = "household:member", data = new Map<string, string>()) {
  const storage = { getItem: (key: string) => data.get(key) ?? null,
    setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
  const controller = new BillAnalysisController({ identity, uuid: () => requestId, storage: () => storage, request });
  return { controller, data };
}

function jsonResult(result: BillAnalysisOutcome) { return Response.json({ result }); }
function entriesResponse(entries: BillAnalysisEntryDto[] = [], active: BillAnalysisEntryDto | null = null, cursor: string | null = null) {
  return Response.json({ entries, active, cursor });
}
function entry(): BillAnalysisEntryDto {
  return {
    id: "slot", scope, scopeLabels: { ledger: "All ledgers", member: "All members" },
    updatedAt: "2026-11-02T00:00:00.000Z", report: null,
    task: { id: "task", status: "processing", phase: "analyzing", completedBatches: 2, totalBatches: 4,
      startedAt: "2026-11-02T00:00:00.000Z", updatedAt: "2026-11-02T00:00:01.000Z", canCancel: false },
  };
}

describe("bill analysis request ownership", () => {
  it("discovers a shared server task without any session storage pointer", async () => {
    const active = entry();
    const request = vi.fn(async (_body: Record<string, unknown>) => entriesResponse([active], active));
    const { controller, data } = setup(request);
    await controller.initialize();
    expect(controller.getSnapshot().pending?.scope).toEqual(scope);
    expect(controller.getSnapshot()).toMatchObject({ phase: "analyzing", completedBatches: 2, totalBatches: 4 });
    expect(data.size).toBe(0);
    expect(request.mock.calls.map(([body]) => body.operation)).toEqual(["entries"]);
  });

  it("becomes ready through read-only discovery without generating or querying an absent UUID", async () => {
    const request = vi.fn(async (_body: Record<string, unknown>) => entriesResponse());
    const { controller } = setup(request);
    await controller.initialize();
    expect(controller.getSnapshot()).toMatchObject({ ready: true, pending: null, entriesReady: true, entriesError: null });
    expect(request.mock.calls.map(([body]) => body)).toEqual([{ operation: "entries" }]);
  });

  it("accepts the short JSON receipt and preserves the original scope and locale while only querying it", async () => {
    const request = vi.fn(async (body: Record<string, unknown>) => body.operation === "entries" ? entriesResponse()
      : jsonResult(body.operation === "generate" ? { requestId, status: "processing", phase: "waiting", completedBatches: 10, totalBatches: 10 } : success));
    const { controller, data } = setup(request);
    await controller.initialize();
    const chosen = { ...scope };
    expect(controller.start(chosen, "zh-CN")).toBe("started");
    chosen.ledgerId = "different-ledger";
    expect(controller.start(chosen, "en-US")).toBe("busy");
    const pointer = JSON.parse([...data.values()][0]);
    expect(pointer).toEqual({ identity: "household:member", requestId, version: 1 });
    expect(JSON.stringify(pointer)).not.toContain("2026-10");
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("waiting"));
    expect(controller.getSnapshot().pending).toMatchObject({ scope, locale: "zh-CN", canCancel: true });
    await controller.confirm();
    expect(controller.getSnapshot().completedScope).toEqual(scope);
    expect(controller.getSnapshot().completedBatches).toBe(10);
    expect(request.mock.calls.map(([body]) => body)).toEqual([{ operation: "entries" }, { operation: "generate", requestId, scope, locale: "zh-CN" }, { operation: "query", requestId }]);
    expect(data.size).toBe(0);
  });

  it("restores only a UUID query and accepts the server's NOT_ACCEPTED terminal receipt", async () => {
    const request = vi.fn(async (body: Record<string, unknown>) => body.operation === "entries" ? entriesResponse() : jsonResult({ requestId, status: "error", error: "NOT_ACCEPTED" }));
    const data = new Map([["billboard:bill-analysis-pending:v1", JSON.stringify({ identity: "household:member", requestId, version: 1 })]]);
    const { controller } = setup(request, "household:member", data);
    await controller.initialize();
    expect(request.mock.calls.map(([body]) => body)).toEqual([{ operation: "query", requestId }, { operation: "entries" }]);
    expect(controller.getSnapshot()).toMatchObject({ pending: null, outcome: { error: "NOT_ACCEPTED" } });
    expect(data.size).toBe(0);
  });

  it("keeps an unknown UUID after a lost response and never automatically submits again", async () => {
    const request = vi.fn(async (body: Record<string, unknown>) => {
      if (body.operation === "entries") return entriesResponse();
      throw new Error("offline");
    });
    const { controller, data } = setup(request);
    await controller.initialize();
    controller.start(scope, "en-US");
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("unknown"));
    expect(controller.start({ ...scope, period: "2026-09" }, "en-US")).toBe("busy");
    await controller.observe();
    expect(request.mock.calls.map(([input]) => input.operation)).toEqual(["entries", "generate", "query", "entries"]);
    expect(data.size).toBe(1);
    expect(controller.getSnapshot().pending).toMatchObject({ scope, requestId, canCancel: false });
  });

  it("uses only read-only discovery while submission is in flight so observation cannot close admission", async () => {
    let finish!: (response: Response) => void;
    const request = vi.fn((body: Record<string, unknown>) => body.operation === "generate" ? new Promise<Response>((resolve) => { finish = resolve; })
      : Promise.resolve(body.operation === "entries" ? entriesResponse() : jsonResult({ requestId, status: "processing" })));
    const { controller } = setup(request);
    await controller.initialize();
    controller.start(scope, "en-US");
    await controller.observe();
    expect(request.mock.calls.map(([body]) => body.operation)).toEqual(["entries", "generate", "entries"]);
    finish(jsonResult({ requestId, status: "processing" }));
    await vi.waitFor(() => expect(controller.getSnapshot().pending?.canCancel).toBe(true));
    await controller.observe();
    expect(request.mock.calls.map(([body]) => body.operation)).toEqual(["entries", "generate", "entries", "query", "entries"]);
  });

  it("does not free a stopping request until cleanup reaches a terminal result", async () => {
    const request = vi.fn(async (body: Record<string, unknown>) => {
      if (body.operation === "entries") return entriesResponse();
      return jsonResult(body.operation === "generate" ? { requestId, status: "processing", phase: "analyzing" }
        : body.operation === "cancel" ? { requestId, status: "stopping" } : { requestId, status: "error", error: "CANCELLED" });
    });
    const { controller, data } = setup(request);
    await controller.initialize();
    controller.start(scope, "en-US");
    await vi.waitFor(() => expect(controller.getSnapshot().pending?.canCancel).toBe(true));
    await controller.cancel();
    expect(controller.getSnapshot().phase).toBe("stopping");
    expect(data.size).toBe(1);
    expect(controller.start(scope, "en-US")).toBe("busy");
    await controller.confirm();
    expect(controller.getSnapshot()).toMatchObject({ pending: null, outcome: { error: "CANCELLED" } });
    expect(data.size).toBe(0);
    expect(request.mock.calls.map(([body]) => body.operation)).toEqual(["entries", "generate", "cancel", "query"]);
  });

  it("ignores late results after identity disposal and clears a foreign recovery pointer", async () => {
    let finish!: (response: Response) => void;
    const request = vi.fn((body: Record<string, unknown>) => body.operation === "entries" ? Promise.resolve(entriesResponse()) : new Promise<Response>((resolve) => { finish = resolve; }));
    const { controller, data } = setup(request);
    await controller.initialize();
    controller.start(scope, "en-US");
    controller.dispose(true);
    const next = setup(async () => entriesResponse(), "household:rejoined-member", data).controller;
    await next.initialize();
    finish(jsonResult(success));
    await Promise.resolve();
    expect(data.size).toBe(0);
    expect(controller.getSnapshot()).toMatchObject({ ready: false, pending: null, outcome: null });
    expect(next.getSnapshot()).toMatchObject({ ready: true, pending: null, outcome: null });
  });

  it("stops observation without cancelling a submitted task and discovers its later completion", async () => {
    let completed = false;
    const active = entry();
    active.task = { ...active.task!, requestId, canCancel: true };
    const done = { ...active, task: { ...active.task!, status: "success" as const, canCancel: false }, report: {
      id: "report", scope, scopeLabels: active.scopeLabels, locale: "en-US" as const,
      generatedAt: "2026-11-02T00:00:05.000Z", snapshotAt: "2026-11-02T00:00:00.000Z", range: { from: "2026-10-01", to: "2026-10-31" }, generation: 2,
    } };
    const request = vi.fn(async (body: Record<string, unknown>) => body.operation === "generate" ? jsonResult({ requestId, status: "processing" })
      : completed ? entriesResponse([done]) : entriesResponse());
    const { controller } = setup(request);
    await controller.initialize();
    controller.start(scope, "en-US");
    await vi.waitFor(() => expect(controller.getSnapshot().pending?.canCancel).toBe(true));
    controller.interrupt();
    completed = true;
    await controller.discover();
    expect(controller.getSnapshot().outcome).toMatchObject({ status: "success", generation: 2 });
    expect(controller.getSnapshot().entries[0].report?.generation).toBe(2);
    expect(request.mock.calls.map(([body]) => body.operation)).toEqual(["entries", "generate", "entries"]);
  });

  it("discovers and generates when browser storage is unavailable", async () => {
    const request = vi.fn(async (body: Record<string, unknown>) => body.operation === "entries" ? entriesResponse() : jsonResult({ requestId, status: "processing" }));
    const controller = new BillAnalysisController({ identity: "household:member", uuid: () => requestId, request,
      storage: () => { throw new Error("blocked"); } });
    await controller.initialize();
    expect(controller.start(scope, "en-US")).toBe("started");
    await vi.waitFor(() => expect(controller.getSnapshot().pending?.canCancel).toBe(true));
    expect(controller.getSnapshot()).toMatchObject({ storageAvailable: false, pending: { requestId, scope } });
    expect(request.mock.calls.map(([body]) => body.operation)).toEqual(["entries", "generate"]);
  });

  it("does not query, cancel or take over a discovered task from another session", async () => {
    const active = entry();
    const request = vi.fn(async (_body: Record<string, unknown>) => entriesResponse([], active));
    const { controller } = setup(request);
    await controller.initialize();
    expect(controller.getSnapshot()).toMatchObject({ pending: { taskId: "task", canCancel: false }, entries: [active] });
    expect(controller.getSnapshot().pending?.requestId).toBeUndefined();
    await controller.cancel();
    await controller.confirm();
    expect(controller.start(scope, "en-US")).toBe("busy");
    expect(request.mock.calls.map(([body]) => body.operation)).toEqual(["entries", "entries"]);
  });

  it("allows explicit cancellation after the original session rediscovers its UUID", async () => {
    const active = entry();
    active.task = { ...active.task!, requestId, canCancel: true };
    const request = vi.fn(async (body: Record<string, unknown>) => body.operation === "entries" ? entriesResponse([active], active) : jsonResult({ requestId, status: "stopping" }));
    const { controller, data } = setup(request);
    await controller.initialize();
    expect(controller.getSnapshot().pending).toMatchObject({ requestId, canCancel: true });
    await controller.cancel();
    expect(controller.getSnapshot().phase).toBe("stopping");
    expect(data.size).toBe(0);
    expect(request.mock.calls.map(([body]) => body)).toEqual([{ operation: "entries" }, { operation: "cancel", requestId }]);
  });

  it("discards a pointer rejected by a new sign-in session and observes the shared task without taking it over", async () => {
    const active = entry();
    const request = vi.fn(async (body: Record<string, unknown>) => body.operation === "query" ? Response.json({ error: "CONFLICT" }, { status: 409 }) : entriesResponse([active], active));
    const data = new Map([["billboard:bill-analysis-pending:v1", JSON.stringify({ identity: "household:member", requestId, version: 1 })]]);
    const { controller } = setup(request, "household:member", data);
    await controller.initialize();
    expect(controller.getSnapshot().pending).toMatchObject({ taskId: "task", scope, canCancel: false });
    expect(controller.getSnapshot().pending?.requestId).toBeUndefined();
    expect(data.size).toBe(0);
    await controller.cancel();
    expect(request.mock.calls.map(([body]) => body.operation)).toEqual(["query", "entries"]);
  });

  it("keeps the superseded result of the original UUID readable without generating a replacement", async () => {
    const request = vi.fn(async (body: Record<string, unknown>) => {
      if (body.operation === "entries") return entriesResponse();
      if (body.operation === "query") return jsonResult({ ...success, superseded: true, generation: 2 });
      throw new Error("lost submission receipt");
    });
    const { controller } = setup(request);
    await controller.initialize();
    controller.start(scope, "en-US");
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("unknown"));
    await controller.confirm();
    expect(controller.getSnapshot().outcome).toMatchObject({ status: "success", superseded: true, generation: 2 });
    expect(request.mock.calls.map(([body]) => body.operation)).toEqual(["entries", "generate", "query"]);
  });

  it("preserves the last shared state as unknown after discovery fails without issuing replacement work", async () => {
    const active = entry();
    let offline = false;
    const request = vi.fn(async (_body: Record<string, unknown>) => {
      if (offline) throw new Error("offline");
      return entriesResponse([active], active);
    });
    const { controller } = setup(request);
    await controller.initialize();
    offline = true;
    await controller.observe();
    expect(controller.getSnapshot()).toMatchObject({ phase: "unknown", entries: [active], entriesError: "UNAVAILABLE", pending: { canCancel: false } });
    expect(request.mock.calls.map(([body]) => body.operation)).toEqual(["entries", "entries"]);
  });

  it("merges refreshed and paginated slots by stable ID while keeping the freshest task progress", async () => {
    const first = { ...entry(), task: null };
    const older = { ...first, id: "older", updatedAt: "2026-11-01T00:00:00.000Z" };
    let refresh = false;
    const request = vi.fn(async (body: Record<string, unknown>) => body.cursor ? entriesResponse([first, older])
      : entriesResponse([{ ...first, updatedAt: refresh ? "2026-11-03T00:00:00.000Z" : first.updatedAt }], null, "next"));
    const { controller } = setup(request);
    await controller.initialize();
    await controller.loadMoreEntries();
    refresh = true;
    await controller.discover();
    expect(controller.getSnapshot().entries.map((item) => item.id)).toEqual(["slot", "older"]);
    expect(controller.getSnapshot().entries[0].updatedAt).toBe("2026-11-03T00:00:00.000Z");
    expect(controller.getSnapshot().entriesCursor).toBeNull();
    expect(request.mock.calls.map(([body]) => body)).toEqual([{ operation: "entries" }, { operation: "entries", cursor: "next" }, { operation: "entries" }]);
  });

  it("rejects invalid cancellation credentials and progress without claiming task failure", async () => {
    const active = entry();
    active.task = { ...active.task!, canCancel: true, completedBatches: 5 };
    const request = vi.fn(async () => entriesResponse([active], active));
    const { controller } = setup(request);
    await controller.initialize();
    expect(controller.getSnapshot()).toMatchObject({ pending: null, entriesError: "INVALID_RESPONSE", outcome: null });
  });

  it("does not use the entry target when distinguishing report scopes", () => {
    expect(billAnalysisScopeKey(scope)).not.toBe(billAnalysisScopeKey({ ...scope, ledgerId: "travel" }));
    expect(billAnalysisScopeKey(scope)).not.toBe(billAnalysisScopeKey({ ...scope, actorMemberId: "former" }));
  });

  it("keeps report selection and original labels in memory while generation owns its fixed input", async () => {
    const request = vi.fn((body: Record<string, unknown>) => body.operation === "entries" ? Promise.resolve(entriesResponse()) : new Promise<Response>(() => {}));
    const { controller, data } = setup(request);
    await controller.initialize();
    const scopeLabels = { ledger: "Archived travel", member: "Former member" };
    controller.start(scope, "en-US", scopeLabels);
    scopeLabels.member = "Different selection";
    controller.focusReport("other-report", { ...scope, period: "2026-09" });
    expect(controller.getSnapshot().pending?.scope).toEqual(scope);
    expect(controller.getSnapshot().pending?.scopeLabels?.member).toBe("Former member");
    expect(controller.getSnapshot().focusedReport?.reportId).toBe("other-report");
    expect([...data.values()][0]).not.toMatch(/Archived|Former|2026|other-report/);
    expect(request.mock.calls.map(([body]) => body.operation)).toEqual(["entries", "generate"]);
    controller.dispose();
  });
});
