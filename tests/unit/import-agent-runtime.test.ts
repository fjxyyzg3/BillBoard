import { request as httpRequest, type IncomingHttpHeaders, type Server } from "node:http";
import type { AddressInfo } from "node:net";
import { afterEach, describe, expect, it, vi } from "vitest";
import { createImportAgentServer } from "../../agent/server";
import { createWheelMakerClassifier, createWheelMakerNaturalLanguageParser } from "../../agent/wheelmaker";
import {
  apiKey, baseUrl, closeServer, completion, createWheelMakerFixture, deferred, importRequest, importResponse,
  naturalRequest, naturalResponse, sendJson,
} from "../fixtures/agent/wheelmaker-fixture";

const servers: Server[] = [];
const fixtures: Awaited<ReturnType<typeof createWheelMakerFixture>>[] = [];
const releases: (() => void)[] = [];
const token = "a".repeat(64);

async function fixture(reply: Parameters<typeof createWheelMakerFixture>[0]) {
  const state = await createWheelMakerFixture(reply);
  fixtures.push(state);
  const options = { baseUrl, apiKey, fetchImpl: state.fetchImpl, timeoutMs: 5000 };
  return { ...state, classify: createWheelMakerClassifier(options), parseExpenses: createWheelMakerNaturalLanguageParser(options) };
}

async function serve(options: Omit<Parameters<typeof createImportAgentServer>[0], "token">) {
  const server = createImportAgentServer({ token, ...options });
  servers.push(server);
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  return (server.address() as AddressInfo).port;
}

function post(port: number, options: { endpoint?: string; body?: unknown; auth?: string; signal?: AbortSignal; chunked?: boolean; contentType?: string } = {}) {
  return new Promise<{ status: number | undefined; headers: IncomingHttpHeaders; body: unknown }>((resolve, reject) => {
    const body = options.body ?? importRequest;
    const raw = typeof body === "string" ? body : JSON.stringify(body);
    const request = httpRequest({ hostname: "127.0.0.1", port, path: options.endpoint ?? "/suggest", method: "POST", signal: options.signal,
      headers: { Authorization: `Bearer ${options.auth ?? token}`, "Content-Type": options.contentType ?? "application/json",
        ...(options.chunked ? { "Transfer-Encoding": "chunked" } : { "Content-Length": Buffer.byteLength(raw) }) } }, (response) => {
      const chunks: Buffer[] = [];
      response.on("data", (chunk: Buffer) => chunks.push(chunk));
      response.on("end", () => resolve({ status: response.statusCode, headers: response.headers, body: JSON.parse(Buffer.concat(chunks).toString("utf8")) }));
      response.on("error", reject);
    });
    request.on("error", reject);
    if (options.chunked) request.write(raw.slice(0, 128 * 1024));
    request.end(options.chunked ? raw.slice(128 * 1024) : raw);
  });
}

afterEach(async () => {
  vi.useRealTimers();
  vi.restoreAllMocks();
  for (const release of releases.splice(0)) release();
  await Promise.all(servers.splice(0).map(closeServer));
  await Promise.all(fixtures.splice(0).map((state) => state.close()));
});

describe("import agent HTTP service", () => {
  it("requires a private internal token", () => {
    const classify = async () => importResponse;
    expect(() => createImportAgentServer({ token: "", classify })).toThrow("IMPORT_AGENT_TOKEN");
    expect(() => createImportAgentServer({ token: "replace-me-with-a-private-random-token", classify })).toThrow("IMPORT_AGENT_TOKEN");
  });

  it("reports liveness without claiming model authentication or invoking the provider", async () => {
    const state = await fixture((_request, response) => sendJson(response, { error: "PRIVATE-MODEL-AUTH" }, 401));
    const port = await serve(state);
    const response = await fetch(`http://127.0.0.1:${port}/health`);
    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ status: "ok" });
    expect(state.requests).toHaveLength(0);
    expect(await post(port)).toMatchObject({ status: 503, body: { error: "authentication_required" } });
  });

  it("authenticates requests before forwarding the two task types to Responses", async () => {
    const state = await fixture((request, response) => sendJson(response,
      completion(String(request.body.input).includes(naturalRequest.schemaVersion) ? naturalResponse : importResponse)));
    const port = await serve(state);
    expect(await post(port, { auth: "wrong-token" })).toMatchObject({ status: 401, body: { error: "unauthorized" } });
    expect(state.requests).toHaveLength(0);
    const accepted = await post(port);
    expect(accepted).toMatchObject({ status: 200, body: importResponse });
    expect(accepted.headers["cache-control"]).toBe("no-store");
    expect(await post(port, { endpoint: "/parse-expenses", body: naturalRequest })).toMatchObject({ status: 200, body: naturalResponse });
    expect(state.requests).toHaveLength(2);
    expect(state.requests.every(({ headers }) => headers.authorization === `Bearer ${apiKey}`)).toBe(true);
  });

  it("rejects invalid, wrong-content-type, declared and streamed excessive bodies before model calls", async () => {
    const state = await fixture((_request, response) => sendJson(response, completion(importResponse)));
    const port = await serve(state);
    expect(await post(port, { body: { ...importRequest, command: "arbitrary command" } })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(await post(port, { body: "not JSON" })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    expect(await post(port, { contentType: "text/plain" })).toMatchObject({ status: 400, body: { error: "invalid_request" } });
    for (const chunked of [false, true]) {
      expect(await post(port, { body: "x".repeat(256 * 1024 + 1), chunked })).toMatchObject({ status: 413, body: { error: "payload_too_large" } });
    }
    expect(state.requests).toHaveLength(0);
    expect(await post(port, { contentType: "application/json; charset=utf-8" })).toMatchObject({ status: 200, body: importResponse });
  });

  it("returns 404 for an unconfigured parser or unsupported endpoint", async () => {
    const port = await serve({ classify: async () => importResponse });
    expect(await post(port, { endpoint: "/parse-expenses", body: naturalRequest })).toMatchObject({ status: 404, body: { error: "not_found" } });
    expect(await post(port, { endpoint: "/execute" })).toMatchObject({ status: 404, body: { error: "not_found" } });
  });

  it.each([["/suggest", "/parse-expenses"], ["/parse-expenses", "/suggest"]])("shares one busy slot from %s to %s and releases it after completion", async (firstEndpoint, secondEndpoint) => {
    const entered = deferred();
    const finish = deferred();
    releases.push(() => finish.resolve());
    let first = true;
    const state = await fixture(async (request, response) => {
      if (first) { first = false; entered.resolve(); await finish.promise; }
      sendJson(response, completion(String(request.body.input).includes(naturalRequest.schemaVersion) ? naturalResponse : importResponse));
    });
    const port = await serve(state);
    const input = (endpoint: string) => endpoint === "/suggest" ? importRequest : naturalRequest;
    const pending = post(port, { endpoint: firstEndpoint, body: input(firstEndpoint) });
    await entered.promise;
    const busy = await post(port, { endpoint: secondEndpoint, body: input(secondEndpoint) });
    expect(busy).toMatchObject({ status: 429, body: { error: "busy" } });
    expect(busy.headers["retry-after"]).toBe("2");
    expect(state.requests).toHaveLength(1);
    finish.resolve();
    expect((await pending).status).toBe(200);
    expect((await post(port, { endpoint: secondEndpoint, body: input(secondEndpoint) })).status).toBe(200);
    expect(state.requests).toHaveLength(2);
  });

  it.each([[401, 503, "authentication_required"], [503, 503, "unavailable"], [200, 502, "invalid_response"]] as const)(
    "returns a fixed service error for upstream HTTP %s without exposing raw data", async (upstream, status, error) => {
      const state = await fixture((_request, response) => sendJson(response, { error: { message: "PRIVATE-MODEL-DETAIL" } }, upstream));
      const logs = vi.spyOn(console, "error").mockImplementation(() => {});
      const port = await serve(state);
      expect(await post(port)).toMatchObject({ status, body: { error } });
      expect(await post(port)).toMatchObject({ status, body: { error } });
      expect(state.requests).toHaveLength(2);
      expect(JSON.stringify(logs.mock.calls)).not.toContain("PRIVATE-MODEL-DETAIL");
    },
  );

  it("returns a fixed timeout after the local provider operation stops", async () => {
    const state = await fixture((_request, response) => { response.writeHead(200, { "Content-Type": "application/json" }); response.write("{"); });
    const options = { baseUrl, apiKey, fetchImpl: state.fetchImpl, timeoutMs: 100 };
    const port = await serve({ classify: createWheelMakerClassifier(options) });
    expect(await post(port)).toMatchObject({ status: 504, body: { error: "timeout" } });
    expect(await post(port)).toMatchObject({ status: 504, body: { error: "timeout" } });
    expect(state.requests).toHaveLength(2);
  });

  it("waits for local work to settle after its 45-second deadline before responding or releasing capacity", async () => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
    const entered = deferred();
    const finish = deferred();
    releases.push(() => finish.resolve());
    let activeSignal: AbortSignal | undefined;
    const port = await serve({ classify: async (_input, signal) => {
      activeSignal = signal; entered.resolve(); await finish.promise; return importResponse;
    } });
    let settled = false;
    const pending = post(port);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await entered.promise;
    await vi.advanceTimersByTimeAsync(45_000);
    expect(activeSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(await post(port)).toMatchObject({ status: 429, body: { error: "busy" } });
    finish.resolve();
    expect(await pending).toMatchObject({ status: 504, body: { error: "timeout" } });
    expect(await post(port)).toMatchObject({ status: 200, body: importResponse });
  });

  it("propagates client disconnect and keeps the slot until local cancellation cleanup finishes", async () => {
    const entered = deferred();
    const finish = deferred();
    releases.push(() => finish.resolve());
    let activeSignal: AbortSignal | undefined;
    const port = await serve({ classify: async (_input, signal) => {
      activeSignal = signal; entered.resolve(); await finish.promise; return importResponse;
    } });
    const controller = new AbortController();
    const pending = post(port, { signal: controller.signal });
    const rejection = expect(pending).rejects.toThrow();
    await entered.promise;
    controller.abort();
    await rejection;
    await expect.poll(() => activeSignal?.aborted).toBe(true);
    expect(await post(port)).toMatchObject({ status: 429, body: { error: "busy" } });
    finish.resolve();
    await expect.poll(async () => (await post(port)).status).toBe(200);
  });

  it("propagates service shutdown and waits for cleanup before its fixed cancellation response", async () => {
    const shutdown = new AbortController();
    const entered = deferred();
    const finish = deferred();
    releases.push(() => finish.resolve());
    let activeSignal: AbortSignal | undefined;
    const port = await serve({ shutdownSignal: shutdown.signal, classify: async (_input, signal) => {
      activeSignal = signal; entered.resolve(); await finish.promise; return importResponse;
    } });
    let settled = false;
    const pending = post(port);
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await entered.promise;
    shutdown.abort();
    expect(activeSignal?.aborted).toBe(true);
    expect(settled).toBe(false);
    expect(await post(port)).toMatchObject({ status: 429, body: { error: "busy" } });
    finish.resolve();
    expect(await pending).toMatchObject({ status: 499, body: { error: "cancelled" } });
  });
});
