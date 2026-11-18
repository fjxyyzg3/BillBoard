import { createHash, randomUUID } from "node:crypto";
import { CategoryType, NaturalLanguageRequestStatus, Prisma, TransactionType, UserStatus, type NaturalLanguageRequest as StoredRequest } from "@prisma/client";
import { z } from "zod";
import { getEncryptionContext } from "@/lib/encryption/request-context";
import { db } from "@/lib/db";
import { ProcessingConsentError, requireProcessingConsent } from "@/lib/processing/preferences";
import { consumeVoiceAdmission, VoiceAdmissionError } from "@/lib/processing/voice-admission";
import { acquireResourceLease, assertResourceLease, releaseResourceLease, ResourceBusyError, ResourceExpiredError, type ResourceLease } from "@/lib/resources/admission";
import { resolveHouseholdContext, type HouseholdSession } from "@/lib/auth/household-context";
import { entryContextSchema, type EntryContext } from "./entry-context";
import { recordLedgerAudit } from "./audit";
import { getCategoryDisplayName } from "@/lib/i18n";
import { getCurrentShanghaiDateTimeLocal, parseShanghaiDateTimeLocal } from "./datetime";
import { NaturalLanguageAgentError, parseNaturalLanguageExpenses } from "./natural-language-agent";
import {
  MAX_NATURAL_LANGUAGE_TEXT_LENGTH, MAX_NATURAL_LANGUAGE_TRANSACTIONS, NATURAL_LANGUAGE_SCHEMA_VERSION, naturalLanguageResponseSchema,
  normalizeNaturalLanguageText, validateNaturalLanguageRequest,
  type NaturalLanguageIssue, type NaturalLanguageRequest, type NaturalLanguageResponse,
} from "./natural-language-protocol";
import { NATURAL_LANGUAGE_RESULT_VERSION, naturalLanguageSummarySchema, type NaturalLanguageActionResult, type NaturalLanguageErrorCode } from "./natural-language-types";

type SessionUser = HouseholdSession & { id: string };
type EntryOutcome = { result: NaturalLanguageActionResult; wasCreated: boolean };
type RequestKey = { householdId: string; createdByMemberId: string; clientRequestId: string };
type Claim = { attemptId: string; referenceAt: Date; ledgerId: string; resourceLease: ResourceLease };
const leaseMs = 75_000;
const transactionOptions = { maxWait: 10_000, timeout: 15_000 };
const uuid = z.string().uuid();
const inputSchema = z.object({ requestId: uuid, text: z.string().max(MAX_NATURAL_LANGUAGE_TEXT_LENGTH), locale: z.enum(["zh-CN", "en-US"]), resultVersion: z.literal(NATURAL_LANGUAGE_RESULT_VERSION).optional(), context: entryContextSchema.optional(), voiceAdmissionId: uuid.optional() }).strict();
const transactionIdsSchema = z.array(z.string().min(1)).min(1).max(MAX_NATURAL_LANGUAGE_TRANSACTIONS);
const successSchema = naturalLanguageSummarySchema.safeExtend({ transactionIds: transactionIdsSchema }).superRefine((result, context) => {
  if (result.count !== result.transactionIds.length || new Set(result.transactionIds).size !== result.count) {
    context.addIssue({ code: "custom", path: ["transactionIds"], message: "Transaction identifier mismatch" });
  }
});
const legacySuccessSchema = z.object({ count: z.number().int().min(1).max(MAX_NATURAL_LANGUAGE_TRANSACTIONS), totalAmountFen: z.number().int().positive(), transactionIds: transactionIdsSchema }).strict().superRefine((result, context) => {
  if (result.count !== result.transactionIds.length || new Set(result.transactionIds).size !== result.count
    || result.totalAmountFen < result.count || result.totalAmountFen > result.count * 2147483647) {
    context.addIssue({ code: "custom", message: "Invalid legacy expense result" });
  }
});
const errorCodeSchema = z.enum(["INPUT_EMPTY", "INPUT_TOO_LONG", "INVALID_REQUEST", "CONFLICT", "CONTEXT_REQUIRED", "NOT_ACCEPTED", "EXPIRED", "NEEDS_CORRECTION", "INVALID_RESPONSE", "BUSY", "AUTHENTICATION_REQUIRED", "TIMEOUT", "UNAVAILABLE", "STALE", "CONSENT_REQUIRED"]);

function keyFor(requestId: string, session: SessionUser): RequestKey {
  return { householdId: session.householdId, createdByMemberId: session.memberId, clientRequestId: requestId };
}

async function lockRequest(tx: Prisma.TransactionClient, key: RequestKey) {
  // The key lock also serializes first acceptance against closure before a row exists.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify([key.householdId, key.createdByMemberId, key.clientRequestId])}, 0))::text`;
}

async function assertMember(tx: Prisma.TransactionClient, session: SessionUser, ledgerId?: string) {
  return resolveHouseholdContext(tx, session, { lock: true, ledgerId });
}

function rowResult(row: StoredRequest): NaturalLanguageActionResult {
  const requestId = row.clientRequestId;
  if (row.status === NaturalLanguageRequestStatus.PROCESSING) return { status: "processing", requestId };
  if (row.status === NaturalLanguageRequestStatus.SUCCEEDED) {
    const parsed = successSchema.safeParse(row.result);
    if (parsed.success) {
      const { resultVersion, count, incomeCount, expenseCount, incomeAmountFen, expenseAmountFen } = parsed.data;
      return { status: "success", requestId, resultVersion, count, incomeCount, expenseCount, incomeAmountFen, expenseAmountFen };
    }
    const legacy = legacySuccessSchema.safeParse(row.result);
    if (!legacy.success) return { status: "unknown", requestId };
    return { status: "success", requestId, resultVersion: NATURAL_LANGUAGE_RESULT_VERSION, count: legacy.data.count,
      incomeCount: 0, expenseCount: legacy.data.count, incomeAmountFen: 0, expenseAmountFen: legacy.data.totalAmountFen };
  }
  const code = errorCodeSchema.safeParse(row.errorCode);
  if (!code.success) return { status: "unknown", requestId };
  if (row.issues !== null) {
    const issues = naturalLanguageResponseSchema.safeParse({ schemaVersion: NATURAL_LANGUAGE_SCHEMA_VERSION, outcome: "needs_correction", issues: row.issues });
    if (!issues.success || issues.data.outcome !== "needs_correction" || issues.data.issues.some(({ start, end }) => start >= end || end > MAX_NATURAL_LANGUAGE_TEXT_LENGTH)) return { status: "unknown", requestId };
    return { status: "error", requestId, code: code.data, issues: issues.data.issues };
  }
  return { status: "error", requestId, code: code.data };
}

function sameSession(original: SessionUser, current: SessionUser) {
  return current.id === original.id && current.memberId === original.memberId && current.householdId === original.householdId;
}

async function claimRequest(key: RequestKey, session: SessionUser, inputHash: string, originalContext?: EntryContext, voice?: { admissionId: string; text: string }): Promise<Claim | EntryOutcome> {
  return db.$transaction(async (tx) => {
    let context = await assertMember(tx, session);
    await lockRequest(tx, key);
    const existing = await tx.naturalLanguageRequest.findUnique({ where: { householdId_createdByMemberId_clientRequestId: key } });
    if (existing && originalContext && existing.ledgerId !== originalContext.ledgerId) return { result: { status: "error", requestId: key.clientRequestId, code: "CONFLICT" }, wasCreated: false };
    if (existing?.inputHash && existing.inputHash !== inputHash) return { result: { status: "error", requestId: key.clientRequestId, code: "CONFLICT" }, wasCreated: false };
    if (existing && (existing.status !== NaturalLanguageRequestStatus.PROCESSING || (existing.leaseExpiresAt && existing.leaseExpiresAt.getTime() > Date.now()))) return { result: rowResult(existing), wasCreated: false };
    if (!originalContext) return { result: { status: "error", requestId: key.clientRequestId, code: "CONTEXT_REQUIRED" }, wasCreated: false };
    const ledgerId = originalContext.ledgerId;
    if (ledgerId !== context.ledgerId) context = await assertMember(tx, session, ledgerId);
    let admittedUntil: Date | undefined;
    if (voice) admittedUntil = await consumeVoiceAdmission(tx, session, { ...voice, requestId: key.clientRequestId, ledgerId });
    else await requireProcessingConsent(tx, session, { ai: true });
    const resourceLease = await acquireResourceLease(tx, session, "ai", { ledgerId });
    const attemptId = randomUUID();
    const referenceAt = existing?.referenceAt ?? new Date(Math.floor(Date.now() / 60_000) * 60_000);
    const data = { attemptId, referenceAt, leaseExpiresAt: new Date(Math.min(Date.now() + leaseMs, resourceLease.expiresAt.getTime(), admittedUntil?.getTime() ?? Infinity)), status: NaturalLanguageRequestStatus.PROCESSING };
    if (existing) await tx.naturalLanguageRequest.update({ where: { id: existing.id }, data });
    else await tx.naturalLanguageRequest.create({ data: { ...key, ...data, inputHash, ledgerId: context.ledgerId } });
    return { attemptId, referenceAt, ledgerId: context.ledgerId, resourceLease };
  }, transactionOptions);
}

async function failAttempt(key: RequestKey, attemptId: string, code: NaturalLanguageErrorCode, issues?: NaturalLanguageIssue[]): Promise<EntryOutcome> {
  return db.$transaction(async (tx) => {
    await lockRequest(tx, key);
    const row = await tx.naturalLanguageRequest.findUniqueOrThrow({ where: { householdId_createdByMemberId_clientRequestId: key } });
    if (row.status !== NaturalLanguageRequestStatus.PROCESSING || row.attemptId !== attemptId) return { result: rowResult(row), wasCreated: false };
    const expired = !row.leaseExpiresAt || row.leaseExpiresAt.getTime() <= Date.now();
    const failed = await tx.naturalLanguageRequest.update({ where: { id: row.id }, data: {
      status: NaturalLanguageRequestStatus.FAILED, errorCode: expired ? "EXPIRED" : code,
      issues: !expired && issues ? issues.map(({ code, start, end }) => ({ code, start, end })) : Prisma.DbNull,
      attemptId: null, leaseExpiresAt: null,
    } });
    return { result: rowResult(failed), wasCreated: false };
  }, transactionOptions);
}

async function loadCandidates(session: SessionUser) {
  const [categories, members] = await Promise.all([
    db.category.findMany({ where: { type: { in: [CategoryType.EXPENSE, CategoryType.INCOME] }, isActive: true }, orderBy: [{ sortOrder: "asc" }, { id: "asc" }], select: { id: true, name: true, type: true } }),
    db.householdMember.findMany({ where: { householdId: session.householdId, leftAt: null, user: { status: UserStatus.ACTIVE } }, orderBy: [{ joinedAt: "asc" }, { id: "asc" }], select: { id: true, memberName: true } }),
  ]);
  return { categories, members };
}

type Candidates = Awaited<ReturnType<typeof loadCandidates>>;

async function commitTransactions(
  key: RequestKey, session: SessionUser, claim: Claim, candidates: Candidates,
  request: NaturalLanguageRequest, response: Extract<NaturalLanguageResponse, { outcome: "success" }>,
): Promise<EntryOutcome> {
  return db.$transaction(async (tx) => {
    const context = await assertMember(tx, session, claim.ledgerId);
    await assertResourceLease(tx, claim.resourceLease);
    await lockRequest(tx, key);
    const row = await tx.naturalLanguageRequest.findUniqueOrThrow({ where: { householdId_createdByMemberId_clientRequestId: key } });
    if (row.ledgerId !== claim.ledgerId) throw new Error("Unauthorized");
    if (row.status !== NaturalLanguageRequestStatus.PROCESSING || row.attemptId !== claim.attemptId) return { result: rowResult(row), wasCreated: false };
    if (!row.leaseExpiresAt || row.leaseExpiresAt.getTime() <= Date.now()) {
      const failed = await tx.naturalLanguageRequest.update({ where: { id: row.id }, data: { status: NaturalLanguageRequestStatus.FAILED, errorCode: "EXPIRED", attemptId: null, leaseExpiresAt: null } });
      return { result: rowResult(failed), wasCreated: false };
    }
    const [currentCategories, currentMembers] = await Promise.all([
      tx.category.findMany({ where: { id: { in: candidates.categories.map(({ id }) => id) }, isActive: true }, select: { id: true, name: true, type: true } }),
      tx.householdMember.findMany({ where: { householdId: session.householdId, leftAt: null, user: { status: UserStatus.ACTIVE }, id: { in: candidates.members.map(({ id }) => id) } }, select: { id: true, memberName: true } }),
    ]);
    const categoryByAlias = new Map(request.categories.map(({ id }, index) => [id, candidates.categories[index]]));
    const memberByAlias = new Map(request.members.map(({ id }, index) => [id, candidates.members[index]]));
    const records = response.transactions.map((transaction) => {
      const category = categoryByAlias.get(transaction.categoryId);
      const member = memberByAlias.get(transaction.memberId);
      if (!category || !member || category.type !== transaction.type
        || !currentCategories.some(({ id, name, type }) => id === category.id && name === category.name && type === category.type)
        || !currentMembers.some(({ id, memberName }) => id === member.id && memberName === member.memberName)) throw new NaturalLanguageAgentError("STALE");
      return {
        id: randomUUID(), householdId: session.householdId, ledgerId: claim.ledgerId, createdByMemberId: session.memberId,
        actorMemberId: member.id, categoryId: category.id, type: transaction.type,
        amountFen: transaction.amountFen, occurredAt: transaction.occurredAt === null ? claim.referenceAt : parseShanghaiDateTimeLocal(transaction.occurredAt),
        note: transaction.note.trim() || null,
      };
    });
    await tx.transaction.createMany({ data: records });
    await recordLedgerAudit(tx, { context, action: "TRANSACTION_CREATED", targetId: records.map(({ id }) => id) });
    const summary = records.reduce((totals, record) => {
      if (record.type === TransactionType.INCOME) { totals.incomeCount += 1; totals.incomeAmountFen += record.amountFen; }
      else { totals.expenseCount += 1; totals.expenseAmountFen += record.amountFen; }
      return totals;
    }, { incomeCount: 0, expenseCount: 0, incomeAmountFen: 0, expenseAmountFen: 0 });
    const result = successSchema.parse({ resultVersion: NATURAL_LANGUAGE_RESULT_VERSION, count: records.length, ...summary, transactionIds: records.map(({ id }) => id) });
    const saved = await tx.naturalLanguageRequest.update({ where: { id: row.id }, data: {
      status: NaturalLanguageRequestStatus.SUCCEEDED, result, errorCode: null, issues: Prisma.DbNull, attemptId: null, leaseExpiresAt: null,
    } });
    return { result: rowResult(saved), wasCreated: true };
  }, transactionOptions);
}

export async function createNaturalLanguageEntry(input: unknown, session: SessionUser, recheckSession: () => Promise<SessionUser>): Promise<EntryOutcome> {
  const requestId = input && typeof input === "object" && "requestId" in input && uuid.safeParse(input.requestId).success ? String(input.requestId) : "";
  const parsed = inputSchema.safeParse(input);
  if (!parsed.success) {
    const tooLong = input && typeof input === "object" && "text" in input && typeof input.text === "string" && input.text.length > MAX_NATURAL_LANGUAGE_TEXT_LENGTH;
    return { result: { status: "error", requestId, code: tooLong ? "INPUT_TOO_LONG" : "INVALID_REQUEST" }, wasCreated: false };
  }
  const text = normalizeNaturalLanguageText(parsed.data.text);
  if (parsed.data.context && (parsed.data.context.householdId !== session.householdId || parsed.data.context.memberId !== session.memberId)) throw new Error("Unauthorized");
  if (!text) return { result: { status: "error", requestId, code: "INPUT_EMPTY" }, wasCreated: false };
  const key = keyFor(requestId, session);
  const inputHash = createHash("sha256").update(text).digest("hex");
  let claim: Claim;
  try {
    const claimed = await claimRequest(key, session, inputHash, parsed.data.context,
      parsed.data.voiceAdmissionId ? { admissionId: parsed.data.voiceAdmissionId, text } : undefined);
    if ("result" in claimed) return claimed;
    claim = claimed;
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") throw error;
    if (error instanceof ProcessingConsentError || error instanceof ResourceBusyError || error instanceof VoiceAdmissionError) {
      return { result: { status: "error", requestId, code: error.code }, wasCreated: false };
    }
    return { result: error instanceof Error && error.message === "Ledger is unavailable"
      ? { status: "error", requestId, code: "STALE" } : { status: "unknown", requestId }, wasCreated: false };
  }
  try {
    const candidates = await loadCandidates(session);
    const request = validateNaturalLanguageRequest({
      schemaVersion: NATURAL_LANGUAGE_SCHEMA_VERSION, text, referenceDateTime: getCurrentShanghaiDateTimeLocal(claim.referenceAt),
      categories: candidates.categories.map(({ name, type }, index) => ({ id: `c${index}`, name, displayName: getCategoryDisplayName(name, parsed.data.locale), type })),
      members: candidates.members.map(({ memberName }, index) => ({ id: `m${index}`, displayName: memberName })),
      currentMemberId: `m${candidates.members.findIndex(({ id }) => id === session.memberId)}`,
    });
    const response = await parseNaturalLanguageExpenses(request, claim.resourceLease.signal);
    const currentSession = await recheckSession();
    if (!sameSession(session, currentSession)) throw new Error("Unauthorized");
    if (response.outcome === "needs_correction") return await failAttempt(key, claim.attemptId, "NEEDS_CORRECTION", response.issues);
    return await commitTransactions(key, session, claim, candidates, request, response);
  } catch (error) {
    try {
      const result = await failAttempt(key, claim.attemptId, error instanceof ResourceExpiredError ? "EXPIRED" : error instanceof NaturalLanguageAgentError ? error.code
        : error instanceof Error && error.message === "Ledger is unavailable" ? "STALE" : "UNAVAILABLE");
      if (error instanceof Error && error.message === "Unauthorized") throw error;
      return result;
    } catch (failure) {
      if (failure instanceof Error && failure.message === "Unauthorized") throw failure;
      return { result: { status: "unknown", requestId }, wasCreated: false };
    }
  } finally { await releaseResourceLease(claim.resourceLease).catch(() => undefined); }
}

export async function getNaturalLanguageEntry(requestId: unknown, session: SessionUser, originalContext?: EntryContext): Promise<NaturalLanguageActionResult> {
  if (!uuid.safeParse(requestId).success) return { status: "error", requestId: "", code: "INVALID_REQUEST" };
  if (originalContext && (originalContext.householdId !== session.householdId || originalContext.memberId !== session.memberId)) throw new Error("Unauthorized");
  const key = keyFor(String(requestId), session);
  try {
    return await db.$transaction(async (tx) => {
      let context = await assertMember(tx, session);
      await lockRequest(tx, key);
      let row = await tx.naturalLanguageRequest.findUnique({ where: { householdId_createdByMemberId_clientRequestId: key } });
      if (row && originalContext && row.ledgerId !== originalContext.ledgerId) throw new Error("Unauthorized");
      if (getEncryptionContext()?.readOnly && (!row || (row.status === NaturalLanguageRequestStatus.PROCESSING && (!row.leaseExpiresAt || row.leaseExpiresAt.getTime() <= Date.now())))) return { status: "unknown", requestId: key.clientRequestId };
      if (!row) {
        if (!originalContext) return { status: "error", requestId: key.clientRequestId, code: "CONTEXT_REQUIRED" };
        if (originalContext?.ledgerId && originalContext.ledgerId !== context.ledgerId) context = await assertMember(tx, session, originalContext.ledgerId);
        row = await tx.naturalLanguageRequest.create({ data: { ...key, ledgerId: context.ledgerId, status: NaturalLanguageRequestStatus.FAILED, errorCode: "NOT_ACCEPTED" } });
      }
      else if (row.status === NaturalLanguageRequestStatus.PROCESSING && (!row.leaseExpiresAt || row.leaseExpiresAt.getTime() <= Date.now())) {
        row = await tx.naturalLanguageRequest.update({ where: { id: row.id }, data: { status: NaturalLanguageRequestStatus.FAILED, errorCode: "EXPIRED", attemptId: null, leaseExpiresAt: null } });
      }
      return rowResult(row);
    }, transactionOptions);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") throw error;
    return { status: "unknown", requestId: key.clientRequestId };
  }
}
