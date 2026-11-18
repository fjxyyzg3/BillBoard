import { describe, expect, it, vi } from "vitest";
import { NaturalLanguageController } from "@/lib/transactions/natural-language-controller";
import type { NaturalLanguageActionResult } from "@/lib/transactions/natural-language-types";
import type { EntryContext } from "@/lib/transactions/entry-context";

const requestId = "00000000-0000-4000-8000-000000000001";
const success = { status: "success", requestId, resultVersion: 2, count: 1, incomeCount: 0, expenseCount: 1,
  incomeAmountFen: 0, expenseAmountFen: 3500 } as const;

function setup(context?: EntryContext) {
  const data = new Map<string, string>();
  const storage = { getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
    removeItem: vi.fn((key: string) => { data.delete(key); }) };
  const submit = vi.fn(async (): Promise<NaturalLanguageActionResult> => success);
  const query = vi.fn(async (): Promise<NaturalLanguageActionResult> => success);
  const controller = new NaturalLanguageController({ memberId: context?.memberId ?? "member", context, legacyDefaultLedgerId: context?.ledgerId, storage: () => storage,
    uuid: () => requestId, submit, query });
  return { controller, storage, data, submit, query };
}

describe("shared natural-language request ownership", () => {
  it("keeps per-ledger text drafts in memory and clears them when the identity exits", async () => {
    const context = { householdId: "household", memberId: "member", ledgerId: "daily" };
    const travel = { ...context, ledgerId: "travel" };
    const { controller, data } = setup(context);
    await controller.initialize();
    controller.setTextDraft("Lunch 35 CNY", context);
    controller.setTarget(travel, "Travel");
    controller.setTextDraft("Taxi 22 CNY", travel);
    expect(controller.getTextDraft(context)).toBe("Lunch 35 CNY");
    expect(controller.getTextDraft(travel)).toBe("Taxi 22 CNY");
    expect(data.size).toBe(0);
    controller.dispose();
    expect(controller.getTextDraft(context)).toBe("");
    expect(controller.getTextDraft(travel)).toBe("");
  });

  it.each([false, true])("clears only its own successful text snapshot when a newer draft exists: %s", async (hasNewerDraft) => {
    const context = { householdId: "household", memberId: "member", ledgerId: "daily" };
    const { controller, submit, data } = setup(context);
    let finish!: (result: NaturalLanguageActionResult) => void;
    submit.mockImplementationOnce(() => new Promise((resolve) => { finish = resolve; }));
    await controller.initialize();
    controller.setTextDraft("Lunch 35 CNY", context);
    controller.submit(controller.textDraftSource(context), "Lunch 35 CNY", "en-US");
    if (hasNewerDraft) controller.setTextDraft("Lunch 42 CNY", context);
    expect([...data.values()]).toEqual([requestId]);
    finish(success);
    await vi.waitFor(() => expect(controller.getSnapshot().feedback?.result).toEqual(success));
    expect(controller.getTextDraft(context)).toBe(hasNewerDraft ? "Lunch 42 CNY" : "");
    expect(data.size).toBe(0);
  });

  it("restores a legacy UUID only through the original default target while another ledger is selected", async () => {
    const original = { householdId: "household", memberId: "member", ledgerId: "daily" };
    const selected = { ...original, ledgerId: "travel" };
    const data = new Map([["billboard:natural-language-pending:v1:member", requestId]]);
    const storage = { getItem: (key: string) => data.get(key) ?? null, setItem: (key: string, value: string) => { data.set(key, value); }, removeItem: (key: string) => { data.delete(key); } };
    const query = vi.fn(async () => ({ status: "processing" as const, requestId }));
    const submit = vi.fn();
    const controller = new NaturalLanguageController({ memberId: "member", context: selected, ledgerName: "Travel", legacyDefaultLedgerId: original.ledgerId,
      targets: [{ context: original, ledgerName: "Daily" }, { context: selected, ledgerName: "Travel" }], storage: () => storage, uuid: () => requestId, query, submit });
    await controller.initialize();
    expect(controller.getSnapshot().pending?.target).toEqual({ context: original, ledgerName: "Daily" });
    expect(query).toHaveBeenCalledWith(requestId, 2, original);
    expect(submit).not.toHaveBeenCalled();
    expect(data.get("billboard:natural-language-pending:v2:household:member:daily")).toBe(requestId);
    expect(data.has("billboard:natural-language-pending:v2:household:member:travel")).toBe(false);
    controller.dispose();
  });

  it("does not adopt a legacy UUID without an explicit original default marker", async () => {
    const context = { householdId: "household", memberId: "member", ledgerId: "travel" };
    const query = vi.fn();
    // Only the old format exists; the scoped key is absent.
    const data = new Map([["billboard:natural-language-pending:v1:member", requestId]]);
    const isolated = new NaturalLanguageController({ memberId: "member", context, storage: () => ({ getItem: (key) => data.get(key) ?? null, setItem: () => {}, removeItem: () => {} }), uuid: () => requestId, query, submit: vi.fn() });
    await isolated.initialize();
    expect(query).not.toHaveBeenCalled();
    expect(isolated.getSnapshot().pending).toBeNull();
    isolated.dispose();
  });

  it("keeps one pending request on its original ledger when the next target changes", async () => {
    const context = { householdId: "household", memberId: "member", ledgerId: "daily" };
    const { controller, submit, query, data } = setup(context);
    submit.mockRejectedValueOnce(new Error("offline"));
    await controller.initialize();
    controller.submit("text", "Lunch 35 CNY", "en-US");
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("unknown"));
    controller.setTarget({ ...context, ledgerId: "travel" }, "Travel");
    expect(controller.submit("text", "Train 25 CNY", "en-US")).toBe("busy");
    expect(controller.getSnapshot().pending?.target?.context.ledgerId).toBe("daily");
    await controller.confirm();
    expect(query).toHaveBeenCalledWith(requestId, 2, context);
    expect(submit).toHaveBeenCalledOnce();
    expect(data.size).toBe(0);
    expect(controller.getSnapshot().feedback?.target?.context).toEqual(context);
  });

  it("migrates only the original member's pending UUID into its fixed default ledger", async () => {
    const context = { householdId: "household", memberId: "member", ledgerId: "ledger" };
    const { controller, data, query, submit } = setup(context);
    data.set("billboard:natural-language-pending:v1:member", requestId);
    query.mockResolvedValueOnce({ status: "processing", requestId });
    await controller.initialize();
    expect(query).toHaveBeenCalledWith(requestId, 2, context);
    expect(submit).not.toHaveBeenCalled();
    expect([...data.entries()]).toEqual([["billboard:natural-language-pending:v2:household:member:ledger", requestId]]);
    const rejoined = setup({ ...context, memberId: "rejoined" });
    rejoined.data.set("billboard:natural-language-pending:v1:member", requestId);
    await rejoined.controller.initialize();
    expect(rejoined.query).not.toHaveBeenCalled();
  });

  it("captures an immutable request context and drops late feedback when the identity exits", async () => {
    const context = { householdId: "household", memberId: "member", ledgerId: "ledger" };
    const { controller, submit } = setup(context);
    let complete!: (result: NaturalLanguageActionResult) => void;
    submit.mockImplementationOnce(() => new Promise((resolve) => { complete = resolve; }));
    await controller.initialize();
    context.ledgerId = "other-ledger";
    controller.submit("text", "Lunch 35 CNY", "en-US");
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ context: { householdId: "household", memberId: "member", ledgerId: "ledger" } }));
    controller.dispose();
    complete(success);
    await Promise.resolve();
    expect(controller.getSnapshot()).toMatchObject({ ready: false, pending: null, feedback: null });
  });

  it("keeps the server snapshot stable while a streamed page hydrates after initialization", async () => {
    const { controller } = setup();
    const serverSnapshot = controller.getServerSnapshot();
    await controller.initialize();
    expect(controller.getSnapshot().ready).toBe(true);
    expect(controller.getServerSnapshot()).toBe(serverSnapshot);
    expect(controller.getServerSnapshot().ready).toBe(false);
  });

  it("reserves recording through transcription and atomically hands it to one ledger request", async () => {
    const { controller, submit, query } = setup();
    await controller.initialize();
    const token = controller.reserve();
    expect(token).not.toBeNull();
    expect(controller.reserve()).toBeNull();
    expect(controller.submit("text-form", "Lunch 35 CNY", "en-US")).toBe("busy");
    expect(query).not.toHaveBeenCalled();
    expect(controller.submit("voice", "Lunch 35 CNY", "en-US", token!)).toBe("started");
    expect(controller.getSnapshot().pending?.source).toBe("voice");
    expect(controller.reserve()).toBeNull();
    await vi.waitFor(() => expect(controller.getSnapshot().feedback?.result).toEqual(success));
    expect(submit).toHaveBeenCalledTimes(1);
    expect(controller.getSnapshot().feedback?.source).toBe("voice");
    expect(controller.getSnapshot().pending).toBeNull();
  });

  it("ignores a cancelled token and never queries an ASR-only operation", async () => {
    const { controller, submit, query } = setup();
    await controller.initialize();
    const token = controller.reserve()!;
    controller.release(token);
    await controller.confirm();
    expect(controller.submit("voice", "Lunch 35 CNY", "en-US", token)).toBe("busy");
    expect(submit).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(controller.reserve()).not.toBeNull();
  });

  it.each(["write", "read", "mismatch"])("fails closed for voice when UUID storage %s fails", async (failure) => {
    const { controller, storage, submit } = setup();
    await controller.initialize();
    if (failure === "write") storage.setItem.mockImplementation(() => { throw new Error("denied"); });
    else if (failure === "read") storage.getItem.mockImplementation(() => { throw new Error("denied"); });
    else storage.getItem.mockReturnValue("another-id");
    const token = controller.reserve()!;
    expect(controller.submit("voice", "Lunch 35 CNY", "en-US", token)).toBe("storage-unavailable");
    expect(submit).not.toHaveBeenCalled();
    expect(controller.getSnapshot().pending).toBeNull();
    expect(controller.getSnapshot().reservation).toBeNull();
  });

  it("preserves the original text entry storage fallback", async () => {
    const { controller, storage, submit } = setup();
    await controller.initialize();
    storage.setItem.mockImplementation(() => { throw new Error("denied"); });
    expect(controller.submit("text-form", "Lunch 35 CNY", "en-US")).toBe("started");
    await vi.waitFor(() => expect(submit).toHaveBeenCalledTimes(1));
  });

  it("confirms only the same UUID after a lost response and excludes competing entries", async () => {
    const { controller, submit, query, data } = setup();
    submit.mockRejectedValueOnce(new Error("offline"));
    await controller.initialize();
    controller.submit("text-form", "Lunch 35 CNY", "en-US");
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("unknown"));
    expect([...data.values()]).toEqual([requestId]);
    expect(controller.reserve()).toBeNull();
    await controller.confirm();
    expect(query).toHaveBeenCalledWith(requestId, 2);
    expect(submit).toHaveBeenCalledTimes(1);
    expect(data.size).toBe(0);
  });

  it("restores only a UUID without guessing or clearing an input source", async () => {
    const { controller, data, submit, query } = setup();
    data.set("billboard:natural-language-pending:v1:member", requestId);
    await controller.initialize();
    expect(submit).not.toHaveBeenCalled();
    expect(query).toHaveBeenCalledOnce();
    expect(controller.getSnapshot().feedback).toMatchObject({ source: null, snapshotText: null, result: success });
  });

  it("keeps an incompatible success unknown and preserves correction fragments for the source", async () => {
    const { controller, submit, query } = setup();
    submit.mockResolvedValueOnce({ status: "success", requestId, count: 1, totalAmountFen: 3500 } as unknown as NaturalLanguageActionResult);
    query.mockResolvedValueOnce({ status: "error", requestId, code: "NEEDS_CORRECTION",
      issues: [{ code: "missing_amount", start: 0, end: 5 }] });
    await controller.initialize();
    controller.submit("voice", "Lunch amount forgotten", "en-US", controller.reserve()!);
    await vi.waitFor(() => expect(controller.getSnapshot().phase).toBe("unknown"));
    await controller.confirm();
    expect(controller.getSnapshot().feedback).toMatchObject({ source: "voice", snapshotText: "Lunch amount forgotten",
      result: { status: "error", code: "NEEDS_CORRECTION" } });
  });
});
