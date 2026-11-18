import { BillAnalysisRequestStatus, Prisma, type BillAnalysisReport, type BillAnalysisRequest } from "@prisma/client";
import { z } from "zod";
import { resolveHouseholdContext, type HouseholdSession } from "@/lib/auth/household-context";
import { db, physicalDb } from "@/lib/db";
import { encryptionDatabase } from "@/lib/encryption/database";
import { getEncryptionContext } from "@/lib/encryption/request-context";
import { EncryptionRequestError } from "@/lib/encryption/types";
import { getMemberDisplayName, getMessages, type Locale } from "@/lib/i18n";
import { requireProcessingConsent } from "@/lib/processing/preferences";
import { authorizeMemberReadScope } from "@/lib/records/member-filter";
import { assertResourceLease, type ResourceLease } from "@/lib/resources/admission";
import { getBillAnalysisOwner } from "./bill-analysis-owner";
import { billAnalysisMetricSchema as metricSchema, MAX_BILL_ANALYSIS_BATCHES } from "./bill-analysis-protocol";
import { parseBillReconciliationContent } from "./bill-reconciliation-protocol";
import { loadReconciliationReceipts, reconciliationHandledTransactionIds, ReconciliationReceiptCapacityError } from "./bill-reconciliation-receipts";
import type { BillReconciliationContent, BillReconciliationReportDto } from "./bill-reconciliation-types";
import type { AnyBillReportDto, BillAnalysisBody, BillAnalysisEntriesDto, BillAnalysisEntryDto, BillAnalysisErrorCode, BillAnalysisEvidence, BillAnalysisMetric, BillAnalysisOutcome, BillAnalysisProgress, BillAnalysisReportListItem, BillAnalysisScope, BillAnalysisTaskDto } from "./bill-analysis-types";

export type BillAnalysisSession = HouseholdSession & { id: string; appSessionId: string };
export type BillAnalysisOwner = { id: string; runtime: string; pid: number; startedAt: Date };
export type BillAnalysisClaimInput = { requestId: string; scope: BillAnalysisScope; locale: Locale; deadlineAt: Date; owner: BillAnalysisOwner; purpose?: "analysis" | "reconciliation" };
export type BillAnalysisAdmission = { scope: BillAnalysisScope; locale: Locale; range: { from: string; to: string }; snapshotAt: string; inputHash: string; purpose?: "analysis" | "reconciliation"; version?: 1 };
export type BillAnalysisCompletion = { body: BillAnalysisBody; metrics: BillAnalysisMetric[]; evidence: BillAnalysisEvidence[]; transactionRefs?: Record<string, string> };
type Tx = Prisma.TransactionClient;
const options = { maxWait: 10_000, timeout: 15_000 };
const activeStatuses: BillAnalysisRequestStatus[] = [BillAnalysisRequestStatus.PREPARING, BillAnalysisRequestStatus.RUNNING, BillAnalysisRequestStatus.STOPPING];
const scopeSchema = z.object({ mode: z.enum(["month", "year"]), period: z.string(), ledgerId: z.string().min(1).max(128).nullable(), actorMemberId: z.string().min(1).max(128).nullable() }).strict().refine((scope) => scope.mode === "month" ? /^\d{4}-(?:0[1-9]|1[0-2])$/.test(scope.period) && Number(scope.period.slice(0, 4)) > 0 : /^\d{4}$/.test(scope.period) && Number(scope.period) > 0);
const localeSchema = z.enum(["zh-CN", "en-US"]);
const dateRangeSchema = z.object({ from: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), to: z.string().regex(/^\d{4}-\d{2}-\d{2}$/) }).strict();
const findingSchema = z.object({ title: z.string().max(200), detail: z.string().max(4000), evidenceRefs: z.array(z.string().max(128)).max(100) }).strict();
const bodySchema = z.object({ overview: z.string().max(4000), observations: z.array(findingSchema).max(20), recommendations: z.array(findingSchema).max(20), limitations: z.array(z.string().max(2000)).max(20) }).strict();
const evidenceSchema = z.object({ ref: z.string().max(128), date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), type: z.enum(["income", "expense"]), amountFen: z.number().int().safe().nonnegative(), categoryName: z.string().max(1024), memberAlias: z.string().max(128), ledgerAlias: z.string().max(128) }).strict();
const contentSchema = z.object({ locale: localeSchema, range: dateRangeSchema, snapshotAt: z.string().datetime(), body: bodySchema, metrics: z.array(metricSchema).max(10000), evidence: z.array(evidenceSchema).max(1000), transactionRefs: z.record(z.string().max(128), z.string().min(1).max(128)).optional() }).strict();
const progressSchema = z.object({ phase: z.enum(["preparing", "analyzing", "waiting", "summarizing", "saving"]), completedBatches: z.number().int().min(0).max(MAX_BILL_ANALYSIS_BATCHES), totalBatches: z.number().int().min(0).max(MAX_BILL_ANALYSIS_BATCHES) }).strict().refine((progress) => progress.completedBatches <= progress.totalBatches);
const purposeSchema = z.enum(["analysis", "reconciliation"]);
const definitionSchema = z.object({ scope: scopeSchema, locale: localeSchema, range: dateRangeSchema.optional(), snapshotAt: z.string().datetime().optional(), inputHash: z.string().regex(/^[0-9a-f]{64}$/).optional(), progress: progressSchema.optional(), purpose: purposeSchema.optional(), version: z.literal(1).optional() }).strict();
const reportDefinitionSchema = z.object({ scope: scopeSchema, purpose: purposeSchema.optional(), version: z.literal(1).optional() }).strict();
const errors = new Set<BillAnalysisErrorCode>(["INVALID", "CONSENT_REQUIRED", "BUSY", "TOO_LARGE", "NO_DATA", "NOT_ACCEPTED", "CONFLICT", "UNAUTHORIZED", "ENCRYPTION_CHANGED", "TIMEOUT", "CANCELLED", "INTERRUPTED", "INVALID_RESPONSE", "UNAVAILABLE"]);

export class BillAnalysisStoreError extends Error {
  constructor(readonly code: BillAnalysisErrorCode) { super(code === "UNAUTHORIZED" ? "Unauthorized" : code); }
}
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const keyFor = (session: BillAnalysisSession, requestId: string) => ({ householdId: session.householdId, createdByMemberId: session.memberId, clientRequestId: z.string().uuid().parse(requestId) });
const sameScope = (left: BillAnalysisScope, right: BillAnalysisScope) => left.mode === right.mode && left.period === right.period && left.ledgerId === right.ledgerId && left.actorMemberId === right.actorMemberId;

async function lockRequest(tx: Tx, session: BillAnalysisSession, requestId: string) {
  const key = keyFor(session, requestId);
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["bill-analysis", key.householdId, key.createdByMemberId, key.clientRequestId])}, 0))::text`;
  return key;
}

async function authorize(tx: Tx, session: BillAnalysisSession, writing = false) {
  if (!session.id || !session.appSessionId) throw new BillAnalysisStoreError("UNAUTHORIZED");
  await resolveHouseholdContext(tx, session, { lock: writing, metadataOnly: true });
  const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`;
  if (!await tx.appSession.findFirst({ where: { id: session.appSessionId, userId: session.id, memberId: session.memberId, revokedAt: null, expiresAt: { gt: new Date(Math.max(now.getTime(), Date.now())) } }, select: { id: true } })) throw new BillAnalysisStoreError("UNAUTHORIZED");
  return now;
}

async function mode(tx: Tx, session: BillAnalysisSession) {
  const config = await tx.householdEncryption.findUnique({ where: { householdId: session.householdId }, select: { mode: true, revision: true, activeOperationId: true } });
  const context = getEncryptionContext();
  const value = { configMode: config?.mode ?? "UNENCRYPTED", modeRevision: config?.revision ?? 0 };
  if (context && (context.session.appSessionId !== session.appSessionId || context.revision !== value.modeRevision || context.configMode !== value.configMode)) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
  if (config?.activeOperationId || !["UNENCRYPTED", "ENCRYPTED"].includes(value.configMode) || context?.readOnly) throw new EncryptionRequestError("ENCRYPTION_BUSY");
  return value;
}

async function authorizeScope(tx: Tx, session: BillAnalysisSession, scope: BillAnalysisScope) {
  scopeSchema.parse(scope);
  if (scope.ledgerId && !await tx.ledger.findFirst({ where: { id: scope.ledgerId, householdId: session.householdId }, select: { id: true } })) throw new BillAnalysisStoreError("UNAUTHORIZED");
  await authorizeMemberReadScope(tx, session.householdId, scope.actorMemberId ?? undefined);
}

function assertOriginal(row: BillAnalysisRequest, session: BillAnalysisSession) {
  if (row.originalAppSessionId !== session.appSessionId) throw new BillAnalysisStoreError("CONFLICT");
}

function status(row: BillAnalysisRequest): BillAnalysisTaskDto["status"] {
  if (row.status === "PREPARING" || row.status === "RUNNING") return row.deadlineAt && row.deadlineAt.getTime() <= Date.now() ? "stopping" : "processing";
  if (row.status === "STOPPING") return "stopping";
  return row.status === "SUCCEEDED" ? "success" : "error";
}

function controlledError(row: BillAnalysisRequest): BillAnalysisErrorCode {
  return errors.has(row.errorCode as BillAnalysisErrorCode) ? row.errorCode as BillAnalysisErrorCode : "INTERRUPTED";
}

async function outcome(tx: Tx, row: BillAnalysisRequest): Promise<BillAnalysisOutcome> {
  const requestId = row.clientRequestId;
  const definition = definitionSchema.safeParse(row.definition);
  const progress = definition.success ? definition.data.progress : undefined;
  if (activeStatuses.includes(row.status)) return { requestId, status: status(row), ...progress };
  if (row.status === "SUCCEEDED" && row.reportId && row.generation !== null) {
    const report = await tx.billAnalysisReport.findFirst({ where: { id: row.reportId, householdId: row.householdId }, select: { id: true, generation: true } });
    return { requestId, status: "success", reportId: row.reportId, generation: row.generation, superseded: !report || report.generation !== row.generation, ...progress };
  }
  return { requestId, status: "error", error: controlledError(row), ...progress };
}

export async function claimBillAnalysisRequest(session: BillAnalysisSession, input: BillAnalysisClaimInput, acquire: (tx: Tx) => Promise<ResourceLease>): Promise<{ result: BillAnalysisOutcome; created: boolean; lease?: ResourceLease }> {
  scopeSchema.parse(input.scope); localeSchema.parse(input.locale);
  const purpose = purposeSchema.parse(input.purpose ?? "analysis");
  const tag = purpose === "reconciliation" ? { purpose, version: 1 } : {};
  if (!Number.isFinite(input.deadlineAt.getTime()) || input.deadlineAt.getTime() <= Date.now()) throw new BillAnalysisStoreError("TIMEOUT");
  return db.$transaction(async (tx) => {
    await authorize(tx, session, true);
    const key = await lockRequest(tx, session, input.requestId);
    const existing = await tx.billAnalysisRequest.findUnique({ where: { householdId_createdByMemberId_clientRequestId: key } });
    if (existing) {
      assertOriginal(existing, session);
      const definition = definitionSchema.safeParse(existing.definition);
      if (definition.success && (!sameScope(definition.data.scope, input.scope) || definition.data.locale !== input.locale || (definition.data.purpose ?? "analysis") !== purpose)) return { result: { requestId: input.requestId, status: "error", error: "CONFLICT" }, created: false };
      return { result: await outcome(tx, existing), created: false };
    }
    const protection = await mode(tx, session);
    await authorizeScope(tx, session, input.scope);
    await requireProcessingConsent(tx, session, { ai: true });
    const lease = await acquire(tx);
    if (lease.householdId !== session.householdId || lease.memberId !== session.memberId || lease.kind !== "ai") throw new BillAnalysisStoreError("UNAUTHORIZED");
    await assertResourceLease(tx, lease);
    const reports = await tx.billAnalysisReport.findMany({ where: { householdId: session.householdId }, select: { id: true, definition: true, activeRequestId: true } });
    let report = reports.find((candidate) => { const parsed = reportDefinitionSchema.safeParse(candidate.definition); return parsed.success && sameScope(parsed.data.scope, input.scope) && (parsed.data.purpose ?? "analysis") === purpose; });
    if (report?.activeRequestId) throw new BillAnalysisStoreError("BUSY");
    if (!report) report = await tx.billAnalysisReport.create({ data: { householdId: session.householdId, createdByMemberId: session.memberId, definition: json({ scope: input.scope, ...tag }) }, select: { id: true, definition: true, activeRequestId: true } });
    const created = await tx.billAnalysisRequest.create({ data: { ...key, originalAppSessionId: session.appSessionId, status: "PREPARING", ...protection,
      reportId: report.id, definition: json({ scope: input.scope, locale: input.locale, ...tag, progress: { phase: "preparing", completedBatches: 0, totalBatches: 0 } }), leaseToken: lease.token,
      deadlineAt: new Date(Math.min(input.deadlineAt.getTime(), lease.expiresAt.getTime())),
      ownerId: input.owner.id, ownerRuntime: input.owner.runtime, ownerPid: input.owner.pid, ownerStartedAt: input.owner.startedAt,
    } });
    await tx.billAnalysisReport.update({ where: { id: report.id, householdId: session.householdId }, data: { activeRequestId: created.id } });
    return { result: await outcome(tx, created), created: true, lease };
  }, options);
}

export async function queryBillAnalysisRequest(session: BillAnalysisSession, requestId: string): Promise<BillAnalysisOutcome> {
  return db.$transaction(async (tx) => {
    await authorize(tx, session, true);
    const key = await lockRequest(tx, session, requestId);
    const existing = await tx.billAnalysisRequest.findUnique({ where: { householdId_createdByMemberId_clientRequestId: key } });
    if (existing) { assertOriginal(existing, session); return outcome(tx, existing); }
    const protection = await mode(tx, session);
    const closed = await tx.billAnalysisRequest.create({ data: { ...key, originalAppSessionId: session.appSessionId, status: "FAILED", errorCode: "NOT_ACCEPTED", ...protection } });
    return outcome(tx, closed);
  }, options);
}

async function running(tx: Tx, session: BillAnalysisSession, requestId: string, lease: ResourceLease, allowed: BillAnalysisRequestStatus[] = ["RUNNING"]) {
  const now = await authorize(tx, session, true);
  const key = await lockRequest(tx, session, requestId);
  const row = await tx.billAnalysisRequest.findUniqueOrThrow({ where: { householdId_createdByMemberId_clientRequestId: key } });
  assertOriginal(row, session);
  const protection = await mode(tx, session);
  if (protection.modeRevision !== row.modeRevision || protection.configMode !== row.configMode) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
  if (row.leaseToken !== lease.token || lease.householdId !== session.householdId || lease.memberId !== session.memberId) throw new BillAnalysisStoreError("UNAUTHORIZED");
  await assertResourceLease(tx, lease);
  if (!allowed.includes(row.status)) throw new BillAnalysisStoreError(row.status === "STOPPING" ? "CANCELLED" : "CONFLICT");
  if (!row.deadlineAt || row.deadlineAt <= now || row.deadlineAt.getTime() <= Date.now()) throw new BillAnalysisStoreError("TIMEOUT");
  const definition = definitionSchema.parse(row.definition);
  await authorizeScope(tx, session, definition.scope);
  return { row, definition, now };
}

export async function admitBillAnalysisRequest(session: BillAnalysisSession, requestId: string, input: BillAnalysisAdmission, lease: ResourceLease): Promise<{ reportId: string; generation: number }> {
  const definition = definitionSchema.parse(input);
  return db.$transaction(async (tx) => {
    const current = await running(tx, session, requestId, lease, ["PREPARING"]);
    if (!sameScope(current.definition.scope, input.scope) || current.definition.locale !== input.locale || (current.definition.purpose ?? "analysis") !== (input.purpose ?? "analysis")) throw new BillAnalysisStoreError("CONFLICT");
    await requireProcessingConsent(tx, session, { ai: true });
    if (!current.row.reportId) throw new BillAnalysisStoreError("CONFLICT");
    const report = await tx.billAnalysisReport.findFirstOrThrow({ where: { id: current.row.reportId, householdId: session.householdId } });
    const selected = reportDefinitionSchema.parse(report.definition);
    if (report.activeRequestId !== current.row.id || !sameScope(selected.scope, input.scope) || (selected.purpose ?? "analysis") !== (input.purpose ?? "analysis")) throw new BillAnalysisStoreError("CONFLICT");
    const generation = report.generation + 1;
    await tx.billAnalysisRequest.update({ where: { id: current.row.id }, data: { status: "RUNNING", generation, definition: json({ ...definition, ...(current.definition.progress ? { progress: current.definition.progress } : {}) }) } });
    return { reportId: report.id, generation };
  }, options);
}

export async function updateBillAnalysisProgress(session: BillAnalysisSession, requestId: string, input: BillAnalysisProgress, lease: ResourceLease): Promise<void> {
  const progress = progressSchema.parse(input);
  await db.$transaction(async (tx) => {
    const { row, definition } = await running(tx, session, requestId, lease, ["PREPARING", "RUNNING"]);
    const owner = getBillAnalysisOwner();
    if (row.ownerId !== owner.id || row.ownerRuntime !== owner.runtime || row.ownerPid !== owner.pid || row.ownerStartedAt?.getTime() !== owner.startedAt.getTime() || lease.kind !== "ai") throw new BillAnalysisStoreError("UNAUTHORIZED");
    if (!row.reportId || !await tx.billAnalysisReport.findFirst({ where: { id: row.reportId, householdId: session.householdId, activeRequestId: row.id }, select: { id: true } })) throw new BillAnalysisStoreError("CONFLICT");
    if (row.status === "PREPARING" && (progress.phase !== "preparing" || progress.totalBatches !== 0)) throw new BillAnalysisStoreError("CONFLICT");
    if (definition.progress && (progress.completedBatches < definition.progress.completedBatches || (definition.progress.totalBatches > 0 && progress.totalBatches !== definition.progress.totalBatches))) throw new BillAnalysisStoreError("CONFLICT");
    await tx.billAnalysisRequest.update({ where: { id: row.id }, data: { definition: json({ ...definition, progress }) } });
  }, options);
}

export async function assertBillAnalysisRequest(session: BillAnalysisSession, requestId: string, lease: ResourceLease): Promise<void> {
  await db.$transaction(async (tx) => { await running(tx, session, requestId, lease); }, options);
}

export async function cancelBillAnalysisRequest(session: BillAnalysisSession, requestId: string): Promise<BillAnalysisOutcome> {
  return db.$transaction(async (tx) => {
    await authorize(tx, session, true);
    const key = await lockRequest(tx, session, requestId);
    const row = await tx.billAnalysisRequest.findUnique({ where: { householdId_createdByMemberId_clientRequestId: key } });
    if (!row) {
      const protection = await mode(tx, session);
      const closed = await tx.billAnalysisRequest.create({ data: { ...key, originalAppSessionId: session.appSessionId, status: "FAILED", errorCode: "NOT_ACCEPTED", ...protection } });
      return outcome(tx, closed);
    }
    assertOriginal(row, session);
    if (!activeStatuses.includes(row.status)) return outcome(tx, row);
    await mode(tx, session);
    const stopped = row.status === "STOPPING" ? row : await tx.billAnalysisRequest.update({ where: { id: row.id }, data: { status: "STOPPING" } });
    return outcome(tx, stopped);
  }, options);
}

export async function completeBillAnalysisRequest(session: BillAnalysisSession, requestId: string, input: BillAnalysisCompletion, lease: ResourceLease): Promise<BillAnalysisOutcome> {
  const body = bodySchema.parse(input.body);
  const metrics = z.array(metricSchema).max(10000).parse(input.metrics);
  const availableEvidence = z.array(evidenceSchema).max(10000).parse(input.evidence);
  const references = new Set([...body.observations, ...body.recommendations].flatMap((finding) => finding.evidenceRefs));
  const allowed = new Set([...metrics, ...availableEvidence].map((item) => item.ref));
  if ([...references].some((reference) => !allowed.has(reference))) throw new BillAnalysisStoreError("INVALID_RESPONSE");
  const evidence = availableEvidence.filter((item) => references.has(item.ref));
  const evidenceRefs = new Set(availableEvidence.map((item) => item.ref));
  if (input.transactionRefs && (Object.keys(input.transactionRefs).some((reference) => !evidenceRefs.has(reference)) || evidence.some((item) => !Object.hasOwn(input.transactionRefs!, item.ref)))) throw new BillAnalysisStoreError("INVALID_RESPONSE");
  const transactionRefs = input.transactionRefs ? Object.fromEntries(evidence.map((item) => [item.ref, input.transactionRefs![item.ref]])) : undefined;
  return db.$transaction(async (tx) => {
    const { row, definition, now } = await running(tx, session, requestId, lease);
    if (definition.purpose === "reconciliation") throw new BillAnalysisStoreError("INVALID_RESPONSE");
    if (!row.reportId || row.generation === null || !definition.range || !definition.snapshotAt || !definition.inputHash) throw new BillAnalysisStoreError("CONFLICT");
    const report = await tx.billAnalysisReport.findFirstOrThrow({ where: { id: row.reportId, householdId: session.householdId } });
    if (report.activeRequestId !== row.id || report.generation >= row.generation) throw new BillAnalysisStoreError("CONFLICT");
    if (transactionRefs) {
      const ids = [...new Set(Object.values(transactionRefs))];
      const transactions = await tx.transaction.findMany({ where: { householdId: session.householdId, id: { in: ids } }, select: { id: true } });
      if (transactions.length !== ids.length) throw new BillAnalysisStoreError("UNAUTHORIZED");
    }
    const content = contentSchema.parse({ locale: definition.locale, range: definition.range, snapshotAt: definition.snapshotAt, body, metrics, evidence, ...(transactionRefs ? { transactionRefs } : {}) });
    await tx.billAnalysisReport.update({ where: { id: report.id, householdId: session.householdId }, data: { content: json(content), inputHash: definition.inputHash, generation: row.generation, generatedAt: now, activeRequestId: null } });
    const saved = await tx.billAnalysisRequest.update({ where: { id: row.id }, data: { status: "SUCCEEDED", errorCode: null } });
    return outcome(tx, saved);
  }, options);
}

export async function completeBillReconciliationRequest(session: BillAnalysisSession, requestId: string, input: BillReconciliationContent, lease: ResourceLease): Promise<BillAnalysisOutcome> {
  const content = parseBillReconciliationContent(input);
  return db.$transaction(async (tx) => {
    const { row, definition, now } = await running(tx, session, requestId, lease);
    if (definition.purpose !== "reconciliation" || definition.version !== 1 || !row.reportId || row.generation === null || !definition.inputHash
      || definition.locale !== content.locale || definition.snapshotAt !== content.snapshotAt || JSON.stringify(definition.range) !== JSON.stringify(content.range)) throw new BillAnalysisStoreError("CONFLICT");
    const report = await tx.billAnalysisReport.findFirstOrThrow({ where: { id: row.reportId, householdId: session.householdId } });
    if (report.activeRequestId !== row.id || report.generation >= row.generation) throw new BillAnalysisStoreError("CONFLICT");
    const ids = [...new Set(Object.values(content.assertions).map((item) => item.id))];
    if (ids.length) {
      const records = await tx.transaction.findMany({ where: { householdId: session.householdId, id: { in: ids }, ...(definition.scope.ledgerId ? { ledgerId: definition.scope.ledgerId } : {}), ...(definition.scope.actorMemberId ? { actorMemberId: definition.scope.actorMemberId } : {}) }, select: { id: true } });
      if (records.length !== ids.length) throw new BillAnalysisStoreError("CONFLICT");
    }
    await tx.billAnalysisReport.update({ where: { id: report.id, householdId: session.householdId }, data: { content: json(content), inputHash: definition.inputHash, generation: row.generation, generatedAt: now, activeRequestId: null } });
    return outcome(tx, await tx.billAnalysisRequest.update({ where: { id: row.id }, data: { status: "SUCCEEDED", errorCode: null } }));
  }, options);
}

export async function failBillAnalysisRequest(session: BillAnalysisSession, requestId: string, errorCode: BillAnalysisErrorCode): Promise<BillAnalysisOutcome> {
  return db.$transaction(async (tx) => {
    await authorize(tx, session, true);
    const key = await lockRequest(tx, session, requestId);
    const row = await tx.billAnalysisRequest.findUniqueOrThrow({ where: { householdId_createdByMemberId_clientRequestId: key } });
    assertOriginal(row, session);
    if (!activeStatuses.includes(row.status)) return outcome(tx, row);
    const protection = await mode(tx, session);
    if (protection.modeRevision !== row.modeRevision || protection.configMode !== row.configMode) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
    const failed = await tx.billAnalysisRequest.update({ where: { id: row.id }, data: { status: "FAILED", errorCode } });
    if (row.reportId) await tx.billAnalysisReport.updateMany({ where: { id: row.reportId, householdId: session.householdId, activeRequestId: row.id }, data: { activeRequestId: null } });
    return outcome(tx, failed);
  }, options);
}

async function labelMaps(tx: Tx, session: BillAnalysisSession, locale: Locale) {
  const [ledgers, members] = await Promise.all([
    tx.ledger.findMany({ where: { householdId: session.householdId }, select: { id: true, name: true } }),
    tx.householdMember.findMany({ where: { householdId: session.householdId }, select: { id: true, memberName: true, leftAt: true, user: { select: { status: true } } } }),
  ]);
  const messages = getMessages(locale);
  return { ledgers: new Map(ledgers.map((ledger) => [ledger.id, ledger.name])), members: new Map(members.map((member) => [member.id, getMemberDisplayName(member.memberName, !!member.leftAt || member.user.status !== "ACTIVE", locale)])), allLedgers: messages.ledgers.household, allMembers: messages.memberFilter.all };
}

function scopeLabels(scope: BillAnalysisScope, labels: Awaited<ReturnType<typeof labelMaps>>) {
  const ledger = scope.ledgerId ? labels.ledgers.get(scope.ledgerId) : labels.allLedgers;
  const member = scope.actorMemberId ? labels.members.get(scope.actorMemberId) : labels.allMembers;
  if (!ledger || !member) throw new BillAnalysisStoreError("UNAUTHORIZED");
  return { ledger, member };
}

function dto(row: BillAnalysisReport, labels: Awaited<ReturnType<typeof labelMaps>>): AnyBillReportDto | null {
  const definition = reportDefinitionSchema.safeParse(row.definition);
  if (!definition.success || !row.generatedAt) return null;
  if (definition.data.purpose === "reconciliation") {
    try {
      const content = parseBillReconciliationContent(row.content);
      return { id: row.id, scope: definition.data.scope, scopeLabels: scopeLabels(definition.data.scope, labels), generatedAt: row.generatedAt.toISOString(), generation: row.generation,
        purpose: "reconciliation", version: 1, locale: content.locale, range: content.range, snapshotAt: content.snapshotAt, records: content.records,
        suggestions: content.suggestions.map((suggestion) => row.activeRequestId && suggestion.canApply ? { ...suggestion, canApply: false, defaultSelected: false, readOnlyReason: "processing" } : suggestion) };
    } catch { return null; }
  }
  const content = contentSchema.safeParse(row.content);
  if (!definition.success || !content.success || !row.generatedAt) return null;
  const scope = definition.data.scope;
  return { id: row.id, scope, scopeLabels: scopeLabels(scope, labels), generatedAt: row.generatedAt.toISOString(), generation: row.generation,
    locale: content.data.locale, range: content.data.range, snapshotAt: content.data.snapshotAt, body: content.data.body, metrics: content.data.metrics, evidence: content.data.evidence };
}

function reportListItem(row: BillAnalysisReport, labels: Awaited<ReturnType<typeof labelMaps>>): BillAnalysisReportListItem | null {
  const report = dto(row, labels);
  if (!report) return null;
  const { id, scope, scopeLabels, locale, generatedAt, snapshotAt, range, generation } = report;
  return { id, scope, scopeLabels, locale, generatedAt, snapshotAt, range, generation, ...("purpose" in report && report.purpose === "reconciliation" ? { purpose: "reconciliation" as const } : {}) };
}

function taskDto(row: BillAnalysisRequest, session: BillAnalysisSession): BillAnalysisTaskDto {
  const definition = definitionSchema.safeParse(row.definition);
  const progress = definition.success ? definition.data.progress : undefined;
  const original = row.originalAppSessionId === session.appSessionId && row.createdByMemberId === session.memberId;
  return {
    id: row.id, status: status(row), phase: progress?.phase ?? null,
    completedBatches: progress?.completedBatches ?? 0, totalBatches: progress?.totalBatches ?? 0,
    ...(row.status === "FAILED" ? { error: controlledError(row) } : {}),
    startedAt: row.createdAt.toISOString(), updatedAt: row.updatedAt.toISOString(),
    canCancel: original && activeStatuses.includes(row.status), ...(original ? { requestId: row.clientRequestId } : {}),
  };
}

export async function listBillAnalysisEntries(session: BillAnalysisSession, cursor?: string, locale: Locale = "zh-CN"): Promise<BillAnalysisEntriesDto> {
  let boundary: { id: string; updatedAt: Date } | undefined;
  if (cursor) {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new BillAnalysisStoreError("INVALID");
    try { const parsed = z.object({ id: z.string().min(1).max(128), updatedAt: z.string().datetime() }).strict().parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); boundary = { id: parsed.id, updatedAt: new Date(parsed.updatedAt) }; }
    catch { throw new BillAnalysisStoreError("INVALID"); }
  }
  return physicalDb.$transaction(async (metadata) => {
    const tx = encryptionDatabase(metadata, true);
    await authorize(tx, session);
    // Select unprotected routing metadata before decrypting only the bounded page and active slot.
    const [page, activeSlot, labels] = await Promise.all([
      metadata.billAnalysisReport.findMany({ where: { householdId: session.householdId, ...(boundary ? { OR: [{ updatedAt: { lt: boundary.updatedAt } }, { updatedAt: boundary.updatedAt, id: { lt: boundary.id } }] } : {}) }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], take: 21, select: { id: true, updatedAt: true, activeRequestId: true } }),
      metadata.billAnalysisReport.findFirst({ where: { householdId: session.householdId, activeRequestId: { not: null } }, orderBy: [{ updatedAt: "desc" }, { id: "desc" }], select: { id: true, updatedAt: true, activeRequestId: true } }),
      labelMaps(tx, session, locale),
    ]);
    const selected = [...new Map([...page.slice(0, 20), ...(activeSlot ? [activeSlot] : [])].map((row) => [row.id, row])).values()];
    const latest = await Promise.all(selected.map(async (slot) => ({
      reportId: slot.id,
      requestId: slot.activeRequestId ?? (await metadata.billAnalysisRequest.findFirst({ where: { householdId: session.householdId, reportId: slot.id }, orderBy: [{ createdAt: "desc" }, { id: "desc" }], select: { id: true } }))?.id,
    })));
    const requestIds = latest.flatMap((item) => item.requestId ? [item.requestId] : []);
    const [reports, requests] = await Promise.all([
      tx.billAnalysisReport.findMany({ where: { householdId: session.householdId, id: { in: selected.map((row) => row.id) } } }),
      tx.billAnalysisRequest.findMany({ where: { householdId: session.householdId, id: { in: requestIds } } }),
    ]);
    const requestById = new Map(requests.map((row) => [row.id, row]));
    const latestByReport = new Map(latest.map((item) => [item.reportId, item.requestId ? requestById.get(item.requestId) : undefined]));
    const entriesById = new Map<string, BillAnalysisEntryDto>();
    for (const report of reports) {
      const definition = reportDefinitionSchema.safeParse(report.definition);
      if (!definition.success) continue;
      const request = latestByReport.get(report.id);
      const task = request && request.reportId === report.id ? taskDto(request, session) : null;
      entriesById.set(report.id, { id: report.id, scope: definition.data.scope, scopeLabels: scopeLabels(definition.data.scope, labels), updatedAt: report.updatedAt.toISOString(), report: reportListItem(report, labels), task, ...(definition.data.purpose === "reconciliation" ? { purpose: "reconciliation" as const } : {}) });
    }
    const active = activeSlot ? entriesById.get(activeSlot.id) : undefined;
    const last = page[19];
    return {
      entries: page.slice(0, 20).flatMap((row) => { const value = entriesById.get(row.id); return value ? [value] : []; }),
      cursor: page.length > 20 && last ? Buffer.from(JSON.stringify({ id: last.id, updatedAt: last.updatedAt.toISOString() })).toString("base64url") : null,
      active: active?.task && ["processing", "stopping"].includes(active.task.status) ? active : null,
    };
  }, { ...options, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function readBillAnalysisReport(session: BillAnalysisSession, selection: { scope?: BillAnalysisScope; reportId?: string; purpose?: "analysis" | "reconciliation" }, locale: Locale = "zh-CN"): Promise<AnyBillReportDto | null> {
  return physicalDb.$transaction(async (metadata) => {
    const tx = encryptionDatabase(metadata, true);
    await authorize(tx, session);
    if (selection.scope) await authorizeScope(tx, session, selection.scope);
    if (!selection.reportId && !selection.scope) throw new BillAnalysisStoreError("INVALID");
    const reports = await tx.billAnalysisReport.findMany({ where: { householdId: session.householdId, ...(selection.reportId ? { id: selection.reportId } : {}), generatedAt: { not: null } } });
    const selected = selection.reportId ? reports[0] : reports.find((row) => { const definition = reportDefinitionSchema.safeParse(row.definition); return definition.success && sameScope(definition.data.scope, selection.scope!) && (definition.data.purpose ?? "analysis") === (selection.purpose ?? "analysis"); });
    if (!selected) return null;
    const report = dto(selected, await labelMaps(tx, session, locale));
    if (!report || !("purpose" in report) || report.purpose !== "reconciliation") return report;
    try {
      const content = parseBillReconciliationContent(selected.content);
      const receipts = await loadReconciliationReceipts(tx, metadata, session.householdId, selected.id, selected.generation);
      const handled = reconciliationHandledTransactionIds(content, receipts);
      const applied = new Set(receipts.flatMap((receipt) => receipt.outcome.suggestionIds ?? []));
      const ledgers = await metadata.ledger.findMany({ where: { householdId: session.householdId }, select: { id: true, archivedAt: true } });
      const archived = new Set(ledgers.filter((ledger) => ledger.archivedAt !== null).map((ledger) => ledger.id));
      return { ...report,
        manualReview: { processing: !!selected.activeRequestId, records: content.records.map((record) => ({ ref: record.ref,
          status: handled.has(content.assertions[record.ref].id) ? "handled" as const : archived.has(content.assertions[record.ref].ledgerId) ? "archived" as const : "available" as const })) },
        suggestions: report.suggestions.map((suggestion) => applied.has(suggestion.id) ? { ...suggestion, applied: true, canApply: false, defaultSelected: false, readOnlyReason: "applied" } :
          suggestion.kind !== "notice" && suggestion.evidenceRefs.some((ref) => handled.has(content.assertions[ref].id)) ? { ...suggestion, canApply: false, defaultSelected: false, readOnlyReason: "overlap" } : suggestion),
      } satisfies BillReconciliationReportDto;
    } catch (error) {
      if (error instanceof ReconciliationReceiptCapacityError) throw new BillAnalysisStoreError("TOO_LARGE");
      throw error;
    }
  }, { ...options, isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
}

export async function listBillAnalysisReports(session: BillAnalysisSession, cursor?: string, locale: Locale = "zh-CN"): Promise<{ reports: BillAnalysisReportListItem[]; cursor: string | null }> {
  let boundary: { id: string; generatedAt: Date } | undefined;
  if (cursor) {
    if (cursor.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(cursor)) throw new BillAnalysisStoreError("INVALID");
    try { const parsed = z.object({ id: z.string().min(1).max(128), generatedAt: z.string().datetime() }).strict().parse(JSON.parse(Buffer.from(cursor, "base64url").toString("utf8"))); boundary = { id: parsed.id, generatedAt: new Date(parsed.generatedAt) }; }
    catch { throw new BillAnalysisStoreError("INVALID"); }
  }
  return db.$transaction(async (tx) => {
    await authorize(tx, session);
    const rows = await tx.billAnalysisReport.findMany({ where: { householdId: session.householdId, generatedAt: { not: null }, ...(boundary ? { OR: [{ generatedAt: { lt: boundary.generatedAt } }, { generatedAt: boundary.generatedAt, id: { lt: boundary.id } }] } : {}) }, orderBy: [{ generatedAt: "desc" }, { id: "desc" }], take: 21 });
    const labels = await labelMaps(tx, session, locale);
    const reports = rows.slice(0, 20).flatMap((row) => { const value = reportListItem(row, labels); return value ? [value] : []; });
    const last = rows[19];
    return { reports, cursor: rows.length > 20 && last?.generatedAt ? Buffer.from(JSON.stringify({ id: last.id, generatedAt: last.generatedAt.toISOString() })).toString("base64url") : null };
  }, options);
}
