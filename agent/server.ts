import { createHash, timingSafeEqual } from "node:crypto";
import { createServer, type IncomingMessage, type ServerResponse } from "node:http";
import { MAX_AGENT_BODY_BYTES, validateAgentRequest } from "../src/lib/imports/agent-protocol";
import { validateNaturalLanguageRequest } from "../src/lib/transactions/natural-language-protocol";
import { BILL_ANALYSIS_BATCH_TIMEOUT_MS, BILL_ANALYSIS_SUMMARY_TIMEOUT_MS,
  validateBillAnalysisRequest, validateBillAnalysisResponse } from "../src/lib/reports/bill-analysis-protocol";
import { BILL_RECONCILIATION_BATCH_TIMEOUT_MS, validateBillReconciliationRequest, validateBillReconciliationResponse } from "../src/lib/reports/bill-reconciliation-protocol";
import { AgentRuntimeError, type BillAnalyzer, type BillReconciler, type ImportAgentClassifier, type NaturalLanguageParser } from "./runtime";

interface ImportAgentServerOptions {
  token: string;
  classify: ImportAgentClassifier;
  parseExpenses?: NaturalLanguageParser;
  analyzeBill?: BillAnalyzer;
  reconcileBill?: BillReconciler;
  shutdownSignal?: AbortSignal;
}

class RequestBodyError extends Error {
  constructor(readonly status: number, readonly code: string) { super(code); }
}

function sendJson(response: ServerResponse, status: number, value: unknown) {
  if (response.destroyed || response.writableEnded) return;
  response.writeHead(status, { "Content-Type": "application/json; charset=utf-8", "Cache-Control": "no-store" });
  response.end(JSON.stringify(value));
}

function readBody(request: IncomingMessage, signal: AbortSignal): Promise<unknown> {
  const contentLength = Number(request.headers["content-length"] ?? 0);
  if (!Number.isSafeInteger(contentLength) || contentLength < 0) return Promise.reject(new RequestBodyError(400, "invalid_request"));
  if (contentLength > MAX_AGENT_BODY_BYTES) return Promise.reject(new RequestBodyError(413, "payload_too_large"));
  return new Promise((resolve, reject) => {
    let length = 0;
    const chunks: Buffer[] = [];
    const cleanup = () => {
      request.off("data", onData);
      request.off("end", onEnd);
      request.off("error", onError);
      signal.removeEventListener("abort", onAbort);
    };
    const fail = (error: Error) => { cleanup(); request.resume(); reject(error); };
    const onData = (chunk: Buffer) => {
      length += chunk.length;
      if (length > MAX_AGENT_BODY_BYTES) { fail(new RequestBodyError(413, "payload_too_large")); return; }
      chunks.push(chunk);
    };
    const onEnd = () => {
      cleanup();
      try { resolve(JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { reject(new RequestBodyError(400, "invalid_request")); }
    };
    const onError = () => fail(new RequestBodyError(400, "invalid_request"));
    const onAbort = () => fail(new AgentRuntimeError("cancelled"));
    request.on("data", onData);
    request.once("end", onEnd);
    request.once("error", onError);
    signal.addEventListener("abort", onAbort, { once: true });
    if (signal.aborted) onAbort();
  });
}

export function createImportAgentServer({ token, classify, parseExpenses, analyzeBill, reconcileBill, shutdownSignal }: ImportAgentServerOptions) {
  if (!/^[A-Za-z0-9_+/=-]{32,256}$/.test(token) || /replace|example|changeme|placeholder/i.test(token)) {
    throw new Error("IMPORT_AGENT_TOKEN must contain a private random token");
  }
  const expected = createHash("sha256").update(`Bearer ${token}`).digest();
  let busy = false;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/health") {
      sendJson(response, 200, { status: "ok" });
      return;
    }
    const analysisRoute = request.url === "/analyze-bill" && !!analyzeBill;
    const reconciliationRoute = request.url === "/reconcile-bill" && !!reconcileBill;
    const longTaskRoute = analysisRoute || reconciliationRoute;
    if (request.method !== "POST" || (request.url !== "/suggest" && (request.url !== "/parse-expenses" || !parseExpenses) && !longTaskRoute)) {
      sendJson(response, 404, { error: "not_found" });
      return;
    }
    const supplied = createHash("sha256").update(request.headers.authorization ?? "").digest();
    if (!timingSafeEqual(expected, supplied)) {
      response.setHeader("Connection", "close");
      sendJson(response, 401, { error: "unauthorized" });
      return;
    }
    if (busy || shutdownSignal?.aborted) {
      response.setHeader("Retry-After", "2");
      sendJson(response, 429, { error: "busy" });
      return;
    }
    if (request.headers["content-type"]?.split(";")[0].trim().toLowerCase() !== "application/json") {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    const maximumTimeout = reconciliationRoute ? BILL_RECONCILIATION_BATCH_TIMEOUT_MS : BILL_ANALYSIS_SUMMARY_TIMEOUT_MS;
    const timeoutHeader = reconciliationRoute ? request.headers["x-bill-reconciliation-timeout-ms"] : analysisRoute ? request.headers["x-bill-analysis-timeout-ms"] : undefined;
    if (timeoutHeader !== undefined && (typeof timeoutHeader !== "string" || !/^[1-9]\d{0,5}$/.test(timeoutHeader)
      || Number(timeoutHeader) > maximumTimeout)) {
      sendJson(response, 400, { error: "invalid_request" });
      return;
    }
    busy = true;
    const controller = new AbortController();
    const receivedAt = performance.now();
    let timedOut = false;
    const onAbort = () => controller.abort();
    const onClose = () => { if (!response.writableEnded) controller.abort(); };
    const expire = () => {
      timedOut = true;
      controller.abort();
    };
    const outerBudget = longTaskRoute ? Math.min(Number(timeoutHeader ?? maximumTimeout), maximumTimeout) : 45_000;
    let deadline = setTimeout(expire, outerBudget);
    request.once("aborted", onAbort);
    response.once("close", onClose);
    shutdownSignal?.addEventListener("abort", onAbort, { once: true });
    try {
      const body = await readBody(request, controller.signal);
      if (reconciliationRoute && reconcileBill) {
        let input;
        try { input = validateBillReconciliationRequest(body); }
        catch { throw new RequestBodyError(400, "invalid_request"); }
        const result = await reconcileBill(input, controller.signal);
        controller.signal.throwIfAborted();
        try { validateBillReconciliationResponse(input, result); }
        catch { throw new AgentRuntimeError("invalid_response"); }
        sendJson(response, 200, result);
      } else if (analysisRoute && analyzeBill) {
        let input;
        try { input = validateBillAnalysisRequest(body); }
        catch { throw new RequestBodyError(400, "invalid_request"); }
        clearTimeout(deadline);
        const budget = Math.min(outerBudget, input.stage === "batch" ? BILL_ANALYSIS_BATCH_TIMEOUT_MS : BILL_ANALYSIS_SUMMARY_TIMEOUT_MS);
        const remaining = budget - (performance.now() - receivedAt);
        if (remaining <= 0) { expire(); throw new AgentRuntimeError("timeout"); }
        deadline = setTimeout(expire, remaining);
        const result = await analyzeBill(input, controller.signal);
        controller.signal.throwIfAborted();
        const wire = { schemaVersion: input.schemaVersion, batchId: input.batchId, body: result };
        try { validateBillAnalysisResponse(input, wire); }
        catch { throw new AgentRuntimeError("invalid_response"); }
        sendJson(response, 200, wire);
      } else if (request.url === "/parse-expenses" && parseExpenses) {
        let input;
        try { input = validateNaturalLanguageRequest(body); }
        catch { throw new RequestBodyError(400, "invalid_request"); }
        const result = await parseExpenses(input, controller.signal);
        controller.signal.throwIfAborted();
        sendJson(response, 200, result);
      } else {
        let input;
        try { input = validateAgentRequest(body); }
        catch { throw new RequestBodyError(400, "invalid_request"); }
        const result = await classify(input, controller.signal);
        controller.signal.throwIfAborted();
        sendJson(response, 200, result);
      }
    } catch (error) {
      if (controller.signal.aborted) {
        sendJson(response, timedOut ? 504 : 499, { error: timedOut ? "timeout" : "cancelled" });
      } else if (error instanceof RequestBodyError) {
        // Drain the remaining body so a rejected upload can receive its fixed error
        // instead of a TCP reset while it is still sending the request.
        request.resume();
        sendJson(response, error.status, { error: error.code });
      } else if (error instanceof AgentRuntimeError) {
        const status = { authentication_required: 503, timeout: 504, cancelled: 499, invalid_response: 502, unavailable: 503 }[error.code];
        sendJson(response, status, { error: error.code });
      } else sendJson(response, 503, { error: "unavailable" });
    } finally {
      // Keep the shared slot occupied until local HTTP work and cleanup settle.
      clearTimeout(deadline);
      request.off("aborted", onAbort);
      response.off("close", onClose);
      shutdownSignal?.removeEventListener("abort", onAbort);
      busy = false;
    }
  });
  server.requestTimeout = 15_000;
  server.headersTimeout = 10_000;
  server.keepAliveTimeout = 5_000;
  server.maxRequestsPerSocket = 100;
  return server;
}
