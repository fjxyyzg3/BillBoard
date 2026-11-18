import { BILL_ANALYSIS_BATCH_TIMEOUT_MS, BILL_ANALYSIS_SUMMARY_TIMEOUT_MS, validateBillAnalysisRequest, validateBillAnalysisResponse, type BillAnalysisAgentRequest } from "./bill-analysis-protocol";
import type { BillAnalysisErrorCode } from "./bill-analysis-types";

export class BillAnalysisAgentError extends Error {
  constructor(readonly code: BillAnalysisErrorCode) { super(code); }
}

export async function requestBillAnalysisAgent(input: BillAnalysisAgentRequest, signal: AbortSignal, remainingMs: number) {
  const request = validateBillAnalysisRequest(input);
  const url = process.env.IMPORT_AGENT_URL?.trim();
  const token = process.env.IMPORT_AGENT_TOKEN?.trim();
  if (!url || !token) throw new BillAnalysisAgentError("UNAVAILABLE");
  let endpoint: URL;
  try {
    const configured = new URL(url);
    if (!["http:", "https:"].includes(configured.protocol) || configured.username || configured.password || configured.search || configured.hash) throw new Error();
    endpoint = new URL("/analyze-bill", configured);
  } catch { throw new BillAnalysisAgentError("UNAVAILABLE"); }
  const budget = Math.floor(Math.min(remainingMs, request.stage === "batch" ? BILL_ANALYSIS_BATCH_TIMEOUT_MS : BILL_ANALYSIS_SUMMARY_TIMEOUT_MS));
  if (budget < 1) throw new BillAnalysisAgentError("TIMEOUT");
  const active = AbortSignal.any([signal, AbortSignal.timeout(budget)]);
  let response: Response | undefined;
  try {
    active.throwIfAborted();
    response = await fetch(endpoint, { method: "POST", cache: "no-store", redirect: "error", signal: active,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Bill-Analysis-Timeout-Ms": String(budget) },
      body: JSON.stringify(request),
    });
    if (!response.ok) throw new BillAnalysisAgentError(response.status === 429 ? "BUSY" : response.status === 504 ? "TIMEOUT" : "UNAVAILABLE");
    const length = response.headers.get("content-length");
    if (!response.body || (length !== null && (!/^\d+$/.test(length) || Number(length) > 256 * 1024))) throw new BillAnalysisAgentError("INVALID_RESPONSE");
    const reader = response.body.getReader();
    let cancelling: Promise<void> | undefined;
    const cancel = () => { cancelling ??= reader.cancel().catch(() => undefined); };
    active.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = [];
    let size = 0;
    try {
      if (active.aborted) cancel();
      while (true) {
        const { done, value } = await reader.read();
        active.throwIfAborted();
        if (done) break;
        size += value.byteLength;
        if (size > 256 * 1024) throw new BillAnalysisAgentError("INVALID_RESPONSE");
        chunks.push(value);
      }
      try { return validateBillAnalysisResponse(request, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { throw new BillAnalysisAgentError("INVALID_RESPONSE"); }
    } finally {
      active.removeEventListener("abort", cancel);
      cancel();
      await cancelling;
      reader.releaseLock();
    }
  } catch (error) {
    if (active.aborted) throw active.reason;
    if (error instanceof BillAnalysisAgentError) throw error;
    throw new BillAnalysisAgentError("UNAVAILABLE");
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
  }
}
