import { randomUUID } from "node:crypto";
import { hostname } from "node:os";
import type { BillAnalysisOwner, BillAnalysisSession } from "./bill-analysis-store";
import type { ResourceLease } from "@/lib/resources/admission";

type Runtime = { owner: BillAnalysisOwner; controllers: Map<string, AbortController>; settled: Set<string> };
const shared = globalThis as typeof globalThis & { billAnalysisRuntime?: Runtime };
function runtime(): Runtime {
  return shared.billAnalysisRuntime ??= {
    owner: { id: randomUUID(), runtime: hostname(), pid: process.pid, startedAt: new Date(Date.now() - process.uptime() * 1000) },
    controllers: new Map(),
    settled: new Set(),
  };
}

export function getBillAnalysisOwner(): BillAnalysisOwner { return runtime().owner; }

export function isBillAnalysisOwnerStopped(owner: BillAnalysisOwner): boolean {
  const current = getBillAnalysisOwner();
  if (owner.id === current.id || owner.runtime !== current.runtime || !Number.isSafeInteger(owner.pid) || owner.pid < 1) return false;
  if (owner.pid === current.pid) return owner.startedAt.getTime() + 1500 < current.startedAt.getTime();
  try { process.kill(owner.pid, 0); return false; }
  catch (error) { return (error as NodeJS.ErrnoException).code === "ESRCH"; }
}

function key(session: BillAnalysisSession, requestId: string) { return JSON.stringify([session.householdId, session.memberId, session.appSessionId, requestId]); }
export function registerBillAnalysisExecution(session: BillAnalysisSession, requestId: string, controller: AbortController): () => void {
  const value = key(session, requestId);
  if (runtime().controllers.has(value)) throw new Error("Analysis execution already registered");
  runtime().controllers.set(value, controller);
  return () => { if (runtime().controllers.get(value) === controller) runtime().controllers.delete(value); };
}
export function abortBillAnalysisExecution(session: BillAnalysisSession, requestId: string): void {
  runtime().controllers.get(key(session, requestId))?.abort(new DOMException("Analysis cancelled", "AbortError"));
}

const active = ["PREPARING", "RUNNING", "STOPPING"] as const;

// Only the owner calls this after local work and its HTTP cleanup have settled.
export async function finishBillAnalysisExecution(session: BillAnalysisSession, requestId: string, lease: ResourceLease): Promise<void> {
  const { physicalDb } = await import("@/lib/db");
  runtime().settled.add(lease.token);
  await physicalDb.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT id FROM "Household" WHERE id=${session.householdId} FOR UPDATE`;
    const row = await tx.billAnalysisRequest.findFirst({ where: {
      householdId: session.householdId, createdByMemberId: session.memberId, originalAppSessionId: session.appSessionId,
      clientRequestId: requestId, ownerId: getBillAnalysisOwner().id, leaseToken: lease.token,
    }, select: { id: true, status: true } });
    if (!row) return;
    if (active.some((status) => status === row.status)) await tx.billAnalysisRequest.update({ where: { id: row.id }, data: { status: "FAILED" } });
    await tx.billAnalysisReport.updateMany({ where: { householdId: session.householdId, activeRequestId: row.id }, data: { activeRequestId: null } });
    const owned = { token: lease.token, householdId: session.householdId, memberId: session.memberId, kind: "ai", taskKey: `bill-analysis:${requestId}` };
    await tx.resourceExecution.deleteMany({ where: { token: lease.token, lease: owned } });
    await tx.resourceLease.deleteMany({ where: owned });
  }, { maxWait: 10_000, timeout: 15_000 });
  runtime().settled.delete(lease.token);
}

// Stopped runtime proofs are supplied only by the trusted host restart supervisor.
export async function reapStoppedBillAnalysisExecutions(confirmedStoppedRuntimes: readonly string[] = []): Promise<number> {
  const { physicalDb } = await import("@/lib/db");
  const proofs = new Set(confirmedStoppedRuntimes);
  const leases = await physicalDb.resourceLease.findMany({ where: { kind: "ai", taskKey: { startsWith: "bill-analysis:" } }, select: { token: true } });
  if (!leases.length) return 0;
  const rows = await physicalDb.billAnalysisRequest.findMany({ where: { leaseToken: { in: leases.map(({ token }) => token) }, ownerId: { not: null } }, select: {
    id: true, householdId: true, createdByMemberId: true, clientRequestId: true, leaseToken: true,
    ownerId: true, ownerRuntime: true, ownerPid: true, ownerStartedAt: true,
  } });
  let reaped = 0;
  for (const row of rows) {
    if (!row.ownerId || !row.ownerRuntime || !row.ownerPid || !row.ownerStartedAt) continue;
    const owner = { id: row.ownerId, runtime: row.ownerRuntime, pid: row.ownerPid, startedAt: row.ownerStartedAt };
    const locallySettled = owner.id === getBillAnalysisOwner().id && !!row.leaseToken && runtime().settled.has(row.leaseToken);
    const stoppedForeignRuntime = owner.runtime !== getBillAnalysisOwner().runtime && proofs.has(owner.runtime);
    if (!locallySettled && !stoppedForeignRuntime && !isBillAnalysisOwnerStopped(owner)) continue;
    reaped += await physicalDb.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Household" WHERE id=${row.householdId} FOR UPDATE`;
      const found = await tx.billAnalysisRequest.findFirst({ where: { id: row.id, ownerId: owner.id, ownerRuntime: owner.runtime,
        ownerPid: owner.pid, ownerStartedAt: owner.startedAt, leaseToken: row.leaseToken }, select: { id: true, status: true } });
      if (!found) return 0;
      if (active.some((status) => status === found.status)) await tx.billAnalysisRequest.update({ where: { id: found.id }, data: { status: "FAILED" } });
      await tx.billAnalysisReport.updateMany({ where: { householdId: row.householdId, activeRequestId: found.id }, data: { activeRequestId: null } });
      const owned = { token: row.leaseToken!, householdId: row.householdId, memberId: row.createdByMemberId, kind: "ai", taskKey: `bill-analysis:${row.clientRequestId}` };
      await tx.resourceExecution.deleteMany({ where: { token: row.leaseToken!, lease: owned } });
      const removed = await tx.resourceLease.deleteMany({ where: owned });
      return removed.count;
    }, { maxWait: 10_000, timeout: 15_000 });
    if (row.leaseToken) runtime().settled.delete(row.leaseToken);
  }
  return reaped;
}
