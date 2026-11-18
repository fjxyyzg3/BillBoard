import type { HouseholdSession } from "@/lib/auth/household-context";
import { db } from "@/lib/db";
import { chargeResourceAttempt, ResourceWindowBusyError, type ResourceLease } from "./admission";

function wait(ms: number, signal: AbortSignal): Promise<void> {
  signal.throwIfAborted();
  return new Promise((resolve, reject) => {
    const abort = () => { clearTimeout(timer); reject(signal.reason); };
    const timer = setTimeout(() => { signal.removeEventListener("abort", abort); resolve(); }, ms);
    signal.addEventListener("abort", abort, { once: true });
    if (signal.aborted) abort();
  });
}

export async function waitForBillAnalysisWindow(
  session: HouseholdSession, lease: ResourceLease, attempt: number,
  options: {
    deadlineAt: Date;
    signal: AbortSignal;
    assertActive: () => Promise<void>;
    onWaiting: () => void | Promise<void>;
  },
): Promise<void> {
  const remaining = Math.min(options.deadlineAt.getTime(), lease.expiresAt.getTime()) - Date.now();
  if (remaining <= 0) throw new DOMException("Analysis budget expired", "TimeoutError");
  const signal = AbortSignal.any([options.signal, lease.signal, AbortSignal.timeout(remaining)]);
  while (true) {
    signal.throwIfAborted();
    await options.assertActive();
    signal.throwIfAborted();
    try {
      await db.$transaction((tx) => chargeResourceAttempt(tx, session, lease, attempt), { maxWait: 5_000, timeout: 10_000 });
      signal.throwIfAborted();
      return;
    } catch (error) {
      if (!(error instanceof ResourceWindowBusyError)) throw error;
      const delay = Math.max(1, error.retryAfterSeconds) * 1000;
      if (Date.now() + delay >= Math.min(options.deadlineAt.getTime(), lease.expiresAt.getTime())) {
        throw new DOMException("Analysis budget cannot cover the next window", "TimeoutError");
      }
      await options.onWaiting();
      await wait(delay, signal);
    }
  }
}
