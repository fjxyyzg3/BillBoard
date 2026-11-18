import { describe, expect, it, vi } from "vitest";
import { defaultReconciliationSelection, MAX_RECONCILIATION_APPLICATION_POINTERS, reconciliationApplicationStorageKey, RECONCILIATION_APPLICATION_STORAGE_KEY, ReconciliationApplicationController, toggleReconciliationSelection } from "@/lib/reports/bill-reconciliation-controller";
import type { BillReconciliationReportDto, ReconciliationSuggestion } from "@/lib/reports/bill-reconciliation-types";

const requestId = "00000000-0000-4000-8000-000000000001";
const suggestion = (id: string, refs: string[], changes: Partial<ReconciliationSuggestion> = {}): ReconciliationSuggestion => ({
  id, kind: "duplicate", title: "Duplicate", reason: "Same recorded payment", evidenceRefs: refs, confidence: "high", defaultSelected: true,
  canApply: true, readOnlyReason: null, actions: refs.map((ref, index) => ({ ref, action: index ? "delete" : "keep", amountFen: 10000 })), ...changes,
});
const report: BillReconciliationReportDto = {
  purpose: "reconciliation", version: 1, id: "report", generation: 3,
  scope: { mode: "year", period: "2026", ledgerId: null, actorMemberId: null }, scopeLabels: { member: "Member", ledger: "Ledger" },
  locale: "en-US", generatedAt: "2026-11-05T00:00:00.000Z", snapshotAt: "2026-11-05T00:00:00.000Z", range: { from: "2026-01-01", to: "2026-11-05" },
  records: [], suggestions: [suggestion("s1", ["r1", "r2"])],
};
const success = { requestId, status: "success", reportId: report.id, generation: report.generation, suggestionIds: ["s1"] };
const pointer = { identity: "household:member", version: 1, requestId, reportId: report.id, generation: report.generation };
function setup(request: (body: Record<string, unknown>, signal?: AbortSignal) => Promise<Response>, data = new Map<string, string>(), identity = "household:member", uuid = () => requestId) {
  const controller = new ReconciliationApplicationController({ identity, uuid, request,
    storage: () => ({ get length() { return data.size; }, key: (index: number) => [...data.keys()][index] ?? null,
      getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } }),
  });
  return { controller, data };
}

describe("reconciliation selection", () => {
  it("preselects only actionable high-confidence suggestions and leaves overlapping choices unselected", () => {
    const choices = [suggestion("s1", ["r1", "r2"]), suggestion("s2", ["r2", "r3"]), suggestion("s3", ["r4"], { confidence: "review" }),
      suggestion("s4", ["r5"], { canApply: false }), suggestion("s5", ["r6"], { applied: true })];
    expect(defaultReconciliationSelection(choices)).toEqual(["s1"]);
    expect(toggleReconciliationSelection(choices, ["s1"], "s2")).toEqual(["s2"]);
    expect(toggleReconciliationSelection(choices, ["s2"], "s4")).toEqual(["s2"]);
    expect(toggleReconciliationSelection(choices, ["s2"], "s3")).toEqual(["s2", "s3"]);
  });
});

describe("reconciliation application recovery", () => {
  it("rejects an oversized encrypted request envelope before sending or saving its result pointer", async () => {
    const choices = Array.from({ length: 127 }, (_, index) => suggestion(`s${index}`.padEnd(125, "x"), [`r${index * 2 + 1}`, `r${index * 2 + 2}`]));
    const value = { ...report, suggestions: choices };
    const ids = choices.map((item) => item.id);
    const body = { operation: "apply", requestId, reportId: value.id, generation: value.generation, suggestionIds: [...ids].sort() };
    const encodedBytes = (input: Record<string, unknown>) => new TextEncoder().encode(JSON.stringify(input)).byteLength;
    const requestByteLength = (input: Record<string, unknown>) => encodedBytes({ ...input, encryption: { code: "a".repeat(64), revision: 1 } });
    expect(encodedBytes(body)).toBeLessThanOrEqual(16 * 1024);
    expect(requestByteLength(body)).toBeGreaterThan(16 * 1024);
    const request = vi.fn(async () => Response.json({ result: success }));
    const setItem = vi.fn();
    const controller = new ReconciliationApplicationController({ identity: pointer.identity, uuid: () => requestId, request, requestByteLength,
      storage: () => ({ getItem: () => null, setItem, removeItem: () => {}, length: 0, key: () => null }),
    });
    await controller.initialize();
    expect(controller.apply(value, ids)).toBe("invalid");
    expect(request).not.toHaveBeenCalled();
    expect(setItem).not.toHaveBeenCalled();
    expect(controller.getSnapshot().pending).toBeNull();
    const plainController = new ReconciliationApplicationController({ identity: pointer.identity, uuid: () => requestId, request,
      storage: () => ({ getItem: () => null, setItem, removeItem: () => {}, length: 0, key: () => null }),
    });
    await plainController.initialize();
    expect(plainController.apply(value, ids)).toBe("started");
    expect(request).toHaveBeenCalledOnce();
  });

  it("keeps the second tab’s unknown UUID when the first tab completes and both tabs close", async () => {
    const secondId = "00000000-0000-4000-8000-000000000002";
    const data = new Map<string, string>();
    let finishFirst!: (response: Response) => void;
    const first = setup(async () => new Promise<Response>((resolve) => { finishFirst = resolve; }), data);
    const second = setup(async () => { throw new Error("second response lost"); }, data, "household:member", () => secondId);
    await first.controller.initialize();
    await second.controller.initialize();
    first.controller.apply(report, ["s1"]);
    second.controller.apply({ ...report, id: "second-report" }, ["s1"]);
    await vi.waitFor(() => expect(second.controller.getSnapshot().phase).toBe("unknown"));
    finishFirst(Response.json({ result: success }));
    await vi.waitFor(() => expect(first.controller.getSnapshot().outcome?.status).toBe("success"));
    expect([...data.values()].some((raw) => JSON.parse(raw).requestId === secondId)).toBe(true);
    first.controller.dispose(true);
    second.controller.dispose(true);
    const request = vi.fn(async (body: Record<string, unknown>) => Response.json({ result: { requestId: body.requestId, status: "unknown" } }));
    const reopened = setup(request, data);
    await reopened.controller.initialize();
    expect(request.mock.calls.map(([body]) => body)).toEqual([{ operation: "query-application", requestId: secondId }]);
    expect(reopened.controller.getSnapshot().pending?.requestId).toBe(secondId);
  });

  it("freezes the original selection and stores only identity-bound result-check metadata", async () => {
    let finish!: (response: Response) => void;
    const request = vi.fn((_body: Record<string, unknown>) => new Promise<Response>((resolve) => { finish = resolve; }));
    const { controller, data } = setup(request);
    await controller.initialize();
    const selected = ["s1"];
    expect(controller.apply(report, selected)).toBe("started");
    selected.push("foreign");
    expect(controller.getSnapshot().selectionIds).toEqual(["s1"]);
    expect(controller.apply(report, ["s1"])).toBe("busy");
    await controller.confirm();
    expect(request).toHaveBeenCalledTimes(1);
    expect(request.mock.calls[0][0]).toEqual({ operation: "apply", requestId, reportId: "report", generation: 3, suggestionIds: ["s1"] });
    expect(JSON.parse(data.get(reconciliationApplicationStorageKey(pointer.identity, requestId))!)).toEqual(pointer);
    finish(Response.json({ result: success }));
    await vi.waitFor(() => expect(controller.getSnapshot().outcome?.status).toBe("success"));
    expect(data.size).toBe(0);
  });

  it("restores an unknown UUID after closing the client and queries it without replaying changes", async () => {
    const first = setup(async () => { throw new Error("response lost"); });
    await first.controller.initialize();
    first.controller.apply(report, ["s1"]);
    await vi.waitFor(() => expect(first.controller.getSnapshot().phase).toBe("unknown"));
    first.controller.dispose(true);
    const request = vi.fn(async (_body: Record<string, unknown>) => Response.json({ result: success }));
    const reopened = setup(request, first.data);
    await reopened.controller.initialize();
    expect(request.mock.calls.map(([body]) => body)).toEqual([{ operation: "query-application", requestId }]);
    expect(reopened.controller.getSnapshot()).toMatchObject({ pending: null, outcome: { status: "success", reportId: "report", generation: 3 } });
    expect(first.data.size).toBe(0);
  });

  it("queries every independently stored recovered UUID without deleting unknown results", async () => {
    const secondId = "00000000-0000-4000-8000-000000000002";
    const firstKey = reconciliationApplicationStorageKey(pointer.identity, requestId);
    const secondKey = reconciliationApplicationStorageKey(pointer.identity, secondId);
    const data = new Map([[firstKey, JSON.stringify(pointer)], [secondKey, JSON.stringify({ ...pointer, requestId: secondId, reportId: "second-report" })]]);
    const request = vi.fn(async (body: Record<string, unknown>) => Response.json({ result: { requestId: body.requestId, status: "unknown" } }));
    const { controller } = setup(request, data);
    await controller.initialize();
    await controller.confirm();
    expect(request.mock.calls.map(([body]) => body)).toEqual([{ operation: "query-application", requestId }, { operation: "query-application", requestId: secondId }]);
    expect(data.size).toBe(2);
  });

  it("returns to the first unknown UUID after checking the second and observes its later terminal result", async () => {
    const secondId = "00000000-0000-4000-8000-000000000002";
    const firstKey = reconciliationApplicationStorageKey(pointer.identity, requestId);
    const secondKey = reconciliationApplicationStorageKey(pointer.identity, secondId);
    const data = new Map([[firstKey, JSON.stringify(pointer)], [secondKey, JSON.stringify({ ...pointer, requestId: secondId, reportId: "second-report" })]]);
    let firstCalls = 0;
    const request = vi.fn(async (body: Record<string, unknown>) => Response.json({ result: body.requestId === requestId && ++firstCalls > 1 ? success : { requestId: body.requestId, status: "unknown" } }));
    const { controller } = setup(request, data);
    await controller.initialize();
    await controller.confirm();
    await controller.confirm();
    expect(request.mock.calls.map(([body]) => body.requestId)).toEqual([requestId, secondId, requestId]);
    expect(controller.getSnapshot().outcome?.status).toBe("success");
    expect(data.has(firstKey)).toBe(false);
    expect(data.has(secondKey)).toBe(true);
  });

  it("bounds recovery batches and does not overwrite existing pointers when the local admission limit is reached", async () => {
    const data = new Map<string, string>(Array.from({ length: MAX_RECONCILIATION_APPLICATION_POINTERS }, (_, index): [string, string] => {
      const id = `00000000-0000-4000-8000-${String(index + 10).padStart(12, "0")}`;
      return [reconciliationApplicationStorageKey(pointer.identity, id), JSON.stringify({ ...pointer, requestId: id })];
    }));
    const request = vi.fn(async (body: Record<string, unknown>) => Response.json({ result: { requestId: body.requestId, status: "unknown" } }));
    const { controller } = setup(request, data);
    await controller.initialize();
    expect(controller.apply(report, ["s1"])).toBe("busy");
    expect(data.size).toBe(MAX_RECONCILIATION_APPLICATION_POINTERS);
    expect(request.mock.calls.every(([body]) => body.operation === "query-application")).toBe(true);
  });

  it("keeps the original UUID when a request-level authentication error has no durable business result", async () => {
    const request = vi.fn(async (_body: Record<string, unknown>) => Response.json({ error: "UNAUTHORIZED" }, { status: 401 }));
    const { controller, data } = setup(request);
    await controller.initialize();
    controller.apply(report, ["s1"]);
    await vi.waitFor(() => expect(controller.getSnapshot().accessError).toBe("UNAUTHORIZED"));
    expect(controller.getSnapshot()).toMatchObject({ phase: "unknown", pending: { requestId }, outcome: null });
    expect(data.size).toBe(1);
    await controller.confirm();
    expect(request.mock.calls.map(([body]) => body.operation)).toEqual(["apply", "query-application"]);
    expect(data.size).toBe(1);
    expect(controller.getSnapshot().selectionIds).toEqual(["s1"]);
  });

  it("reports unavailable recovery storage when writing a per-request key fails or cannot be read back", async () => {
    const controller = new ReconciliationApplicationController({ identity: pointer.identity, uuid: () => requestId,
      storage: () => ({ getItem: () => null, setItem: () => {}, removeItem: () => {}, length: 0, key: () => null }),
      request: async () => Response.json({ result: { requestId, status: "unknown" } }),
    });
    await controller.initialize();
    controller.apply(report, ["s1"]);
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("unknown"));
    expect(controller.getSnapshot()).toMatchObject({ storageAvailable: false, pending: { requestId }, selectionIds: ["s1"] });
  });

  it("preserves an unknown result returned with a mode or identity error", async () => {
    const { controller, data } = setup(async () => Response.json({ result: { requestId, status: "unknown", error: "ENCRYPTION_CHANGED" } }));
    await controller.initialize();
    controller.apply(report, ["s1"]);
    await vi.waitFor(() => expect(controller.getSnapshot().accessError).toBe("ENCRYPTION_CHANGED"));
    expect(controller.getSnapshot().pending?.requestId).toBe(requestId);
    expect(data.size).toBe(1);
  });

  it("does not reconstruct a pending selection from current defaults after reopening", async () => {
    const data = new Map([[RECONCILIATION_APPLICATION_STORAGE_KEY, JSON.stringify(pointer)]]);
    const { controller } = setup(async () => Response.json({ result: { requestId, status: "unknown" } }), data);
    await controller.initialize();
    expect(controller.getSnapshot()).toMatchObject({ pending: { requestId, reportId: report.id }, selectionIds: null, phase: "unknown" });
    expect(JSON.parse(data.get(RECONCILIATION_APPLICATION_STORAGE_KEY)!)).toEqual(pointer);
  });

  it("uses an explicit persisted rejection as the terminal result without automatically starting a new UUID", async () => {
    const data = new Map([[RECONCILIATION_APPLICATION_STORAGE_KEY, JSON.stringify(pointer)]]);
    const request = vi.fn(async (_body: Record<string, unknown>) => Response.json({ result: { requestId, status: "error", error: "CONFLICT", affectedSuggestionIds: ["s1"] } }));
    const { controller } = setup(request, data);
    await controller.initialize();
    expect(controller.getSnapshot()).toMatchObject({ pending: null, outcome: { status: "error", error: "CONFLICT", reportId: report.id, generation: 3 } });
    expect(data.size).toBe(0);
    await controller.confirm();
    expect(request.mock.calls.map(([body]) => body.operation)).toEqual(["query-application"]);
  });

  it("clears another member’s pointer and ignores late results after identity disposal", async () => {
    let finish!: (response: Response) => void;
    const first = setup(async () => new Promise<Response>((resolve) => { finish = resolve; }));
    await first.controller.initialize();
    first.controller.apply(report, ["s1"]);
    first.controller.dispose(true);
    const request = vi.fn(async () => Response.json({ result: success }));
    const other = setup(request, first.data, "household:another-member");
    await other.controller.initialize();
    finish(Response.json({ result: success }));
    await Promise.resolve();
    expect(request).not.toHaveBeenCalled();
    expect(first.data.size).toBe(0);
    expect(first.controller.getSnapshot()).toMatchObject({ ready: false, pending: null, outcome: null });
  });

  it("rejects an empty, duplicate, read-only or overlapping selection without a request", async () => {
    const request = vi.fn(async () => Response.json({ result: success }));
    const { controller } = setup(request);
    await controller.initialize();
    expect(controller.apply(report, [])).toBe("invalid");
    expect(controller.apply(report, ["s1", "s1"])).toBe("invalid");
    expect(controller.apply({ ...report, suggestions: [suggestion("s1", ["r1"], { canApply: false })] }, ["s1"])).toBe("invalid");
    expect(controller.apply({ ...report, suggestions: [suggestion("s1", ["r1"]), suggestion("s2", ["r1"])] }, ["s1", "s2"])).toBe("invalid");
    expect(request).not.toHaveBeenCalled();
  });
});
