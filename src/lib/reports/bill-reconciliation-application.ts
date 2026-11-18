import { createHash } from "node:crypto";
import { Prisma, type BillReconciliationApplication } from "@prisma/client";
import { physicalDb } from "@/lib/db";
import { canonicalJson } from "@/lib/encryption/codec";
import { bulkReplace, encryptionDatabase } from "@/lib/encryption/database";
import { encryptRow } from "@/lib/encryption/protected-models";
import { getEncryptionContext } from "@/lib/encryption/request-context";
import { EncryptionRequestError } from "@/lib/encryption/types";
import { assertEncryptionSession } from "@/lib/encryption/request";
import type { BillAnalysisSession } from "./bill-analysis-store";
import { parseReconciliationApplicationDefinition, parseReconciliationApplyInput } from "./bill-reconciliation-application-protocol";
import { parseBillReconciliationContent } from "./bill-reconciliation-protocol";
import { canonicalReconciliationOffset } from "./bill-reconciliation-preview";
import { deriveManualReconciliationActions, normalizeReconciliationManualGroups, normalizeReconciliationRetentionGroups, previewReconciliationSelection } from "./bill-reconciliation-selection";
import { assertReconciliationReceiptCapacity, loadReconciliationReceipts, reconciliationHandledTransactionIds, ReconciliationReceiptCapacityError } from "./bill-reconciliation-receipts";
import { loadReconciliationRows } from "./bill-reconciliation-snapshot";
import type { BillReconciliationContent, ReconciliationAction, ReconciliationAppliedManualGroup, ReconciliationAppliedRetentionGroup, ReconciliationApplicationDefinition, ReconciliationApplyInput, ReconciliationApplyOutcome, ReconciliationSourceRow } from "./bill-reconciliation-types";

const options = { maxWait: 10_000, timeout: 30_000 };
const json = (value: unknown) => JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
const idPattern = /^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/;
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
const sameSnapshotFields = ["id", "ledgerId", "actorMemberId", "createdByMemberId", "clientRequestId", "categoryId", "type", "amountFen", "occurredAt", "createdAt", "updatedAt", "note", "source", "sourceFingerprint", "sourceImportedAt", "timePrecision", "timeSupplemented", "aggregated", "offsetEvidence", "dependencyHash"] as const;
type AppliedManualGroups = Array<ReconciliationAppliedManualGroup | ReconciliationAppliedRetentionGroup>;

function unchanged(before: ReconciliationSourceRow, after: ReconciliationSourceRow) {
  return sameSnapshotFields.every((field) => before[field] === after[field]);
}
function key(session: BillAnalysisSession, requestId: string) {
  return { householdId: session.householdId, createdByMemberId: session.memberId, clientRequestId: requestId };
}
async function requestLock(tx: Prisma.TransactionClient, session: BillAnalysisSession, requestId: string) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${JSON.stringify(["bill-reconciliation-application", session.householdId, session.memberId, requestId])}, 0))::text`;
}
async function authorize(tx: Prisma.TransactionClient, session: BillAnalysisSession) {
  if (!session.id || !session.appSessionId || !session.memberId || !session.householdId) throw new Error("Unauthorized");
  await tx.$queryRaw`SELECT id FROM "Household" WHERE id=${session.householdId} FOR UPDATE`;
  await tx.$queryRaw`SELECT m.id FROM "HouseholdMember" m JOIN "User" u ON u.id=m.user_id WHERE m.id=${session.memberId} AND m.household_id=${session.householdId} FOR UPDATE OF m,u`;
  await tx.$queryRaw`SELECT id FROM "AppSession" WHERE id=${session.appSessionId} FOR SHARE`;
  if (!await tx.householdMember.findFirst({ where: { id: session.memberId, householdId: session.householdId, userId: session.id, leftAt: null, household: { closedAt: null }, user: { status: "ACTIVE" } }, select: { id: true } })) throw new Error("Unauthorized");
  const now = await assertEncryptionSession(tx, session);
  const config = await tx.householdEncryption.findUnique({ where: { householdId: session.householdId }, select: { mode: true, revision: true, activeOperationId: true } });
  const context = getEncryptionContext();
  if (context && (context.session.appSessionId !== session.appSessionId || context.session.memberId !== session.memberId || context.revision !== (config?.revision ?? 0) || context.configMode !== (config?.mode ?? "UNENCRYPTED"))) throw new EncryptionRequestError("ENCRYPTION_CHANGED");
  if (config?.activeOperationId || !["UNENCRYPTED", "ENCRYPTED"].includes(config?.mode ?? "UNENCRYPTED") || context?.readOnly) throw new EncryptionRequestError("ENCRYPTION_BUSY");
  if (config?.mode === "ENCRYPTED" && (!context?.ring || context.mode !== "ENCRYPTED")) throw new EncryptionRequestError("ENCRYPTION_REQUIRED");
  return now;
}
function requestFailure(requestId: string, error: unknown): ReconciliationApplyOutcome {
  if (error instanceof EncryptionRequestError) return { requestId, status: "unknown", error: "ENCRYPTION_CHANGED" };
  if (error instanceof Error && error.message === "Unauthorized") return { requestId, status: "unknown", error: "UNAUTHORIZED" };
  return { requestId, status: "unknown" };
}
function stored(row: BillReconciliationApplication): ReturnType<typeof parseReconciliationApplicationDefinition> {
  const value = parseReconciliationApplicationDefinition(row.definition);
  if (value.outcome.requestId !== row.clientRequestId || (row.status === "SUCCEEDED") !== (value.outcome.status === "success") ||
    (row.status === "NOT_ACCEPTED" && (value.inputHash !== null || value.outcome.error !== "NOT_ACCEPTED")) ||
    !["SUCCEEDED", "REJECTED", "NOT_ACCEPTED"].includes(row.status)) throw new Error("Invalid application receipt");
  return value;
}
async function receipt(tx: Prisma.TransactionClient, session: BillAnalysisSession, input: ReconciliationApplyInput, inputHash: string,
  outcome: ReconciliationApplyOutcome, reportId: string | null, transactionIds?: string[], consumedIncomeIds?: string[], manualGroups: AppliedManualGroups = []) {
  const definition = applicationDefinition(input, inputHash, outcome, transactionIds, consumedIncomeIds, manualGroups);
  await tx.billReconciliationApplication.create({ data: {
    ...key(session, input.requestId), reportId, generation: reportId ? input.generation : null, status: outcome.status === "success" ? "SUCCEEDED" : "REJECTED",
    definition: json(definition),
  } });
  return outcome;
}
function applicationDefinition(input: ReconciliationApplyInput, inputHash: string, outcome: ReconciliationApplyOutcome,
  transactionIds?: string[], consumedIncomeIds?: string[], manualGroups: AppliedManualGroups = []): ReconciliationApplicationDefinition {
  const common = { inputHash, outcome, ...(transactionIds ? { transactionIds, consumedIncomeIds: consumedIncomeIds ?? [] } : {}) };
  if (input.version === 3) return { ...common, version: 3, manualGroups: manualGroups as ReconciliationAppliedRetentionGroup[] };
  return input.version === 2 ? { ...common, version: 2, manualGroups: manualGroups as ReconciliationAppliedManualGroup[] } : common;
}
function selectedActions(content: BillReconciliationContent, selectedIds: string[]) {
  const byId = new Map(content.suggestions.map((suggestion) => [suggestion.id, suggestion]));
  const refs = new Set<string>();
  const actions: ReconciliationAction[] = [];
  for (const selectedId of selectedIds) {
    const suggestion = byId.get(selectedId);
    if (!suggestion?.canApply || suggestion.applied || suggestion.readOnlyReason || !suggestion.actions.length || suggestion.kind === "notice") throw new Error("Invalid selection");
    const selectedRows = suggestion.actions.map((action) => content.assertions[action.ref]);
    if (selectedRows.some((row) => !row || row.archivedAt !== null) || new Set(selectedRows.map((row) => row.ledgerId)).size !== 1 || new Set(selectedRows.map((row) => row.actorMemberId)).size !== 1) throw new Error("Invalid selection");
    const involved = new Set(suggestion.evidenceRefs);
    if (involved.size !== suggestion.actions.length || suggestion.actions.some((action) => !involved.has(action.ref))) throw new Error("Invalid selection");
    for (const action of suggestion.actions) {
      if (refs.has(action.ref)) throw new Error("Overlapping selection");
      refs.add(action.ref);
      const original = content.assertions[action.ref];
      if (!Number.isSafeInteger(action.amountFen) || action.amountFen <= 0 || action.amountFen > 2_147_483_647 ||
        (action.action !== "update" && action.amountFen !== original.amountFen) ||
        (action.action === "update" && (original.type !== "EXPENSE" || action.amountFen >= original.amountFen))) throw new Error("Invalid action");
      actions.push(action);
    }
  }
  if (actions.length > 1000 || new Set(actions.map((action) => content.assertions[action.ref].id)).size !== actions.length) throw new Error("Invalid action count");
  return actions;
}
function selectedManualGroups(content: BillReconciliationContent, input: ReconciliationApplyInput): AppliedManualGroups {
  if (input.version === undefined) return [];
  return input.manualGroups.map((group) => {
    const sources = group.refs.map((ref) => content.assertions[ref]);
    if (sources.some((row) => !row || row.archivedAt !== null) || new Set(sources.map((row) => row.ledgerId)).size !== 1 ||
      new Set(sources.map((row) => row.actorMemberId)).size !== 1 || new Set(sources.map((row) => row.type)).size !== 1 ||
      new Set(sources.map((row) => row.amountFen)).size !== 1) throw new Error("Invalid manual reconciliation scope");
    const transactions = group.refs.map((ref) => ({ ref, transactionId: content.assertions[ref].id }));
    if ("keepRefs" in group) return { ...group, transactions, keepTransactionIds: group.keepRefs.map((ref) => content.assertions[ref].id),
      deletedTransactionIds: transactions.filter((row) => !group.keepRefs.includes(row.ref)).map((row) => row.transactionId) };
    return { ...group, transactions, keepTransactionId: content.assertions[group.keepRef].id,
      deletedTransactionIds: transactions.filter((row) => row.ref !== group.keepRef).map((row) => row.transactionId) };
  });
}

export async function applyBillReconciliation(session: BillAnalysisSession, value: ReconciliationApplyInput): Promise<ReconciliationApplyOutcome> {
  let input: ReconciliationApplyInput;
  try { input = parseReconciliationApplyInput(value); }
  catch { return { requestId: typeof value?.requestId === "string" ? value.requestId : "", status: "unknown", error: "INVALID" }; }
  const duplicated = new Set(input.suggestionIds).size !== input.suggestionIds.length;
  input = { ...input, suggestionIds: [...new Set(input.suggestionIds)].sort() };
  if (input.version === 2) input.manualGroups = normalizeReconciliationManualGroups(input.manualGroups);
  if (input.version === 3) input.manualGroups = normalizeReconciliationRetentionGroups(input.manualGroups);
  const inputHash = createHash("sha256").update(canonicalJson({ purpose: "reconciliation", version: input.version ?? 1, reportId: input.reportId, generation: input.generation, suggestionIds: input.suggestionIds,
    ...(input.version !== undefined ? { manualGroups: input.manualGroups } : {}) }, 64 * 1024)).digest("hex");
  try {
    return await physicalDb.$transaction(async (physical) => {
      const tx = encryptionDatabase(physical, true);
      const now = await authorize(tx, session);
      const report = await tx.billAnalysisReport.findFirst({ where: { id: input.reportId, householdId: session.householdId } });
      let content: BillReconciliationContent | null = null;
      try { content = parseBillReconciliationContent(report?.content); } catch { /* Legacy and malformed reports cannot authorize actions. */ }
      const selectedRefs = [...input.suggestionIds.flatMap((id) => content?.suggestions.find((suggestion) => suggestion.id === id)?.actions.map((action) => action.ref) ?? []),
        ...(input.version !== undefined ? input.manualGroups.flatMap((group) => group.refs) : [])];
      const ledgerIds = [...new Set(selectedRefs.flatMap((ref) => content?.assertions[ref]?.ledgerId ? [content.assertions[ref].ledgerId] : []))].sort();
      for (const ledgerId of ledgerIds) await tx.$queryRaw`SELECT id FROM "Ledger" WHERE id=${ledgerId} AND household_id=${session.householdId} FOR UPDATE`;
      await requestLock(tx, session, input.requestId);
      const previous = await tx.billReconciliationApplication.findUnique({ where: { householdId_createdByMemberId_clientRequestId: key(session, input.requestId) } });
      if (previous) {
        const result = stored(previous);
        return result.inputHash === null || result.inputHash === inputHash ? result.outcome : { requestId: input.requestId, status: "error", error: "CONFLICT" };
      }
      if (report) await tx.$queryRaw`SELECT id FROM "BillAnalysisReport" WHERE id=${report.id} AND household_id=${session.householdId} FOR UPDATE`;
      const reject = (affectedSuggestionIds = input.suggestionIds) => receipt(tx, session, input, inputHash, { requestId: input.requestId, status: "error", error: "CONFLICT", affectedSuggestionIds }, report?.id ?? null);
      const definition = report?.definition as Record<string, unknown> | null;
      if (duplicated || !report || !content || definition?.purpose !== "reconciliation" || definition.version !== 1 || report.generation !== input.generation || report.activeRequestId || !report.generatedAt) return reject();
      let actions: ReconciliationAction[], manualGroups: AppliedManualGroups;
      try {
        manualGroups = selectedManualGroups(content, input);
        actions = [...selectedActions(content, input.suggestionIds), ...(input.version !== undefined ? deriveManualReconciliationActions(content.records, content.suggestions, input.manualGroups) : [])];
        if (!actions.length || actions.length > 1000 || new Set(actions.map((action) => action.ref)).size !== actions.length || new Set(actions.map((action) => content!.assertions[action.ref]?.id)).size !== actions.length) throw new Error("Overlapping reconciliation selection");
      }
      catch { return reject(); }
      const sources = actions.map((action) => content.assertions[action.ref]);
      const ids = sources.map((row) => row.id);
      const receipts = await loadReconciliationReceipts(tx, physical, session.householdId, report.id, input.generation);
      const handled = reconciliationHandledTransactionIds(content, receipts);
      if (ids.some((id) => handled.has(id))) return reject();
      const latest = await loadReconciliationRows(tx, session.householdId, ids, physical);
      const byId = new Map(latest.map((row) => [row.id, row]));
      const invalidRefs = new Set(actions.filter((action) => {
        const before = content!.assertions[action.ref], current = byId.get(before.id);
        return !current || current.archivedAt !== null || !unchanged(before, current);
      }).map((action) => action.ref));
      if (invalidRefs.size) return reject(content.suggestions.filter((suggestion) => input.suggestionIds.includes(suggestion.id) && suggestion.evidenceRefs.some((ref) => invalidRefs.has(ref))).map((suggestion) => suggestion.id));
      const ledgers = await tx.ledger.findMany({ where: { householdId: session.householdId, id: { in: ledgerIds }, archivedAt: null }, select: { id: true } });
      if (ledgers.length !== ledgerIds.length) return reject();
      const preview = previewReconciliationSelection(content.records, content.suggestions, { suggestionIds: input.suggestionIds, manualGroups: input.version !== undefined ? input.manualGroups : [] });
      const original = await tx.transaction.findMany({ where: { householdId: session.householdId, id: { in: ids }, deletedAt: null } });
      if (original.length !== ids.length) return reject();
      const actionById = new Map(actions.map((action) => [content!.assertions[action.ref].id, action]));
      const changed = original.filter((row) => actionById.get(row.id)!.action !== "keep");
      const replacements = changed.map((row) => {
        const action = actionById.get(row.id)!;
        return { ...row, ...(action.action === "update" ? { amountFen: action.amountFen } : { deletedAt: now }), updatedAt: now };
      });
      const outcome: ReconciliationApplyOutcome = { requestId: input.requestId, status: "success", reportId: report.id, generation: input.generation, suggestionIds: input.suggestionIds, preview,
        ...(input.version !== undefined ? { version: input.version, manualGroups: input.manualGroups } : {}) };
      const offsetRefs = new Set(input.suggestionIds.flatMap((id) => {
        const relations = content!.suggestions.find((suggestion) => suggestion.id === id)?.relations;
        return relations?.offset ? canonicalReconciliationOffset(content!.records, content!.assertions, relations)!.incomeRefs : [];
      }));
      const consumedIncomeIds = changed.filter((row) => row.type === "INCOME" && actionById.get(row.id)!.action === "delete" && (input.version === undefined || offsetRefs.has(actionById.get(row.id)!.ref))).map((row) => row.id);
      try { assertReconciliationReceiptCapacity(receipts, applicationDefinition(input, inputHash, outcome, ids, consumedIncomeIds, manualGroups)); }
      catch (error) {
        if (!(error instanceof ReconciliationReceiptCapacityError)) throw error;
        return receipt(tx, session, input, inputHash, { requestId: input.requestId, status: "error", error: "TOO_LARGE" }, report.id);
      }
      const context = getEncryptionContext();
      const encrypted = context?.mode === "ENCRYPTED";
      const category = encrypted ? await tx.category.findFirst({ select: { id: true }, orderBy: { id: "asc" } }) : null;
      const encoded = [];
      for (const row of replacements) encoded.push(encrypted ? await encryptRow("transaction", row, context.ring!, session.householdId, category!.id) : row);
      await bulkReplace(physical, "transaction", encoded, encrypted ? undefined : ["amountFen", "deletedAt", "updatedAt"]);
      await tx.ledgerAuditLog.createMany({ data: changed.map((row) => ({ householdId: session.householdId, memberId: session.memberId, ledgerId: row.ledgerId, targetId: row.id, action: actionById.get(row.id)!.action === "update" ? "TRANSACTION_UPDATED" as const : "TRANSACTION_DELETED" as const })) });
      await authorize(tx, session);
      return receipt(tx, session, input, inputHash, outcome, report.id, ids, consumedIncomeIds, manualGroups);
    }, options);
  } catch (error) { return requestFailure(input.requestId, error); }
}

export async function queryBillReconciliationApplication(session: BillAnalysisSession, requestId: string): Promise<ReconciliationApplyOutcome> {
  if (!uuidPattern.test(requestId) || !idPattern.test(session.householdId) || !idPattern.test(session.memberId)) return { requestId, status: "unknown", error: "INVALID" };
  try {
    return await physicalDb.$transaction(async (physical) => {
      const tx = encryptionDatabase(physical, true);
      await authorize(tx, session);
      await requestLock(tx, session, requestId);
      const previous = await tx.billReconciliationApplication.findUnique({ where: { householdId_createdByMemberId_clientRequestId: key(session, requestId) } });
      if (previous) return stored(previous).outcome;
      const outcome: ReconciliationApplyOutcome = { requestId, status: "error", error: "NOT_ACCEPTED" };
      await tx.billReconciliationApplication.create({ data: { ...key(session, requestId), status: "NOT_ACCEPTED", definition: json({ inputHash: null, outcome }) } });
      return outcome;
    }, options);
  } catch (error) { return requestFailure(requestId, error); }
}
