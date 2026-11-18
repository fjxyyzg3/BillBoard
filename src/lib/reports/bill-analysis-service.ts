import type { Locale } from "@/lib/i18n";
import { acquireResourceLease, ResourceBusyError, ResourceExpiredError, type ResourceLease } from "@/lib/resources/admission";
import { waitForBillAnalysisWindow } from "@/lib/resources/bill-analysis-resources";
import { ProcessingConsentError } from "@/lib/processing/preferences";
import { EncryptionRequestError } from "@/lib/encryption/types";
import { BillAnalysisAgentError, requestBillAnalysisAgent } from "./bill-analysis-agent";
import { BILL_ANALYSIS_TOTAL_TIMEOUT_MS } from "./bill-analysis-protocol";
import { prepareBillAnalysis, buildBillAnalysisSummary, BillAnalysisPreparationError } from "./bill-analysis-prepare";
import { queryBillAnalysisSnapshot } from "./bill-analysis-snapshot";
import { claimBillAnalysisRequest, admitBillAnalysisRequest, assertBillAnalysisRequest, cancelBillAnalysisRequest, completeBillAnalysisRequest, completeBillReconciliationRequest, failBillAnalysisRequest, updateBillAnalysisProgress, BillAnalysisStoreError, type BillAnalysisSession } from "./bill-analysis-store";
import { BillReconciliationError, type BillReconciliationAgentResponse } from "./bill-reconciliation-protocol";
import { prepareBillReconciliation, buildBillReconciliationContent } from "./bill-reconciliation-prepare";
import { queryBillReconciliationSnapshot } from "./bill-reconciliation-snapshot";
import { requestBillReconciliationAgent } from "./bill-reconciliation-agent";
import { getBillAnalysisOwner, registerBillAnalysisExecution, finishBillAnalysisExecution, reapStoppedBillAnalysisExecutions } from "./bill-analysis-owner";
import type { BillAnalysisBody, BillAnalysisErrorCode, BillAnalysisEvent, BillAnalysisOutcome, BillAnalysisScope } from "./bill-analysis-types";

export function billAnalysisErrorCode(error: unknown): BillAnalysisErrorCode {
  if (error instanceof BillAnalysisStoreError || error instanceof BillAnalysisPreparationError || error instanceof BillAnalysisAgentError || error instanceof BillReconciliationError) return error.code;
  if (error instanceof ProcessingConsentError) return "CONSENT_REQUIRED";
  if (error instanceof ResourceBusyError) return "BUSY";
  if (error instanceof ResourceExpiredError) return "TIMEOUT";
  if (error instanceof EncryptionRequestError) return "ENCRYPTION_CHANGED";
  if (error instanceof Error && error.message === "Unauthorized") return "UNAUTHORIZED";
  if (error instanceof Error && error.name === "AbortError") return "CANCELLED";
  if (error instanceof Error && error.name === "TimeoutError") return "TIMEOUT";
  return "UNAVAILABLE";
}

export async function generateBillAnalysis(
  session: BillAnalysisSession, input: { requestId: string; scope: BillAnalysisScope; locale: Locale; purpose?: "analysis" | "reconciliation" },
  executionSignal: AbortSignal, emit: (event: BillAnalysisEvent) => void, startedAt = Date.now(),
  onSubmitted?: (result: BillAnalysisOutcome) => void,
): Promise<BillAnalysisOutcome> {
  const deadlineAt = new Date(startedAt + BILL_ANALYSIS_TOTAL_TIMEOUT_MS);
  executionSignal.throwIfAborted();
  await reapStoppedBillAnalysisExecutions();
  let tentativeLease: ResourceLease | undefined;
  let claim: Awaited<ReturnType<typeof claimBillAnalysisRequest>>;
  try {
    claim = await claimBillAnalysisRequest(session, { ...input, deadlineAt, owner: getBillAnalysisOwner() }, async (tx) => {
      tentativeLease = await acquireResourceLease(tx, session, "ai", { profile: "bill-analysis", deferCharge: true, taskKey: `bill-analysis:${input.requestId}` });
      return tentativeLease;
    });
  } catch (error) {
    if (tentativeLease) {
      try { await finishBillAnalysisExecution(session, input.requestId, tentativeLease); } catch { /* Retain locally settled ownership until cleanup can be confirmed. */ }
    }
    if (error instanceof BillAnalysisStoreError || error instanceof ProcessingConsentError || error instanceof ResourceBusyError || error instanceof EncryptionRequestError) {
      return { requestId: input.requestId, status: "error", error: billAnalysisErrorCode(error) };
    }
    throw error;
  }
  if (!claim.created || !claim.lease) return claim.result;
  const lease = claim.lease;
  let unregister = () => {};
  let signal = executionSignal;
  let cancelling: Promise<unknown> | undefined;
  const onAbort = () => { cancelling ??= cancelBillAnalysisRequest(session, input.requestId).catch(() => undefined); };
  let timer: ReturnType<typeof setInterval> | undefined;
  let checking: Promise<void> | undefined;
  let attempt = 0;
  let completedBatches = 0;
  let totalBatches = 0;
  const progress = async (phase: "preparing" | "analyzing" | "waiting" | "summarizing" | "saving") => {
    const value = { phase, completedBatches, totalBatches };
    await updateBillAnalysisProgress(session, input.requestId, value, lease);
    emit({ type: "progress", requestId: input.requestId, ...value });
  };
  const assertActive = async () => { signal.throwIfAborted(); await assertBillAnalysisRequest(session, input.requestId, lease); signal.throwIfAborted(); };
  const call = async <T>(work: () => Promise<T>): Promise<T> => {
    await waitForBillAnalysisWindow(session, lease, ++attempt, { deadlineAt, signal, assertActive, onWaiting: () => progress("waiting") });
    await assertActive();
    const result = await work();
    await assertActive();
    return result;
  };
  try {
    const controller = new AbortController();
    unregister = registerBillAnalysisExecution(session, input.requestId, controller);
    signal = AbortSignal.any([executionSignal, controller.signal, lease.signal, AbortSignal.timeout(Math.max(1, deadlineAt.getTime() - Date.now()))]);
    signal.addEventListener("abort", onAbort, { once: true });
    onSubmitted?.(claim.result);
    if (signal.aborted) onAbort();
    signal.throwIfAborted();
    await progress("preparing");
    if (input.purpose === "reconciliation") {
      const snapshot = await queryBillReconciliationSnapshot(session, input.scope, input.locale, new Date(startedAt), signal);
      const prepared = prepareBillReconciliation(snapshot);
      signal.throwIfAborted();
      await admitBillAnalysisRequest(session, input.requestId, { scope: prepared.scope, locale: prepared.locale, range: prepared.range, snapshotAt: prepared.snapshotAt, inputHash: prepared.inputHash, purpose: "reconciliation", version: 1 }, lease);
      totalBatches = prepared.batches.length;
      timer = setInterval(() => {
        if (!checking) checking = assertActive().catch((error: unknown) => { controller.abort(error); }).finally(() => { checking = undefined; });
      }, 3000);
      timer.unref();
      const results: BillReconciliationAgentResponse[] = [];
      for (const batch of prepared.batches) {
        await progress("analyzing");
        results.push(await call(() => requestBillReconciliationAgent(batch, signal, deadlineAt.getTime() - Date.now())));
        completedBatches++;
        await progress("analyzing");
      }
      await progress("summarizing");
      const content = buildBillReconciliationContent(prepared, results);
      await assertActive();
      await progress("saving");
      return await completeBillReconciliationRequest(session, input.requestId, content, lease);
    }
    const snapshot = await queryBillAnalysisSnapshot(session, input.scope, input.locale, new Date(startedAt), signal);
    const prepared = prepareBillAnalysis(snapshot);
    signal.throwIfAborted();
    await admitBillAnalysisRequest(session, input.requestId, { scope: prepared.scope, locale: prepared.locale, range: prepared.range, snapshotAt: prepared.snapshotAt, inputHash: prepared.inputHash }, lease);
    totalBatches = prepared.batches.length;
    timer = setInterval(() => {
      if (!checking) checking = assertActive().catch((error: unknown) => { controller.abort(error); }).finally(() => { checking = undefined; });
    }, 3000);
    timer.unref();
    const findings: BillAnalysisBody[] = [];
    for (const batch of prepared.batches) {
      await progress("analyzing");
      findings.push(await call(() => requestBillAnalysisAgent(batch, signal, deadlineAt.getTime() - Date.now())));
      completedBatches++;
      await progress("analyzing");
    }
    await progress("summarizing");
    const body = await call(() => requestBillAnalysisAgent(buildBillAnalysisSummary(prepared, findings), signal, deadlineAt.getTime() - Date.now()));
    await assertActive();
    await progress("saving");
    return await completeBillAnalysisRequest(session, input.requestId, { body, metrics: prepared.metrics, evidence: prepared.evidence, transactionRefs: prepared.transactionRefs }, lease);
  } catch (error) {
    const code = executionSignal.aborted ? "CANCELLED" : billAnalysisErrorCode(signal.aborted ? signal.reason : error);
    if (cancelling) await cancelling;
    try { return await failBillAnalysisRequest(session, input.requestId, code); }
    catch { return { requestId: input.requestId, status: "unknown" }; }
  } finally {
    if (timer) clearInterval(timer);
    if (checking) await checking;
    signal.removeEventListener("abort", onAbort);
    if (cancelling) await cancelling;
    // A failed cleanup is retained as a locally settled owner for a later safe retry.
    try { await finishBillAnalysisExecution(session, input.requestId, lease); } catch { /* No early release or new task may bypass the retained execution. */ }
    unregister();
  }
}
