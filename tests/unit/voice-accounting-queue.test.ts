import { afterEach, describe, expect, it, vi } from "vitest";
import { VoiceAccountingError, VoiceAccountingQueue } from "@/lib/voice/accounting-queue";
import type { Locale } from "@/lib/i18n";
import type { EntryContext } from "@/lib/transactions/entry-context";
import type { NaturalLanguageActionResult, NaturalLanguageEntryInput } from "@/lib/transactions/natural-language-types";

const firstId = "00000000-0000-4000-8000-000000000001";
const secondId = "00000000-0000-4000-8000-000000000002";
const thirdId = "00000000-0000-4000-8000-000000000003";
const storageKey = "billboard:voice-pending:v1:member";
const success = (requestId: string): NaturalLanguageActionResult => ({ status: "success", requestId,
  resultVersion: 2, count: 1, incomeCount: 0, expenseCount: 1, incomeAmountFen: 0, expenseAmountFen: 3500 });

function deferred<T>() {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((resolvePromise, rejectPromise) => { resolve = resolvePromise; reject = rejectPromise; });
  return { promise, resolve, reject };
}

async function flush() {
  for (let turn = 0; turn < 16; turn++) await Promise.resolve();
}

function setup(context?: EntryContext) {
  const data = new Map<string, string>();
  const storage = { getItem: vi.fn((key: string) => data.get(key) ?? null),
    setItem: vi.fn((key: string, value: string) => { data.set(key, value); }),
    removeItem: vi.fn((key: string) => { data.delete(key); }) };
  let nextId = 0;
  const transcribe = vi.fn(async (audio: Blob, _locale: Locale, _signal: AbortSignal) => audio.text());
  const submit = vi.fn(async (input: NaturalLanguageEntryInput) => success(input.requestId));
  const query = vi.fn(async (requestId: string, _version: number) => success(requestId));
  const queue = new VoiceAccountingQueue({ memberId: context?.memberId ?? "member", context, storage: () => storage,
    uuid: () => `00000000-0000-4000-8000-${String(++nextId).padStart(12, "0")}`, transcribe, submit, query });
  return { queue, data, storage, transcribe, submit, query };
}

afterEach(() => { vi.useRealTimers(); });

describe("background voice accounting queue", () => {
  it("bounds unfinished recordings and edited replacements without starting extra work", async () => {
    const { queue, transcribe, submit } = setup();
    const blocked = deferred<string>();
    transcribe.mockRejectedValueOnce(new VoiceAccountingError("no_speech"));
    transcribe.mockImplementation(() => blocked.promise);
    await queue.initialize();
    queue.enqueue(Promise.resolve(new Blob(["first"])), "en-US");
    await flush();
    expect(queue.getSnapshot().tasks[0]).toMatchObject({ id: firstId, phase: "failed" });
    for (let index = 0; index < 8; index++) queue.enqueue(Promise.resolve(new Blob(["queued"])), "en-US");
    await flush();
    expect(() => queue.enqueue(Promise.resolve(new Blob(["excess"])), "en-US")).toThrow("rate_limited");
    expect(() => queue.enqueueText(firstId, "Lunch 35 CNY", "en-US")).toThrow("rate_limited");
    expect(queue.getSnapshot().tasks).toHaveLength(9);
    expect(transcribe).toHaveBeenCalledTimes(2);
    expect(submit).not.toHaveBeenCalled();
    queue.dispose();
    blocked.resolve("Lunch 35 CNY");
    await flush();
  });

  it("shares one ordered queue across ledgers and queries each UUID on the original target", async () => {
    const context = { householdId: "household", memberId: "member", ledgerId: "daily" };
    const { queue, transcribe, submit, query } = setup(context);
    const transcript = deferred<string>();
    transcribe.mockImplementationOnce(() => transcript.promise);
    submit.mockRejectedValueOnce(new Error("offline"));
    await queue.initialize();
    queue.enqueue(Promise.resolve(new Blob(["Lunch 35 CNY"])), "en-US");
    await flush();
    queue.setTarget({ ...context, ledgerId: "travel" }, "Travel");
    queue.enqueue(Promise.resolve(new Blob(["Train 25 CNY"])), "en-US");
    expect(transcribe).toHaveBeenCalledOnce();
    transcript.resolve("Lunch 35 CNY");
    await flush();
    expect(queue.getSnapshot().tasks.map((task) => task.phase)).toEqual(["unknown", "queued"]);
    await queue.confirm(firstId);
    await flush();
    expect(query).toHaveBeenCalledWith(firstId, 2, context);
    expect(submit.mock.calls.map(([input]) => input.context?.ledgerId)).toEqual(["daily", "travel"]);
    expect(queue.getSnapshot().tasks.map((task) => task.target?.context.ledgerId)).toEqual(["daily", "travel"]);
    queue.dispose();
  });

  it("keeps the original ledger through transcription and scopes persisted UUIDs to that identity", async () => {
    const context = { householdId: "household", memberId: "member", ledgerId: "ledger" };
    const { queue, submit, transcribe, data } = setup(context);
    const transcript = deferred<string>();
    const result = deferred<NaturalLanguageActionResult>();
    transcribe.mockImplementationOnce(() => transcript.promise);
    submit.mockImplementationOnce(() => result.promise);
    await queue.initialize();
    queue.enqueue(Promise.resolve(new Blob(["Lunch 35 CNY"])), "en-US");
    await flush();
    context.ledgerId = "another-ledger";
    transcript.resolve("Lunch 35 CNY");
    await flush();
    expect(submit).toHaveBeenCalledWith(expect.objectContaining({ context: { householdId: "household", memberId: "member", ledgerId: "ledger" } }));
    expect([...data.entries()]).toEqual([["billboard:voice-pending:v2:household:member:ledger", JSON.stringify([firstId])]]);
    queue.dispose();
    result.resolve(success(firstId));
    await flush();
    expect(queue.getSnapshot()).toEqual({ ready: false, tasks: [] });
  });

  it("keeps a stable server snapshot while notifying subscribers of initialization", async () => {
    const { queue } = setup();
    const serverSnapshot = queue.getServerSnapshot();
    const changed = vi.fn();
    const unsubscribe = queue.subscribe(changed);
    await queue.initialize();
    expect(queue.getSnapshot()).toEqual({ ready: true, tasks: [] });
    expect(changed).toHaveBeenCalledOnce();
    expect(queue.getServerSnapshot()).toBe(serverSnapshot);
    expect(serverSnapshot).toEqual({ ready: false, tasks: [] });
    unsubscribe();
    queue.dispose();
    expect(changed).toHaveBeenCalledOnce();
  });

  it("accepts two recordings immediately and runs their transcription and accounting in order", async () => {
    const { queue, data, transcribe, submit, query } = setup();
    const firstAudio = deferred<Blob>();
    const firstText = deferred<string>();
    const firstResult = deferred<NaturalLanguageActionResult>();
    transcribe.mockImplementationOnce(() => firstText.promise);
    submit.mockImplementationOnce(() => firstResult.promise);
    await queue.initialize();
    expect(queue.enqueue(firstAudio.promise, "en-US")).toBe(firstId);
    expect(queue.enqueue(Promise.resolve(new Blob(["Dinner 40 CNY"])), "zh-CN")).toBe(secondId);
    expect(queue.getSnapshot().tasks).toHaveLength(2);
    expect(data.size).toBe(0);
    await queue.confirm(firstId);
    expect(query).not.toHaveBeenCalled();
    firstAudio.resolve(new Blob(["Lunch 35 CNY"]));
    await flush();
    expect(transcribe).toHaveBeenCalledOnce();
    expect(queue.getSnapshot().tasks.map(({ phase }) => phase)).toEqual(["transcribing", "queued"]);
    firstText.resolve("Lunch 35 CNY");
    await flush();
    expect(submit).toHaveBeenCalledWith({ requestId: firstId, text: "Lunch 35 CNY", locale: "en-US", resultVersion: 2 });
    expect(data.get(storageKey)).toBe(JSON.stringify([firstId]));
    expect(transcribe).toHaveBeenCalledOnce();
    firstResult.resolve(success(firstId));
    await flush();
    expect(submit).toHaveBeenNthCalledWith(2, { requestId: secondId, text: "Dinner 40 CNY", locale: "zh-CN", resultVersion: 2 });
    expect(queue.getSnapshot().tasks.map(({ id, phase, text, feedback }) => ({ id, phase, text, feedback }))).toEqual([
      { id: firstId, phase: "success", text: null, feedback: { source: "voice", snapshotText: null, result: success(firstId) } },
      { id: secondId, phase: "success", text: null, feedback: { source: "voice", snapshotText: null, result: success(secondId) } },
    ]);
    expect(data.size).toBe(0);
    queue.dispose();
  });

  it("rechecks a lost response with the original UUID and holds later recordings until it is known", async () => {
    vi.useFakeTimers();
    const { queue, submit, query, transcribe, data } = setup();
    const confirmation = deferred<NaturalLanguageActionResult>();
    submit.mockRejectedValueOnce(new Error("offline"));
    query.mockImplementationOnce(() => confirmation.promise);
    await queue.initialize();
    queue.enqueue(Promise.resolve(new Blob(["Lunch 35 CNY"])), "en-US");
    queue.enqueue(Promise.resolve(new Blob(["Dinner 40 CNY"])), "en-US");
    await flush();
    expect(queue.getSnapshot().tasks.map(({ phase }) => phase)).toEqual(["unknown", "queued"]);
    queue.dismiss(firstId);
    expect(data.get(storageKey)).toBe(JSON.stringify([firstId]));
    await vi.advanceTimersByTimeAsync(1500);
    expect(query).toHaveBeenCalledExactlyOnceWith(firstId, 2);
    const confirms = [queue.confirm(firstId), queue.confirm(firstId)];
    await flush();
    expect(query).toHaveBeenCalledOnce();
    expect(transcribe).toHaveBeenCalledOnce();
    confirmation.resolve(success(firstId));
    await Promise.all(confirms);
    await flush();
    expect(submit.mock.calls.map(([input]) => input.requestId)).toEqual([firstId, secondId]);
    expect(queue.getSnapshot().tasks.every(({ phase }) => phase === "success")).toBe(true);
    expect(data.size).toBe(0);
    queue.dispose();
  });

  it.each(["write", "read", "mismatch"])("never submits if UUID persistence %s fails", async (failure) => {
    const { queue, storage, submit } = setup();
    await queue.initialize();
    if (failure === "write") storage.setItem.mockImplementation(() => { throw new Error("denied"); });
    else if (failure === "read") storage.getItem.mockImplementation(() => { throw new Error("denied"); });
    else storage.getItem.mockReturnValue(JSON.stringify([thirdId]));
    queue.enqueue(Promise.resolve(new Blob(["Lunch 35 CNY"])), "en-US");
    await flush();
    expect(queue.getSnapshot().tasks).toMatchObject([{ id: firstId, phase: "failed", error: "storage" }]);
    expect(submit).not.toHaveBeenCalled();
    queue.dispose();
  });

  it("keeps polling processing results without submitting them again", async () => {
    vi.useFakeTimers();
    const { queue, submit, query, data } = setup();
    submit.mockResolvedValueOnce({ status: "processing", requestId: firstId });
    query.mockResolvedValueOnce({ status: "processing", requestId: firstId });
    await queue.initialize();
    queue.enqueue(Promise.resolve(new Blob(["Lunch 35 CNY"])), "en-US");
    await flush();
    expect(queue.getSnapshot().tasks[0].phase).toBe("processing");
    expect(() => queue.enqueueText(firstId, "Lunch 35 CNY", "en-US")).toThrow(VoiceAccountingError);
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.getSnapshot().tasks[0].phase).toBe("processing");
    expect(data.get(storageKey)).toBe(JSON.stringify([firstId]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.getSnapshot().tasks[0]).toMatchObject({ phase: "success", text: null });
    expect(submit).toHaveBeenCalledOnce();
    expect(query).toHaveBeenCalledTimes(2);
    expect(data.size).toBe(0);
    queue.dispose();
  });

  it("handles a recording that rejects while queued without querying an unsubmitted UUID", async () => {
    const { queue, submit, query, transcribe, data } = setup();
    const firstResult = deferred<NaturalLanguageActionResult>();
    const failedAudio = deferred<Blob>();
    submit.mockImplementationOnce(() => firstResult.promise);
    await queue.initialize();
    queue.enqueue(Promise.resolve(new Blob(["Lunch 35 CNY"])), "en-US");
    queue.enqueue(failedAudio.promise, "en-US");
    await flush();
    failedAudio.reject(new Error("private recording detail"));
    await flush();
    expect(queue.getSnapshot().tasks[1].phase).toBe("queued");
    expect(data.get(storageKey)).toBe(JSON.stringify([firstId]));
    firstResult.resolve(success(firstId));
    await flush();
    expect(queue.getSnapshot().tasks[1]).toMatchObject({ phase: "failed", error: "unavailable" });
    expect(transcribe).toHaveBeenCalledOnce();
    expect(submit).toHaveBeenCalledOnce();
    expect(query).not.toHaveBeenCalled();
    expect(data.size).toBe(0);
    queue.dispose();
  });

  it.each(["not-json", JSON.stringify({ requestId: firstId }), JSON.stringify(["Lunch 35 CNY"])])(
    "discards malformed stored state instead of querying it", async (stored) => {
      const { queue, data, query } = setup();
      data.set(storageKey, stored);
      await queue.initialize();
      expect(queue.getSnapshot().tasks).toEqual([]);
      expect(query).not.toHaveBeenCalled();
      expect(data.size).toBe(0);
      queue.dispose();
    },
  );

  it("restores only valid UUIDs and clears each finished ID without deleting other pending IDs", async () => {
    vi.useFakeTimers();
    const { queue, data, submit, query, transcribe } = setup();
    data.set(storageKey, JSON.stringify([firstId, "private text", secondId, firstId, { text: "secret" }]));
    query.mockRejectedValueOnce(new Error("offline"));
    await queue.initialize();
    expect(query.mock.calls).toEqual([[firstId, 2], [secondId, 2]]);
    expect(submit).not.toHaveBeenCalled();
    expect(transcribe).not.toHaveBeenCalled();
    expect(queue.getSnapshot().tasks.map(({ id, phase, text }) => ({ id, phase, text }))).toEqual([
      { id: firstId, phase: "unknown", text: null }, { id: secondId, phase: "success", text: null },
    ]);
    expect(data.get(storageKey)).toBe(JSON.stringify([firstId]));
    data.set(storageKey, JSON.stringify([firstId, thirdId]));
    await vi.advanceTimersByTimeAsync(1500);
    expect(query.mock.calls).toEqual([[firstId, 2], [secondId, 2], [firstId, 2]]);
    expect(data.get(storageKey)).toBe(JSON.stringify([thirdId]));
    queue.dispose();
  });

  it("uses a fresh UUID when correcting a failed entry and keeps correction text only in memory", async () => {
    const { queue, data, submit } = setup();
    submit.mockResolvedValueOnce({ status: "error", requestId: firstId, code: "NEEDS_CORRECTION",
      issues: [{ code: "missing_amount", start: 0, end: 5 }] });
    await queue.initialize();
    queue.enqueue(Promise.resolve(new Blob(["Lunch amount forgotten"])), "en-US");
    await flush();
    expect(queue.getSnapshot().tasks[0]).toMatchObject({ id: firstId, phase: "failed", text: "Lunch amount forgotten",
      feedback: { snapshotText: "Lunch amount forgotten", result: { status: "error", code: "NEEDS_CORRECTION" } } });
    expect(data.size).toBe(0);
    expect(queue.enqueueText(firstId, "  Lunch 35 CNY\r\n ", "en-US")).toBe(secondId);
    await flush();
    expect(submit.mock.calls.map(([input]) => [input.requestId, input.text])).toEqual([
      [firstId, "Lunch amount forgotten"], [secondId, "Lunch 35 CNY"],
    ]);
    expect(queue.getSnapshot().tasks).toMatchObject([{ id: secondId, phase: "success", text: null }]);
    queue.dismiss(secondId);
    expect(queue.getSnapshot().tasks).toEqual([]);
    queue.dispose();
  });

  it.each([
    { status: "success", requestId: secondId, resultVersion: 2, count: 1, incomeCount: 0, expenseCount: 1, incomeAmountFen: 0, expenseAmountFen: 3500 },
    { status: "success", requestId: firstId, count: 1, totalAmountFen: 3500 },
  ])("keeps mismatched or incompatible results unknown", async (result) => {
    vi.useFakeTimers();
    const { queue, data, submit } = setup();
    submit.mockResolvedValueOnce(result as NaturalLanguageActionResult);
    await queue.initialize();
    queue.enqueue(Promise.resolve(new Blob(["Lunch 35 CNY"])), "en-US");
    await flush();
    expect(queue.getSnapshot().tasks).toMatchObject([{ phase: "unknown", feedback: null }]);
    expect(data.get(storageKey)).toBe(JSON.stringify([firstId]));
    queue.dispose();
  });

  it("queries a conflicting UUID without associating the original text with its result", async () => {
    const { queue, submit, query } = setup();
    submit.mockResolvedValueOnce({ status: "error", requestId: firstId, code: "CONFLICT" });
    query.mockResolvedValueOnce({ status: "error", requestId: firstId, code: "NEEDS_CORRECTION" });
    await queue.initialize();
    queue.enqueue(Promise.resolve(new Blob(["Lunch 35 CNY"])), "en-US");
    await flush();
    expect(query).toHaveBeenCalledExactlyOnceWith(firstId, 2);
    expect(queue.getSnapshot().tasks).toMatchObject([{ phase: "failed", text: null,
      feedback: { snapshotText: null, result: { code: "NEEDS_CORRECTION" } } }]);
    queue.dispose();
  });

  it("keeps a repeated UUID conflict unknown and continues confirming only that UUID", async () => {
    vi.useFakeTimers();
    const { queue, submit, query, data } = setup();
    submit.mockResolvedValueOnce({ status: "error", requestId: firstId, code: "CONFLICT" });
    query.mockResolvedValueOnce({ status: "error", requestId: firstId, code: "CONFLICT" });
    await queue.initialize();
    queue.enqueue(Promise.resolve(new Blob(["Lunch 35 CNY"])), "en-US");
    await flush();
    expect(queue.getSnapshot().tasks[0]).toMatchObject({ phase: "unknown", text: null, feedback: null });
    expect(data.get(storageKey)).toBe(JSON.stringify([firstId]));
    await vi.advanceTimersByTimeAsync(1000);
    expect(queue.getSnapshot().tasks[0].phase).toBe("success");
    expect(query.mock.calls).toEqual([[firstId, 2], [firstId, 2]]);
    expect(submit).toHaveBeenCalledOnce();
    queue.dispose();
  });

  it.each([
    [new VoiceAccountingError("no_speech"), "no_speech"],
    [Object.assign(new Error("private transcript"), { code: "timeout" }), "timeout"],
    [new Error("private transcript"), "unavailable"],
    [Object.assign(new Error("private transcript"), { code: "private transcript" }), "unavailable"],
  ])("reports only fixed transcription errors", async (error, code) => {
    const { queue, transcribe, submit, query, data } = setup();
    transcribe.mockRejectedValueOnce(error);
    await queue.initialize();
    queue.enqueue(Promise.resolve(new Blob(["audio"])), "en-US");
    await flush();
    expect(queue.getSnapshot().tasks).toMatchObject([{ phase: "failed", error: code, text: null }]);
    expect(submit).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(data.size).toBe(0);
    queue.dispose();
  });

  it("aborts transcription on disposal and ignores late audio and transcription results", async () => {
    const { queue, transcribe, submit, query } = setup();
    const transcription = deferred<string>();
    const audio = deferred<Blob>();
    transcribe.mockImplementationOnce(() => transcription.promise);
    await queue.initialize();
    queue.enqueue(Promise.resolve(new Blob(["audio"])), "en-US");
    queue.enqueue(audio.promise, "en-US");
    await flush();
    const signal = transcribe.mock.calls[0][2];
    queue.dispose();
    expect(signal.aborted).toBe(true);
    transcription.resolve("Lunch 35 CNY");
    audio.resolve(new Blob(["Dinner 40 CNY"]));
    await flush();
    expect(submit).not.toHaveBeenCalled();
    expect(query).not.toHaveBeenCalled();
    expect(transcribe).toHaveBeenCalledOnce();
    expect(queue.getSnapshot().ready).toBe(false);
    await queue.initialize();
    expect(queue.getSnapshot()).toEqual({ ready: true, tasks: [] });
    queue.dispose();
  });

  it("retains submitted UUIDs through disposal and ignores old responses after reinitialization", async () => {
    vi.useFakeTimers();
    const { queue, submit, query, data } = setup();
    const oldSubmission = deferred<NaturalLanguageActionResult>();
    submit.mockImplementationOnce(() => oldSubmission.promise);
    query.mockResolvedValueOnce({ status: "unknown", requestId: firstId });
    await queue.initialize();
    queue.enqueue(Promise.resolve(new Blob(["Lunch 35 CNY"])), "en-US");
    await flush();
    expect(data.get(storageKey)).toBe(JSON.stringify([firstId]));
    queue.dispose();
    await queue.initialize();
    oldSubmission.resolve(success(firstId));
    await flush();
    expect(queue.getSnapshot().tasks).toMatchObject([{ id: firstId, phase: "unknown", text: null }]);
    expect(data.get(storageKey)).toBe(JSON.stringify([firstId]));
    expect(submit).toHaveBeenCalledOnce();
    queue.dispose();
    await vi.advanceTimersByTimeAsync(5000);
    expect(query).toHaveBeenCalledOnce();
  });
});
