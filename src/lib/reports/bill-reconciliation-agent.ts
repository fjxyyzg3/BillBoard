import { BILL_RECONCILIATION_BATCH_TIMEOUT_MS, MAX_BILL_RECONCILIATION_BATCH_RESULT_BYTES,
  BillReconciliationError, validateBillReconciliationRequest, validateBillReconciliationResponse,
  type BillReconciliationAgentRequest } from "./bill-reconciliation-protocol";

export async function requestBillReconciliationAgent(input: BillReconciliationAgentRequest, signal: AbortSignal, remainingMs: number) {
  const request = validateBillReconciliationRequest(input);
  const url = process.env.IMPORT_AGENT_URL?.trim(), token = process.env.IMPORT_AGENT_TOKEN?.trim();
  if (!url || !token) throw new BillReconciliationError("UNAVAILABLE");
  let endpoint: URL;
  try {
    const configured = new URL(url);
    if (!["http:", "https:"].includes(configured.protocol) || configured.username || configured.password || configured.search || configured.hash) throw new Error();
    endpoint = new URL("/reconcile-bill", configured);
  } catch { throw new BillReconciliationError("UNAVAILABLE"); }
  const budget = Math.floor(Math.min(remainingMs, BILL_RECONCILIATION_BATCH_TIMEOUT_MS));
  if (!Number.isFinite(budget) || budget < 1) throw new BillReconciliationError("TIMEOUT");
  const active = AbortSignal.any([signal, AbortSignal.timeout(budget)]);
  let response: Response | undefined;
  try {
    active.throwIfAborted();
    response = await fetch(endpoint, { method: "POST", cache: "no-store", redirect: "error", signal: active,
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json", "X-Bill-Reconciliation-Timeout-Ms": String(budget) },
      body: JSON.stringify(request) });
    if (!response.ok) throw new BillReconciliationError(response.status === 429 ? "BUSY" : response.status === 504 ? "TIMEOUT" : "UNAVAILABLE");
    const length = response.headers.get("content-length");
    if (!response.body || length !== null && (!/^\d+$/.test(length) || Number(length) > MAX_BILL_RECONCILIATION_BATCH_RESULT_BYTES)) throw new BillReconciliationError("INVALID_RESPONSE");
    const reader = response.body.getReader();
    let cancelling: Promise<void> | undefined;
    const cancel = () => { cancelling ??= reader.cancel().catch(() => undefined); };
    active.addEventListener("abort", cancel, { once: true });
    const chunks: Uint8Array[] = []; let bytes = 0;
    try {
      if (active.aborted) cancel();
      while (true) {
        const { done, value } = await reader.read(); active.throwIfAborted();
        if (done) break;
        bytes += value.byteLength;
        if (bytes > MAX_BILL_RECONCILIATION_BATCH_RESULT_BYTES) throw new BillReconciliationError("INVALID_RESPONSE");
        chunks.push(value);
      }
      try { return validateBillReconciliationResponse(request, JSON.parse(Buffer.concat(chunks).toString("utf8"))); }
      catch { throw new BillReconciliationError("INVALID_RESPONSE"); }
    } finally {
      active.removeEventListener("abort", cancel); cancel(); await cancelling; reader.releaseLock();
    }
  } catch (error) {
    if (active.aborted) throw active.reason;
    if (error instanceof BillReconciliationError) throw error;
    throw new BillReconciliationError("UNAVAILABLE");
  } finally {
    if (response?.body && !response.body.locked) await response.body.cancel().catch(() => undefined);
  }
}
