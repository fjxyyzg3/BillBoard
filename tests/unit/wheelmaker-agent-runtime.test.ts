import { afterEach, describe, expect, it, vi } from "vitest";
import { AgentRuntimeError } from "../../agent/runtime";
import { createWheelMakerClassifier, createWheelMakerNaturalLanguageParser } from "../../agent/wheelmaker";
import {
  apiKey, baseUrl, completion, createWheelMakerFixture, deferred, importRequest, importResponse,
  naturalRequest, naturalResponse, sendJson,
} from "../fixtures/agent/wheelmaker-fixture";

const fixtures: Awaited<ReturnType<typeof createWheelMakerFixture>>[] = [];
async function fixture(reply: Parameters<typeof createWheelMakerFixture>[0]) {
  const state = await createWheelMakerFixture(reply);
  fixtures.push(state);
  return state;
}
function options(state: Awaited<ReturnType<typeof fixture>>) {
  return { baseUrl, apiKey, fetchImpl: state.fetchImpl, timeoutMs: 5000 };
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  vi.unstubAllEnvs();
  await Promise.all(fixtures.splice(0).map((state) => state.close()));
});

describe("WheelMaker Responses runtime", () => {
  it("uses authenticated stateless JSON Responses for each task without inheriting secrets or session headers", async () => {
    vi.stubEnv("DATABASE_URL", "PRIVATE-DATABASE");
    vi.stubEnv("AUTH_SECRET", "PRIVATE-AUTH");
    vi.stubEnv("IMPORT_AGENT_TOKEN", "PRIVATE-INTERNAL-TOKEN");
    const state = await fixture((request, response) => {
      response.setHeader("X-WheelMaker-Session-Id", "must-not-be-reused");
      sendJson(response, completion(String(request.body.input).includes(naturalRequest.schemaVersion) ? naturalResponse : importResponse));
    });
    const classify = createWheelMakerClassifier(options(state));
    await expect(classify(importRequest)).resolves.toEqual(importResponse);
    await expect(classify(importRequest)).resolves.toEqual(importResponse);
    await expect(createWheelMakerNaturalLanguageParser(options(state))(naturalRequest)).resolves.toEqual(naturalResponse);
    expect(state.requests).toHaveLength(3);
    expect(state.targets.every((url) => url.href === baseUrl + "/responses")).toBe(true);
    for (const request of state.requests) {
      expect(request).toMatchObject({ method: "POST", path: "/v1/responses", headers: {
        authorization: `Bearer ${apiKey}`, "content-type": "application/json", accept: "application/json",
      } });
      expect(request.body).toMatchObject({ model: "gpt-6-luna", reasoning: { effort: "high" }, stream: false,
        ephemeral: true, store: false, tool_choice: "none", text: { format: { type: "json_object" } } });
      expect(request.body).not.toHaveProperty("previous_response_id");
      expect(request.body).not.toHaveProperty("tools");
      expect(request.headers).not.toHaveProperty("x-wheelmaker-session-id");
      expect(Object.keys(request.headers).filter((name) => /session|cookie/.test(name))).toEqual([]);
      expect(JSON.stringify(request.body)).not.toMatch(/synthetic-wheelmaker-key|PRIVATE-|must-not-be-reused/);
    }
    expect(state.requests[0].body.input).toContain(JSON.stringify(importRequest));
    expect(state.requests[2].body.input).toContain(JSON.stringify(naturalRequest));
  });

  it("uses the configured model and reasoning effort for the validated result", async () => {
    const state = await fixture((_request, response) => sendJson(response, completion(importResponse, "custom-model")));
    await expect(createWheelMakerClassifier({ ...options(state), model: "custom-model", reasoningEffort: "low" })(importRequest)).resolves.toEqual(importResponse);
    expect(state.requests[0].body).toMatchObject({ model: "custom-model", reasoning: { effort: "low" } });
  });

  it.each([401, 403, 400, 422, 429, 500, 503])("maps HTTP %s to a fixed error without retry or raw upstream logs", async (status) => {
    const state = await fixture((_request, response) => sendJson(response, { error: { message: "PRIVATE-UPSTREAM-DETAIL" } }, status));
    const errors = vi.spyOn(console, "error").mockImplementation(() => {});
    const warnings = vi.spyOn(console, "warn").mockImplementation(() => {});
    const code = status === 401 || status === 403 ? "authentication_required" : "unavailable";
    await expect(createWheelMakerClassifier(options(state))(importRequest)).rejects.toMatchObject({ code, message: code });
    expect(state.requests).toHaveLength(1);
    expect(JSON.stringify([...errors.mock.calls, ...warnings.mock.calls])).not.toContain("PRIVATE-UPSTREAM-DETAIL");
  });

  it("refuses redirects without forwarding credentials to another endpoint", async () => {
    const state = await fixture((_request, response) => {
      response.writeHead(307, { Location: "/redirect-target" });
      response.end();
    });
    await expect(createWheelMakerClassifier(options(state))(importRequest)).rejects.toMatchObject({ code: "unavailable" });
    expect(state.requests.map(({ path }) => path)).toEqual(["/v1/responses"]);
  });

  const valid = completion(importResponse);
  const invalidOutputs: Array<[string, unknown]> = [
    ["null", null], ["array", []], ["wrong object", { ...valid, object: "chat.completion" }],
    ["unfinished", { ...valid, status: "incomplete" }], ["wrong model", { ...valid, model: "other-model" }],
    ["error", { ...valid, error: { message: "PRIVATE-UPSTREAM-DETAIL" } }],
    ["incomplete details", { ...valid, incomplete_details: { reason: "max_output_tokens" } }],
    ["missing output", { ...valid, output: undefined }], ["empty output", { ...valid, output: [] }],
    ["SDK text shortcut", { object: "response", status: "completed", model: "gpt-6-luna", output_text: JSON.stringify(importResponse) }],
    ...["reasoning", "function_call", "web_search_call", "image_generation_call"].map((type): [string, unknown] => [type, { ...valid, output: [...valid.output, { type }] }]),
    ["wrong role", { ...valid, output: [{ ...valid.output[0], role: "user" }] }],
    ["unfinished message", { ...valid, output: [{ ...valid.output[0], status: "in_progress" }] }],
    ["empty content", { ...valid, output: [{ ...valid.output[0], content: [] }] }],
    ["refusal", { ...valid, output: [{ ...valid.output[0], content: [{ type: "refusal", refusal: "PRIVATE-UPSTREAM-DETAIL" }] }] }],
    ["image content", { ...valid, output: [{ ...valid.output[0], content: [{ type: "output_image", image_url: "data:private" }] }] }],
    ["invalid text JSON", { ...valid, output: [{ ...valid.output[0], content: [{ type: "output_text", text: "PRIVATE-UPSTREAM-DETAIL" }] }] }],
  ];
  it.each(invalidOutputs)("rejects %s instead of treating non-final or non-text output as a result", async (_name, body) => {
    const state = await fixture((_request, response) => sendJson(response, body));
    await expect(createWheelMakerClassifier(options(state))(importRequest)).rejects.toMatchObject({ code: "invalid_response", message: "invalid_response" });
    expect(state.requests).toHaveLength(1);
  });

  it.each(["malformed JSON", "oversized text", "oversized declared body", "oversized streamed body"])("bounds %s from the HTTP response", async (scenario) => {
    const state = await fixture((_request, response) => {
      response.setHeader("Content-Type", "application/json");
      if (scenario === "malformed JSON") { response.end('{"PRIVATE-UPSTREAM-DETAIL":bad'); return; }
      if (scenario === "oversized text") {
        sendJson(response, { ...valid, output: [{ ...valid.output[0], content: [{ type: "output_text", text: " ".repeat(64 * 1024) + JSON.stringify(importResponse) }] }] });
        return;
      }
      const body = JSON.stringify({ ...valid, padding: "x".repeat(256 * 1024) });
      if (scenario === "oversized declared body") response.setHeader("Content-Length", Buffer.byteLength(body));
      else response.write(body.slice(0, 128 * 1024));
      response.end(scenario === "oversized declared body" ? body : body.slice(128 * 1024));
    });
    await expect(createWheelMakerClassifier(options(state))(importRequest)).rejects.toMatchObject({ code: "invalid_response" });
  });

  it("validates candidates before HTTP and rejects pre-cancelled tasks without a request", async () => {
    const state = await fixture((_request, response) => sendJson(response, valid));
    const classify = createWheelMakerClassifier(options(state));
    await expect(classify({ ...importRequest, categories: [] })).rejects.toThrow();
    await expect(classify(importRequest, AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" });
    await expect(createWheelMakerNaturalLanguageParser(options(state))(naturalRequest, AbortSignal.abort())).rejects.toMatchObject({ code: "cancelled" });
    expect(state.requests).toHaveLength(0);
  });

  it.each([
    ["unknown group", [{ groupId: "g9", action: "map", categoryId: "c0" }]],
    ["unknown category", [{ groupId: "g0", action: "map", categoryId: "c9" }]],
    ["category type mismatch", [{ groupId: "g0", action: "map", categoryId: "c1" }]],
    ["duplicate group", [{ groupId: "g0", action: "ignore" }, { groupId: "g0", action: "uncertain" }]],
    ["extra explanation", [{ groupId: "g0", action: "ignore", explanation: "PRIVATE-MODEL-DETAIL" }]],
  ])("rejects classification output with %s instead of returning unvalidated suggestions", async (_name, suggestions) => {
    const state = await fixture((_request, response) => sendJson(response, completion({ ...importResponse, suggestions })));
    const input = { ...importRequest, categories: [...importRequest.categories,
      { id: "c1", name: "Salary", displayName: "工资", type: "INCOME" as const }] };
    await expect(createWheelMakerClassifier(options(state))(input)).rejects.toMatchObject({ code: "invalid_response", message: "invalid_response" });
    expect(state.requests).toHaveLength(1);
  });

  it.each(["before headers", "while reading the body"])("propagates cancellation %s to the HTTP transport", async (phase) => {
    const entered = deferred();
    const closed = deferred();
    const state = await fixture((_request, response) => {
      response.once("close", () => closed.resolve());
      if (phase === "while reading the body") { response.writeHead(200, { "Content-Type": "application/json" }); response.write('{"object":'); }
      entered.resolve();
    });
    const controller = new AbortController();
    const pending = createWheelMakerClassifier(options(state))(importRequest, controller.signal);
    const rejection = expect(pending).rejects.toMatchObject({ code: "cancelled", message: "cancelled" });
    await entered.promise;
    controller.abort();
    await rejection;
    await closed.promise;
    expect(state.requests).toHaveLength(1);
  });

  it("aborts a stalled response at its bounded deadline", async () => {
    const closed = deferred();
    const state = await fixture((_request, response) => { response.once("close", () => closed.resolve()); });
    await expect(createWheelMakerClassifier({ ...options(state), timeoutMs: 100 })(importRequest)).rejects.toMatchObject({ code: "timeout", message: "timeout" });
    await closed.promise;
    expect(state.requests).toHaveLength(1);
  });

  it.each(["cancelled", "timeout"])("waits for late fetch settlement and rejects its result after %s", async (code) => {
    const state = await fixture((_request, response) => sendJson(response, valid));
    const arrived = deferred();
    const finish = deferred();
    let upstreamSignal: AbortSignal | null | undefined;
    const fetchImpl: typeof fetch = async (input, init) => {
      upstreamSignal = init?.signal;
      const response = await state.fetchImpl(input, init);
      arrived.resolve();
      await finish.promise;
      return response;
    };
    const controller = new AbortController();
    let settled = false;
    const pending = createWheelMakerClassifier({ ...options(state), timeoutMs: code === "timeout" ? 100 : 5000, fetchImpl })(importRequest, controller.signal);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejection = expect(pending).rejects.toMatchObject({ code });
    try {
      await arrived.promise;
      if (code === "cancelled") controller.abort();
      await expect.poll(() => upstreamSignal?.aborted).toBe(true);
      expect(settled).toBe(false);
    } finally { finish.resolve(); }
    await rejection;
    expect(state.requests).toHaveLength(1);
  });

  it("waits for response-body cancellation cleanup before settling", async () => {
    const state = await fixture((_request, response) => sendJson(response, valid));
    const reading = deferred();
    const cancelling = deferred();
    const finish = deferred();
    const fetchImpl: typeof fetch = async (input, init) => {
      const response = await state.fetchImpl(input, init);
      const bytes = new Uint8Array(await response.arrayBuffer());
      return new Response(new ReadableStream<Uint8Array>({
        start(controller) { controller.enqueue(bytes); },
        pull() { reading.resolve(); },
        async cancel() { cancelling.resolve(); await finish.promise; },
      }));
    };
    const controller = new AbortController();
    let settled = false;
    const pending = createWheelMakerClassifier({ ...options(state), fetchImpl })(importRequest, controller.signal);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    const rejection = expect(pending).rejects.toMatchObject({ code: "cancelled" });
    try {
      await reading.promise;
      controller.abort();
      await cancelling.promise;
      expect(settled).toBe(false);
    } finally { finish.resolve(); }
    await rejection;
  });

  it("rejects invalid private runtime settings before HTTP", () => {
    const validOptions = { baseUrl, apiKey };
    for (const invalid of ["", "not a URL", "http://127.0.0.1:3100", "https://user:pass@hub.example.com/v1", "https://hub.example.com/v1?secret=value", "https://hub.example.com/v1#fragment"]) {
      expect(() => createWheelMakerClassifier({ ...validOptions, baseUrl: invalid })).toThrow("WHEELMAKER_BASE_URL");
    }
    for (const invalid of ["", " ", "bad\nkey"]) expect(() => createWheelMakerClassifier({ ...validOptions, apiKey: invalid })).toThrow("WHEELMAKER_API_KEY");
    expect(() => createWheelMakerClassifier({ ...validOptions, model: "bad model" })).toThrow("model");
    expect(() => createWheelMakerClassifier({ ...validOptions, reasoningEffort: "not-supported" })).toThrow("reasoning effort");
    for (const timeoutMs of [0, -1, Infinity, NaN]) expect(() => createWheelMakerClassifier({ ...validOptions, timeoutMs })).toThrow("timeout");
    expect(new AgentRuntimeError("unavailable").message).toBe("unavailable");
  });
});
