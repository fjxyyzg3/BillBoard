import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { transcribeVoiceAudio } from "@/lib/voice/transcribe";
import { wav } from "../fixtures/voice-wav";

const { createLease, disposeLease } = vi.hoisted(() => ({ createLease: vi.fn(), disposeLease: vi.fn() }));
vi.mock("@/lib/voice/audio-store", () => ({ createVoiceAudioLease: createLease }));

const requestSignal = () => new AbortController().signal;
const response = (body: unknown = { result: { text: "午饭35元" } }, code = "20000000", status = 200) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "X-Api-Status-Code": code } });
const accepted = () => new Response(null, { headers: { "X-Api-Status-Code": "20000000" } });
const mockQuery = (query: Response) => vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(accepted()).mockResolvedValueOnce(query);

describe("Doubao voice transcription", () => {
  beforeEach(() => {
    vi.stubEnv("VOLCENGINE_ASR_API_KEY", "test-key-not-a-secret");
    disposeLease.mockReset().mockResolvedValue(undefined);
    createLease.mockReset().mockResolvedValue({ url: "https://audio.example.test/api/voice/audio?token=opaque-capability", dispose: disposeLease });
  });
  afterEach(() => { vi.restoreAllMocks(); vi.unstubAllEnvs(); vi.useRealTimers(); });

  it("submits an expiring audio URL then queries the same task and returns normalized text", async () => {
    const audio = wav();
    const fetchSpy = mockQuery(response({ result: { text: "  午饭35元\r\n工资8000元  " } }));
    await expect(transcribeVoiceAudio(audio, requestSignal())).resolves.toBe("午饭35元\n工资8000元");
    const [url, init] = fetchSpy.mock.calls[0];
    expect(url).toBe("https://openspeech.bytedance.com/api/v3/auc/bigmodel/submit");
    expect(init).toMatchObject({ method: "POST", redirect: "error", cache: "no-store" });
    const headers = new Headers(init?.headers);
    expect(headers.get("X-Api-Key")).toBe("test-key-not-a-secret");
    expect(headers.get("X-Api-Resource-Id")).toBe("volc.seedasr.auc");
    expect(headers.get("X-Api-Sequence")).toBe("-1");
    expect(headers.get("X-Api-Request-Id")).toMatch(/^[0-9a-f-]{36}$/);
    const body = JSON.parse(String(init?.body));
    expect(body).toEqual({ user: { uid: headers.get("X-Api-Request-Id") },
      audio: { url: "https://audio.example.test/api/voice/audio?token=opaque-capability", format: "wav", codec: "raw", rate: 16000, bits: 16, channel: 1 },
      request: { model_name: "bigmodel" } });
    expect(createLease).toHaveBeenCalledWith(audio);
    const [queryUrl, query] = fetchSpy.mock.calls[1];
    expect(queryUrl).toBe("https://openspeech.bytedance.com/api/v3/auc/bigmodel/query");
    expect(query?.body).toBe("{}");
    expect(new Headers(query?.headers).get("X-Api-Request-Id")).toBe(headers.get("X-Api-Request-Id"));
    expect(new Headers(query?.headers).get("X-Api-Resource-Id")).toBe("volc.seedasr.auc");
    expect(disposeLease).toHaveBeenCalledOnce();
  });

  it.each([
    ["20000003", "no_speech"], ["45000002", "no_speech"], ["45000151", "invalid_audio"],
    ["45000131", "rate_limited"], ["45000132", "audio_too_large"], ["55000000", "unavailable"], ["", "unavailable"],
  ])("maps business code %s without forwarding provider details", async (code, error) => {
    mockQuery(response({ result: { text: "must not be returned" }, message: "provider secret details" }, code));
    await expect(transcribeVoiceAudio(wav(), requestSignal())).rejects.toMatchObject({ code: error, message: error });
    expect(disposeLease).toHaveBeenCalledOnce();
  });

  it.each([
    ["45000131", "rate_limited"], ["45000132", "audio_too_large"], ["45000151", "invalid_audio"],
  ])("keeps business error %s when the provider also returns HTTP 400", async (code, error) => {
    mockQuery(response({}, code, 400));
    await expect(transcribeVoiceAudio(wav(), requestSignal())).rejects.toMatchObject({ code: error });
    expect(disposeLease).toHaveBeenCalledOnce();
  });

  it.each([null, {}, { result: null }, { result: { text: 123 } }, "{truncated"])("rejects malformed success responses %j", async (body) => {
    mockQuery(response(body));
    await expect(transcribeVoiceAudio(wav(), requestSignal())).rejects.toMatchObject({ code: "unavailable" });
  });

  it.each([[" \r\n ", "no_speech"], ["a".repeat(2001), "text_too_long"]])("rejects empty or excessive text", async (text, code) => {
    mockQuery(response({ result: { text } }));
    await expect(transcribeVoiceAudio(wav(), requestSignal())).rejects.toMatchObject({ code });
  });

  it.each([[503, "unavailable"], [429, "rate_limited"]] as const)("maps HTTP %i even with a success business code", async (status, code) => {
    mockQuery(response(undefined, "20000000", status));
    await expect(transcribeVoiceAudio(wav(), requestSignal())).rejects.toMatchObject({ code });
  });

  it("rejects oversized streaming responses and cancels their reader", async () => {
    const cancel = vi.fn();
    mockQuery(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel,
    }), { headers: { "X-Api-Status-Code": "20000000" } }));
    await expect(transcribeVoiceAudio(wav(), requestSignal())).rejects.toMatchObject({ code: "unavailable" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(disposeLease).toHaveBeenCalledOnce();
  });

  it("never starts a provider call without configured credentials or after cancellation", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    vi.stubEnv("VOLCENGINE_ASR_API_KEY", "");
    await expect(transcribeVoiceAudio(wav(), requestSignal())).rejects.toMatchObject({ code: "unavailable" });
    vi.stubEnv("VOLCENGINE_ASR_API_KEY", "test-key-not-a-secret");
    const controller = new AbortController();
    controller.abort();
    await expect(transcribeVoiceAudio(wav(), controller.signal)).rejects.toMatchObject({ code: "cancelled" });
    expect(fetchSpy).not.toHaveBeenCalled();
    expect(createLease).not.toHaveBeenCalled();
  });

  it("aborts an outstanding provider call after 30 seconds", async () => {
    vi.useFakeTimers();
    vi.spyOn(globalThis, "fetch").mockImplementation((_url, init) => new Promise((_resolve, reject) => {
      init?.signal?.addEventListener("abort", () => reject(new DOMException("Aborted", "AbortError")), { once: true });
    }));
    const result = transcribeVoiceAudio(wav(), requestSignal()).catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await result).toMatchObject({ code: "timeout" });
    expect(disposeLease).toHaveBeenCalledOnce();
  });

  it("cancels a stalled response body when the browser disconnects", async () => {
    const controller = new AbortController();
    const cancel = vi.fn();
    const fetchSpy = mockQuery(new Response(new ReadableStream({ cancel }), { headers: { "X-Api-Status-Code": "20000000" } }));
    const result = transcribeVoiceAudio(wav(), controller.signal).catch((error) => error);
    await vi.waitFor(() => expect(fetchSpy).toHaveBeenCalledTimes(2));
    controller.abort();
    expect(await result).toMatchObject({ code: "cancelled" });
    expect(cancel).toHaveBeenCalledOnce();
    expect(disposeLease).toHaveBeenCalledOnce();
  });

  it("polls queued and processing tasks once per second without resubmitting audio", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch")
      .mockResolvedValueOnce(accepted())
      .mockResolvedValueOnce(response({}, "20000002"))
      .mockResolvedValueOnce(response({}, "20000001"))
      .mockResolvedValueOnce(response());
    const pending = transcribeVoiceAudio(wav(), requestSignal()).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(999);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    await vi.advanceTimersByTimeAsync(1001);
    expect(await pending).toBe("午饭35元");
    expect(fetchSpy).toHaveBeenCalledTimes(4);
    expect(fetchSpy.mock.calls.filter(([url]) => String(url).endsWith("/submit"))).toHaveLength(1);
    expect(disposeLease).toHaveBeenCalledOnce();
  });

  it("does not query a rejected submission and cleans its audio lease", async () => {
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(response({}, "45000030", 403));
    await expect(transcribeVoiceAudio(wav(), requestSignal())).rejects.toMatchObject({ code: "unavailable" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(disposeLease).toHaveBeenCalledOnce();
  });

  it("bounds the submission response even though its success body is unused", async () => {
    const cancel = vi.fn();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(new ReadableStream({
      start(controller) { controller.enqueue(new Uint8Array(256 * 1024 + 1)); }, cancel,
    }), { headers: { "X-Api-Status-Code": "20000000" } }));
    await expect(transcribeVoiceAudio(wav(), requestSignal())).rejects.toMatchObject({ code: "unavailable" });
    expect(fetchSpy).toHaveBeenCalledOnce();
    expect(cancel).toHaveBeenCalledOnce();
    expect(disposeLease).toHaveBeenCalledOnce();
  });

  it("does not expose filesystem errors or submit audio when creating its lease fails", async () => {
    createLease.mockRejectedValue(new Error("private filesystem details"));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    await expect(transcribeVoiceAudio(wav(), requestSignal())).rejects.toMatchObject({ code: "unavailable", message: "unavailable" });
    expect(fetchSpy).not.toHaveBeenCalled();
  });

  it("does not return successful text when lease cleanup fails", async () => {
    mockQuery(response());
    disposeLease.mockRejectedValue(new Error("private filesystem details"));
    await expect(transcribeVoiceAudio(wav(), requestSignal())).rejects.toMatchObject({ code: "unavailable", message: "unavailable" });
    expect(disposeLease).toHaveBeenCalledOnce();
  });

  it("cancels the polling delay immediately without another query", async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const fetchSpy = mockQuery(response({}, "20000001"));
    const pending = transcribeVoiceAudio(wav(), controller.signal).catch((error) => error);
    await vi.advanceTimersByTimeAsync(0);
    controller.abort();
    expect(await pending).toMatchObject({ code: "cancelled" });
    await vi.advanceTimersByTimeAsync(1000);
    expect(fetchSpy).toHaveBeenCalledTimes(2);
    expect(disposeLease).toHaveBeenCalledOnce();
  });

  it("uses one 30-second budget for submission and every poll", async () => {
    vi.useFakeTimers();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValueOnce(accepted())
      .mockImplementation(async () => response({}, "20000002"));
    const pending = transcribeVoiceAudio(wav(), requestSignal()).catch((error) => error);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(await pending).toMatchObject({ code: "timeout" });
    expect(fetchSpy).toHaveBeenCalledTimes(31);
    expect(disposeLease).toHaveBeenCalledOnce();
  });

  it.each(["timeout", "cancelled"] as const)("retains resource occupancy after %s until a pending audio write and cleanup finish", async (code) => {
    vi.useFakeTimers();
    const controller = new AbortController();
    let finish!: (value: { url: string; dispose: typeof disposeLease }) => void;
    let finishDisposal!: () => void;
    createLease.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    disposeLease.mockReturnValue(new Promise<void>((resolve) => { finishDisposal = resolve; }));
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    let settled = false;
    const pending = transcribeVoiceAudio(wav(), controller.signal).catch((error) => error)
      .then((value) => { settled = true; return value; });
    if (code === "timeout") await vi.advanceTimersByTimeAsync(30_000);
    else { controller.abort(); await vi.advanceTimersByTimeAsync(0); }
    expect(settled).toBe(false);
    finish({ url: "https://audio.example.test/late", dispose: disposeLease });
    await vi.advanceTimersByTimeAsync(0);
    expect(disposeLease).toHaveBeenCalledOnce();
    expect(settled).toBe(false);
    expect(fetchSpy).not.toHaveBeenCalled();
    finishDisposal();
    expect(await pending).toMatchObject({ code });
    expect(fetchSpy).not.toHaveBeenCalled();
  });
});
