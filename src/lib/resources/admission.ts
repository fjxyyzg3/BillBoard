import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { resolveHouseholdContext, type HouseholdSession } from "@/lib/auth/household-context";
import { db } from "@/lib/db";
import { consumeResourceWindow, RESOURCE_POLICIES, ResourceBusyError, ResourceExpiredError, type ResourceKind, type ResourceScope } from "./policy";
import { getEncryptionContext } from "@/lib/encryption/request-context";

export { RESOURCE_POLICIES, ResourceBusyError, ResourceExpiredError, type ResourceKind } from "./policy";

export type ResourceLease = {
  token: string;
  kind: ResourceKind;
  householdId: string;
  memberId: string;
  expiresAt: Date;
  signal: AbortSignal;
};

type AdmissionOptions = { ledgerId?: string; taskKey?: string; deferCharge?: boolean; profile?: "bill-analysis" };
type WorkOptions = AdmissionOptions & {
  signal?: AbortSignal;
  admit?: (tx: Prisma.TransactionClient, lease: ResourceLease) => Promise<void>;
};

type ResourceSubject = { scope: ResourceScope; subjectId: string };
const resourceSubjects = (householdId: string, memberId: string): ResourceSubject[] => [
  { scope: "global", subjectId: "global" },
  { scope: "household", subjectId: householdId },
  { scope: "member", subjectId: memberId },
];

async function lockResourceWindows(tx: Prisma.TransactionClient, kind: ResourceKind, subjects: ResourceSubject[]) {
  for (const { scope, subjectId } of subjects) {
    const key = `${kind}:${scope}:${subjectId}`;
    await tx.$executeRaw`
      INSERT INTO "ResourceWindow" (key, kind, scope, subject_id, started_at, used)
      VALUES (${key}, ${kind}, ${scope}, ${subjectId}, ${new Date(0)}, 0)
      ON CONFLICT (key) DO NOTHING
    `;
    await tx.$queryRaw`SELECT key FROM "ResourceWindow" WHERE key = ${key} FOR UPDATE`;
  }
}

async function resourceWindowCharges(tx: Prisma.TransactionClient, kind: ResourceKind, subjects: ResourceSubject[], now: Date) {
  const windows = [];
  for (const { scope, subjectId } of subjects) {
    const key = `${kind}:${scope}:${subjectId}`;
    const current = await tx.resourceWindow.findUniqueOrThrow({ where: { key } });
    windows.push({ key, next: consumeResourceWindow(current, now, RESOURCE_POLICIES[kind].perMinute[scope]) });
  }
  return windows;
}

async function assertChargeSession(tx: Prisma.TransactionClient, session: HouseholdSession) {
  if (!session.id || !session.appSessionId) throw new Error("Unauthorized");
  const rows = await tx.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "AppSession"
    WHERE id=${session.appSessionId} AND user_id=${session.id} AND member_id=${session.memberId}
      AND revoked_at IS NULL AND expires_at>GREATEST(clock_timestamp(), ${new Date()})
  `;
  if (rows.length !== 1) throw new Error("Unauthorized");
}

export async function acquireResourceLease(
  tx: Prisma.TransactionClient,
  session: HouseholdSession,
  kind: ResourceKind,
  options: AdmissionOptions = {},
): Promise<ResourceLease> {
  // Resource locks always follow household/member/session/ledger locks.
  const identity = await resolveHouseholdContext(tx, session, {
    lock: true, metadataOnly: true, ...(kind !== "export" && options.ledgerId ? { ledgerId: options.ledgerId } : {}),
  });
  const encryption = await tx.householdEncryption.findUnique({ where: { householdId: identity.householdId }, select: { mode: true, activeOperationId: true } });
  if (encryption?.activeOperationId || (encryption && !["UNENCRYPTED", "ENCRYPTED"].includes(encryption.mode))) throw new ResourceBusyError();
  const policy = RESOURCE_POLICIES[kind];
  if (options.profile && kind !== "ai") throw new Error("Invalid resource profile");
  const leaseMs = options.profile === "bill-analysis" ? 9 * 60_000 : policy.leaseMs;
  const subjects = resourceSubjects(identity.householdId, identity.memberId);
  await lockResourceWindows(tx, kind, subjects);
  const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  await tx.resourceLease.deleteMany({ where: { kind, expiresAt: { lte: now }, execution: null, household: { OR: [{ encryption: null }, { encryption: { activeOperationId: null } }] } } });
  const active = await tx.resourceLease.findMany({
    where: { kind, OR: [{ expiresAt: { gt: now } }, { execution: { isNot: null } }] }, select: { householdId: true, memberId: true },
  });
  // The same-kind global lock serializes pruning with admission. Preserve new epoch keys and live owners.
  // A window's last charge can be one minute after its start; retain that grace before an idle hour.
  await tx.resourceWindow.deleteMany({ where: {
    kind, scope: { in: ["household", "member"] }, startedAt: { lt: new Date(now.getTime() - 61 * 60_000) },
    key: { notIn: subjects.map(({ scope, subjectId }) => `${kind}:${scope}:${subjectId}`) },
    NOT: [
      { scope: "household", subjectId: { in: active.map(({ householdId }) => householdId) } },
      { scope: "member", subjectId: { in: active.map(({ memberId }) => memberId) } },
    ],
  } });
  if (active.length >= policy.concurrent.global ||
    active.filter(({ householdId }) => householdId === identity.householdId).length >= policy.concurrent.household ||
    active.filter(({ memberId }) => memberId === identity.memberId).length >= policy.concurrent.member) {
    throw new ResourceBusyError();
  }
  const windows = await resourceWindowCharges(tx, kind, subjects, now);
  // Compute all limits before charging any window. A denied request cannot partly charge.
  const deferred = options.deferCharge === true;
  if (!deferred) for (const { key, next } of windows) await tx.resourceWindow.update({ where: { key }, data: next });
  const lease = await tx.resourceLease.create({ data: {
    token: randomUUID(), kind, householdId: identity.householdId, memberId: identity.memberId,
    ...(options.taskKey ? { taskKey: options.taskKey } : {}),
    expiresAt: new Date(now.getTime() + leaseMs),
  } });
  await tx.resourceExecution.create({ data: { token: lease.token, chargedAt: deferred ? null : now } });
  return { ...lease, kind, signal: AbortSignal.timeout(leaseMs) };
}

export class ResourceWindowBusyError extends ResourceBusyError {}

export async function chargeResourceAttempt(
  tx: Prisma.TransactionClient, session: HouseholdSession, lease: ResourceLease, attempt: number,
): Promise<void> {
  if (lease.kind !== "ai" || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 25) throw new ResourceExpiredError();
  const identity = await resolveHouseholdContext(tx, session, { lock: true, metadataOnly: true });
  if (identity.householdId !== lease.householdId || identity.memberId !== lease.memberId) throw new ResourceExpiredError();
  await assertChargeSession(tx, session);
  const executions = await tx.$queryRaw<Array<{ chargedCalls: number }>>`
    SELECT charged_calls AS "chargedCalls" FROM "ResourceExecution" WHERE token=${lease.token} FOR UPDATE
  `;
  if (executions.length !== 1) throw new ResourceExpiredError();
  await assertResourceLease(tx, lease);
  const config = await tx.householdEncryption.findUnique({ where: { householdId: identity.householdId }, select: { mode: true, revision: true, activeOperationId: true } });
  const context = getEncryptionContext();
  if (config?.activeOperationId || (config && !["UNENCRYPTED", "ENCRYPTED"].includes(config.mode))
    || (context && (context.revision !== (config?.revision ?? 0) || context.configMode !== (config?.mode ?? "UNENCRYPTED")))) {
    throw new ResourceExpiredError();
  }
  if (executions[0].chargedCalls >= attempt) return;
  if (executions[0].chargedCalls !== attempt - 1) throw new ResourceExpiredError();
  const subjects = resourceSubjects(identity.householdId, identity.memberId);
  await lockResourceWindows(tx, "ai", subjects);
  const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  let windows: Awaited<ReturnType<typeof resourceWindowCharges>>;
  try { windows = await resourceWindowCharges(tx, "ai", subjects, now); }
  catch (error) {
    if (error instanceof ResourceBusyError) throw new ResourceWindowBusyError(error.retryAfterSeconds);
    throw error;
  }
  for (const { key, next } of windows) await tx.resourceWindow.update({ where: { key }, data: next });
  await tx.resourceExecution.update({ where: { token: lease.token }, data: { chargedCalls: attempt, chargedAt: now } });
  await assertResourceLease(tx, lease);
  await assertChargeSession(tx, session);
}

export async function chargeResourceLease(tx: Prisma.TransactionClient, session: HouseholdSession, lease: ResourceLease): Promise<void> {
  const identity = await resolveHouseholdContext(tx, session, { lock: true, metadataOnly: true });
  if (identity.householdId !== lease.householdId || identity.memberId !== lease.memberId) throw new ResourceExpiredError();
  await assertChargeSession(tx, session);
  // Match release's execution-before-lease order and serialize retries on the original token.
  const executions = await tx.$queryRaw<Array<{ chargedAt: Date | null }>>`
    SELECT charged_at AS "chargedAt" FROM "ResourceExecution" WHERE token=${lease.token} FOR UPDATE
  `;
  if (executions.length !== 1) throw new ResourceExpiredError();
  await assertResourceLease(tx, lease);
  if (executions[0].chargedAt) return;
  const encryption = await tx.householdEncryption.findUnique({ where: { householdId: identity.householdId }, select: { mode: true, activeOperationId: true } });
  if (encryption?.activeOperationId || (encryption && !["UNENCRYPTED", "ENCRYPTED"].includes(encryption.mode))) throw new ResourceBusyError();
  const subjects = resourceSubjects(identity.householdId, identity.memberId);
  await lockResourceWindows(tx, lease.kind, subjects);
  await assertResourceLease(tx, lease);
  const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  const windows = await resourceWindowCharges(tx, lease.kind, subjects, now);
  for (const { key, next } of windows) await tx.resourceWindow.update({ where: { key }, data: next });
  await tx.resourceExecution.update({ where: { token: lease.token }, data: { chargedAt: now } });
  await assertResourceLease(tx, lease);
  await assertChargeSession(tx, session);
}

export async function assertResourceLease(tx: Prisma.TransactionClient, lease: ResourceLease) {
  const rows = await tx.$queryRaw<Array<{ token: string }>>`
    SELECT token FROM "ResourceLease"
    WHERE token = ${lease.token} AND kind = ${lease.kind}
      AND household_id = ${lease.householdId} AND member_id = ${lease.memberId}
      AND expires_at > clock_timestamp()
    FOR KEY SHARE
  `;
  if (rows.length !== 1 || lease.signal.aborted) throw new ResourceExpiredError();
}

export async function releaseResourceLease(lease: ResourceLease) {
  await db.$transaction(async (tx) => {
    const where = { token: lease.token, kind: lease.kind, householdId: lease.householdId, memberId: lease.memberId };
    await tx.resourceExecution.deleteMany({ where: { token: lease.token, lease: where } });
    await tx.resourceLease.deleteMany({ where });
  });
}

export async function runWithResourceLease<T>(lease: ResourceLease, work: (lease: ResourceLease) => Promise<T>): Promise<T> {
  try {
    if (lease.signal.aborted) throw new ResourceExpiredError();
    return await work(lease);
  } finally {
    // Do not race a deadline against work: a parser/provider must settle before releasing its slot.
    await releaseResourceLease(lease).catch(() => undefined);
  }
}

export async function withResourceLease<T>(
  session: HouseholdSession,
  kind: ResourceKind,
  work: (lease: ResourceLease) => Promise<T>,
  options: WorkOptions = {},
): Promise<T> {
  const lease = await db.$transaction(async (tx) => {
    const admitted = await acquireResourceLease(tx, session, kind, options);
    if (options.admit) await options.admit(tx, admitted);
    return admitted;
  }, { maxWait: 10_000, timeout: 15_000 });
  return runWithResourceLease(options.signal ? { ...lease, signal: AbortSignal.any([lease.signal, options.signal]) } : lease, work);
}
