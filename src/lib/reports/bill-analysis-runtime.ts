import { runEncryptionContext, type EncryptionRequestContext } from "@/lib/encryption/request-context";
import { generateBillAnalysis } from "./bill-analysis-service";
import { disposeBillAnalysisTaskContext } from "./bill-analysis-task-context";
import type { BillAnalysisSession } from "./bill-analysis-store";
import type { BillAnalysisOutcome, BillAnalysisScope } from "./bill-analysis-types";
import type { Locale } from "@/lib/i18n";

type Input = { requestId: string; scope: BillAnalysisScope; locale: Locale; purpose?: "analysis" | "reconciliation" };
type Task = { fingerprint: string; submitted: Promise<BillAnalysisOutcome>; completion: Promise<void>; controller: AbortController };
const shared = globalThis as typeof globalThis & { billAnalysisTasks?: Map<string, Task> };
function tasks() { return shared.billAnalysisTasks ??= new Map(); }

export function submitBillAnalysisTask(
  session: BillAnalysisSession, input: Input, context: EncryptionRequestContext,
  startedAt: number, track: (completion: Promise<void>) => void,
): Promise<BillAnalysisOutcome> {
  const key = JSON.stringify([session.householdId, session.memberId, session.appSessionId, input.requestId]);
  const fingerprint = JSON.stringify([input.scope.mode, input.scope.period, input.scope.ledgerId, input.scope.actorMemberId, input.locale, input.purpose ?? "analysis"]);
  const existing = tasks().get(key);
  if (existing) {
    disposeBillAnalysisTaskContext(context);
    return existing.fingerprint === fingerprint ? existing.submitted
      : Promise.resolve({ requestId: input.requestId, status: "error", error: "CONFLICT" });
  }

  let submitted!: (result: BillAnalysisOutcome) => void;
  const receipt = new Promise<BillAnalysisOutcome>((resolve) => { submitted = resolve; });
  const controller = new AbortController();
  let start!: () => void;
  const gate = new Promise<void>((resolve) => { start = resolve; });
  let runnable = false;
  const completion = gate.then(async () => {
    if (!runnable) return;
    try {
      const result = await runEncryptionContext(context, () => generateBillAnalysis(session, input, controller.signal, () => undefined, startedAt, submitted));
      submitted(result);
    } catch {
      // A lost database commit response cannot be reported as a known failure.
      submitted({ requestId: input.requestId, status: "unknown" });
    } finally {
      disposeBillAnalysisTaskContext(context);
      if (tasks().get(key) === task) tasks().delete(key);
    }
  });
  try { track(completion); }
  catch (error) { disposeBillAnalysisTaskContext(context); start(); throw error; }
  const task: Task = { fingerprint, submitted: receipt, completion, controller };
  tasks().set(key, task);
  runnable = true;
  start();
  return receipt;
}
