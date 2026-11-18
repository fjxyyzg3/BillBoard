import { z } from "zod";
import { normalizeReconciliationManualGroups, normalizeReconciliationRetentionGroups } from "./bill-reconciliation-selection";
import type { ReconciliationAppliedManualGroup, ReconciliationAppliedRetentionGroup, ReconciliationApplicationDefinition, ReconciliationApplyInput, ReconciliationManualGroup, ReconciliationRetentionGroup } from "./bill-reconciliation-types";

const id = z.string().min(1).max(128);
const total = z.object({ incomeFen: z.number().int().safe(), expenseFen: z.number().int().safe(), netFen: z.number().int().safe(), transactionCount: z.number().int().safe() }).strict();
const bucket = z.object({ key: z.string().max(10), delta: total }).strict();
const outcome = z.object({
  requestId: z.string().uuid(), status: z.enum(["success", "error", "unknown"]),
  error: z.enum(["INVALID", "CONSENT_REQUIRED", "BUSY", "TOO_LARGE", "NO_DATA", "NOT_ACCEPTED", "CONFLICT", "UNAUTHORIZED", "ENCRYPTION_CHANGED", "TIMEOUT", "CANCELLED", "INTERRUPTED", "INVALID_RESPONSE", "UNAVAILABLE"]).optional(),
  reportId: id.optional(), generation: z.number().int().positive().optional(), suggestionIds: z.array(id).max(200).optional(), affectedSuggestionIds: z.array(id).max(200).optional(),
  preview: z.object({ before: total, after: total, delta: total, days: z.array(bucket).max(1000), months: z.array(bucket).max(1000) }).strict().optional(),
}).strict();
const legacyInput = z.object({ requestId: z.string().uuid(), reportId: id, generation: z.number().int().positive(), suggestionIds: z.array(id).min(1).max(200) }).strict();
const terminal = outcome.refine((value) => value.status !== "unknown" && (value.status === "success" ? value.error === undefined : value.error !== undefined));
const definition = z.object({ inputHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), outcome: terminal,
  transactionIds: z.array(id).min(1).max(1000).optional(), consumedIncomeIds: z.array(id).max(1000).optional(),
}).strict().refine((value) => value.outcome.status !== "success" || (value.transactionIds !== undefined && value.consumedIncomeIds !== undefined));

const reference = z.string().regex(/^r[1-9]\d{0,4}$/);
const manualGroupShape = { noticeId: id, refs: z.array(reference).min(2).max(500), keepRef: reference };
function validManualGroups(groups: ReconciliationManualGroup[]) {
  try { normalizeReconciliationManualGroups(groups); return true; } catch { return false; }
}
function validSelection(suggestionIds: string[], manualGroups: ReconciliationManualGroup[]) {
  return suggestionIds.length + manualGroups.length >= 1 && suggestionIds.length + manualGroups.length <= 200
    && new Set(suggestionIds).size === suggestionIds.length && validManualGroups(manualGroups)
    && manualGroups.every((group) => !suggestionIds.includes(group.noticeId));
}
const manualGroup = z.object(manualGroupShape).strict().refine((value) => validManualGroups([value]));
const manualGroups = z.array(manualGroup).max(200).refine(validManualGroups);
const v2Input = z.object({ requestId: z.string().uuid(), reportId: id, generation: z.number().int().positive(),
  version: z.literal(2), suggestionIds: z.array(id).max(200), manualGroups,
}).strict().refine((value) => validSelection(value.suggestionIds, value.manualGroups));
const retentionGroupShape = { noticeId: id, refs: z.array(reference).min(2).max(500), keepRefs: z.array(reference).min(1).max(499) };
function validRetentionGroups(groups: ReconciliationRetentionGroup[]) {
  try { normalizeReconciliationRetentionGroups(groups); return true; } catch { return false; }
}
function validRetentionSelection(suggestionIds: string[], groups: ReconciliationRetentionGroup[]) {
  return suggestionIds.length + groups.length >= 1 && suggestionIds.length + groups.length <= 200
    && new Set(suggestionIds).size === suggestionIds.length && validRetentionGroups(groups)
    && groups.every((group) => !suggestionIds.includes(group.noticeId));
}
const retentionGroup = z.object(retentionGroupShape).strict().refine((value) => validRetentionGroups([value]));
const retentionGroups = z.array(retentionGroup).max(200).refine(validRetentionGroups);
const v3Input = z.object({ requestId: z.string().uuid(), reportId: id, generation: z.number().int().positive(),
  version: z.literal(3), suggestionIds: z.array(id).max(200), manualGroups: retentionGroups,
}).strict().refine((value) => validRetentionSelection(value.suggestionIds, value.manualGroups));
export const reconciliationApplyInputSchema = z.union([legacyInput, v2Input, v3Input]);

function validAppliedManualGroup(group: ReconciliationAppliedManualGroup) {
  if (!validManualGroups([group]) || group.transactions.length !== group.refs.length
    || new Set(group.transactions.map((item) => item.ref)).size !== group.refs.length
    || new Set(group.transactions.map((item) => item.transactionId)).size !== group.refs.length
    || group.transactions.some((item) => !group.refs.includes(item.ref))) return false;
  const keeper = group.transactions.find((item) => item.ref === group.keepRef);
  const deleted = group.transactions.filter((item) => item.ref !== group.keepRef).map((item) => item.transactionId);
  return keeper?.transactionId === group.keepTransactionId && deleted.length === group.deletedTransactionIds.length
    && new Set(group.deletedTransactionIds).size === deleted.length && deleted.every((item) => group.deletedTransactionIds.includes(item));
}
const appliedManualGroup = z.object({ ...manualGroupShape,
  transactions: z.array(z.object({ ref: reference, transactionId: id }).strict()).min(2).max(500),
  keepTransactionId: id, deletedTransactionIds: z.array(id).min(1).max(499),
}).strict().refine(validAppliedManualGroup);
const v2Outcome = outcome.extend({ version: z.literal(2).optional(), manualGroups: manualGroups.optional() })
  .refine((value) => value.status !== "unknown" && (value.status === "success" ? value.error === undefined : value.error !== undefined));
const v2Definition = z.object({ version: z.literal(2), inputHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), outcome: v2Outcome,
  transactionIds: z.array(id).min(1).max(1000).optional(), consumedIncomeIds: z.array(id).max(1000).optional(),
  manualGroups: z.array(appliedManualGroup).max(200),
}).strict().refine((value) => {
  if (value.outcome.status !== "success") return value.manualGroups.length === 0 && !value.outcome.manualGroups?.length
    && value.transactionIds === undefined && value.consumedIncomeIds === undefined;
  if (value.inputHash === null || value.outcome.version !== 2 || !value.outcome.reportId || value.outcome.generation === undefined
    || !value.outcome.preview || !value.outcome.suggestionIds || !value.outcome.manualGroups || !value.transactionIds || !value.consumedIncomeIds
    || !validSelection(value.outcome.suggestionIds, value.outcome.manualGroups) || !validManualGroups(value.manualGroups)
    || new Set(value.transactionIds).size !== value.transactionIds.length || new Set(value.consumedIncomeIds).size !== value.consumedIncomeIds.length) return false;
  const manualIds = value.manualGroups.flatMap((group) => group.transactions.map((item) => item.transactionId));
  if (new Set(manualIds).size !== manualIds.length || manualIds.some((item) => !value.transactionIds!.includes(item))
    || value.consumedIncomeIds.some((item) => !value.transactionIds!.includes(item) || manualIds.includes(item))
    || value.outcome.suggestionIds.length === 0 && manualIds.length !== value.transactionIds.length) return false;
  const publicGroups = normalizeReconciliationManualGroups(value.outcome.manualGroups);
  return JSON.stringify(publicGroups) === JSON.stringify(normalizeReconciliationManualGroups(value.manualGroups));
});

function validAppliedRetentionGroup(group: ReconciliationAppliedRetentionGroup) {
  if (!validRetentionGroups([group]) || group.transactions.length !== group.refs.length
    || new Set(group.transactions.map((item) => item.ref)).size !== group.refs.length
    || new Set(group.transactions.map((item) => item.transactionId)).size !== group.refs.length
    || group.transactions.some((item) => !group.refs.includes(item.ref))) return false;
  const kept = group.transactions.filter((item) => group.keepRefs.includes(item.ref)).map((item) => item.transactionId);
  const deleted = group.transactions.filter((item) => !group.keepRefs.includes(item.ref)).map((item) => item.transactionId);
  return kept.length === group.keepTransactionIds.length && new Set(group.keepTransactionIds).size === kept.length
    && kept.every((item) => group.keepTransactionIds.includes(item))
    && deleted.length === group.deletedTransactionIds.length && new Set(group.deletedTransactionIds).size === deleted.length
    && deleted.every((item) => group.deletedTransactionIds.includes(item));
}
const appliedRetentionGroup = z.object({ ...retentionGroupShape,
  transactions: z.array(z.object({ ref: reference, transactionId: id }).strict()).min(2).max(500),
  keepTransactionIds: z.array(id).min(1).max(499), deletedTransactionIds: z.array(id).min(1).max(499),
}).strict().refine(validAppliedRetentionGroup);
const v3Outcome = outcome.extend({ version: z.literal(3).optional(), manualGroups: retentionGroups.optional() })
  .refine((value) => value.status !== "unknown" && (value.status === "success" ? value.error === undefined : value.error !== undefined));
const v3Definition = z.object({ version: z.literal(3), inputHash: z.string().regex(/^[a-f0-9]{64}$/).nullable(), outcome: v3Outcome,
  transactionIds: z.array(id).min(1).max(1000).optional(), consumedIncomeIds: z.array(id).max(1000).optional(),
  manualGroups: z.array(appliedRetentionGroup).max(200),
}).strict().refine((value) => {
  if (value.outcome.status !== "success") return value.manualGroups.length === 0 && !value.outcome.manualGroups?.length
    && value.transactionIds === undefined && value.consumedIncomeIds === undefined;
  if (value.inputHash === null || value.outcome.version !== 3 || !value.outcome.reportId || value.outcome.generation === undefined
    || !value.outcome.preview || !value.outcome.suggestionIds || !value.outcome.manualGroups || !value.transactionIds || !value.consumedIncomeIds
    || !validRetentionSelection(value.outcome.suggestionIds, value.outcome.manualGroups) || !validRetentionGroups(value.manualGroups)
    || new Set(value.transactionIds).size !== value.transactionIds.length || new Set(value.consumedIncomeIds).size !== value.consumedIncomeIds.length) return false;
  const manualIds = value.manualGroups.flatMap((group) => group.transactions.map((item) => item.transactionId));
  if (new Set(manualIds).size !== manualIds.length || manualIds.some((item) => !value.transactionIds!.includes(item))
    || value.consumedIncomeIds.some((item) => !value.transactionIds!.includes(item) || manualIds.includes(item))
    || value.outcome.suggestionIds.length === 0 && manualIds.length !== value.transactionIds.length) return false;
  return JSON.stringify(normalizeReconciliationRetentionGroups(value.outcome.manualGroups)) === JSON.stringify(normalizeReconciliationRetentionGroups(value.manualGroups));
});

export function parseReconciliationApplyInput(value: unknown): ReconciliationApplyInput { return reconciliationApplyInputSchema.parse(value); }
export function parseReconciliationApplicationDefinition(value: unknown): ReconciliationApplicationDefinition { return z.union([definition, v2Definition, v3Definition]).parse(value); }
