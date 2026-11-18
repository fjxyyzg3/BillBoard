import { z } from "zod";
import { billAnalysisRangeSchema, billAnalysisScopeSchema } from "./bill-analysis-protocol";
import type { BillAnalysisErrorCode } from "./bill-analysis-types";
import type { BillReconciliationContent, ReconciliationSourceRow } from "./bill-reconciliation-types";
import { deriveReconciliationActions } from "./bill-reconciliation-preview";

export const BILL_RECONCILIATION_SCHEMA_VERSION = "bill-reconciliation.v1";
export const MAX_BILL_RECONCILIATION_ROWS = 10_000;
export const MAX_BILL_RECONCILIATION_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_BILL_RECONCILIATION_BATCH_ROWS = 500;
export const MAX_BILL_RECONCILIATION_BATCHES = 24;
export const MAX_BILL_RECONCILIATION_BODY_BYTES = 256 * 1024;
export const MAX_BILL_RECONCILIATION_BATCH_RESULT_BYTES = 4 * 1024;
export const MAX_BILL_RECONCILIATION_RESULT_BYTES = 64 * 1024;
export const MAX_BILL_RECONCILIATION_SUGGESTIONS = 200;
export const MAX_BILL_RECONCILIATION_RESULT_ROWS = 1000;
export const MAX_BILL_RECONCILIATION_CONTENT_BYTES = 16 * 1024 * 1024;
export const BILL_RECONCILIATION_BATCH_TIMEOUT_MS = 90_000;
export const BILL_RECONCILIATION_TOTAL_TIMEOUT_MS = 8 * 60_000;
export const BILL_RECONCILIATION_LEASE_MS = 9 * 60_000;

export class BillReconciliationError extends Error {
  constructor(readonly code: BillAnalysisErrorCode) { super(code); }
}

export function billReconciliationBytes(value: unknown): number {
  return new TextEncoder().encode(JSON.stringify(value)).byteLength;
}

const reference = z.string().regex(/^r[1-9]\d{0,4}$/);
const identifier = z.string().min(1).max(128);
const timestamp = z.iso.datetime({ offset: true });
const amount = z.number().int().positive().max(2_147_483_647);
const precision = z.enum(["second", "minute", "day", "unknown"]);
const uniqueRefs = z.array(reference).min(1).max(MAX_BILL_RECONCILIATION_BATCH_ROWS).refine((refs) => new Set(refs).size === refs.length);
const row = z.object({
  ref: reference, date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/), occurredAt: timestamp,
  type: z.enum(["income", "expense"]), amountFen: amount, categoryName: z.string().min(1).max(400),
  memberAlias: z.string().regex(/^m[1-9]\d{0,4}$/), ledgerAlias: z.string().regex(/^l[1-9]\d{0,4}$/),
  note: z.string().nullable(), source: z.string().max(128).nullable(), timePrecision: precision,
  timeSupplemented: z.boolean(), aggregated: z.boolean(),
});
const modelRow = row.extend({ sourceIdentityAlias: z.string().regex(/^s[1-9]\d{0,4}$/).nullable(),
  offsetEvidence: z.enum(["unconsumed", "consumed", "unknown"]) }).strict();
const publicRow = row.extend({ memberLabel: z.string().max(400), ledgerLabel: z.string().max(400) }).strict();
const sourceRow = z.object({
  id: identifier, ledgerId: identifier, actorMemberId: identifier, createdByMemberId: identifier,
  clientRequestId: z.string().max(128).nullable(), categoryId: identifier, categoryName: z.string().min(1).max(400),
  memberLabel: z.string().max(400), ledgerLabel: z.string().max(400),
  type: z.enum(["INCOME", "EXPENSE"]), amountFen: amount, occurredAt: timestamp, createdAt: timestamp, updatedAt: timestamp,
  note: z.string().nullable(), source: z.string().max(128).nullable(), sourceFingerprint: z.string().max(256).nullable(),
  sourceImportedAt: timestamp.nullable(), archivedAt: timestamp.nullable(), timePrecision: precision,
  timeSupplemented: z.boolean(), aggregated: z.boolean(), offsetEvidence: z.enum(["unconsumed", "consumed", "unknown"]),
  dependencyHash: z.string().regex(/^[a-f0-9]{64}$/),
}).strict();

export const billReconciliationSourceRowSchema = sourceRow;
export const billReconciliationSnapshotSchema = z.object({ scope: billAnalysisScopeSchema,
  locale: z.enum(["zh-CN", "en-US"]), range: billAnalysisRangeSchema, snapshotAt: timestamp,
  rows: z.array(sourceRow).max(MAX_BILL_RECONCILIATION_ROWS),
}).strict();

const requestSchema = z.object({ schemaVersion: z.literal(BILL_RECONCILIATION_SCHEMA_VERSION),
  stage: z.enum(["context", "candidate"]), batchId: z.string().regex(/^b[1-9]\d?$/),
  batchCount: z.number().int().min(1).max(MAX_BILL_RECONCILIATION_BATCHES), locale: z.enum(["zh-CN", "en-US"]),
  range: billAnalysisRangeSchema, snapshotAt: timestamp, rows: z.array(modelRow).min(1).max(MAX_BILL_RECONCILIATION_BATCH_ROWS),
}).strict();
const duplicateGroup = uniqueRefs.refine((refs) => refs.length >= 2);
const offset = z.object({ expenseRef: reference, incomeRefs: uniqueRefs,
  kind: z.enum(["refund", "reimbursement", "mixed"]) }).strict();
const proposal = z.object({ kind: z.enum(["duplicate", "refund", "reimbursement", "combined", "notice"]),
  title: z.string().min(1).max(160), reason: z.string().min(1).max(1000), confidence: z.enum(["high", "review"]),
  evidenceRefs: uniqueRefs, duplicateGroups: z.array(duplicateGroup).max(100), offset: offset.nullable(),
}).strict();
export type BillReconciliationAgentRequest = z.infer<typeof requestSchema>;
export type BillReconciliationProposal = z.infer<typeof proposal>;
export type BillReconciliationAgentResponse = { schemaVersion: typeof BILL_RECONCILIATION_SCHEMA_VERSION; batchId: string; groups: BillReconciliationProposal[] };

const action = z.object({ ref: reference, action: z.enum(["keep", "delete", "update"]), amountFen: amount }).strict();
const suggestion = z.object({ id: z.string().regex(/^s[1-9]\d{0,3}$/),
  kind: z.enum(["duplicate", "refund", "reimbursement", "combined", "notice"]), title: z.string().min(1).max(160),
  reason: z.string().min(1).max(4000), evidenceRefs: uniqueRefs, confidence: z.enum(["high", "review"]),
  defaultSelected: z.boolean(), canApply: z.boolean(), readOnlyReason: z.string().max(128).nullable(),
  actions: z.array(action).min(1).max(MAX_BILL_RECONCILIATION_BATCH_ROWS), applied: z.boolean().optional(),
  relations: z.object({ duplicateGroups: z.array(duplicateGroup).max(100), offset: offset.nullable() }).strict().optional(),
}).strict();
const contentSchema = z.object({ purpose: z.literal("reconciliation"), version: z.literal(1), locale: z.enum(["zh-CN", "en-US"]),
  range: billAnalysisRangeSchema, snapshotAt: timestamp, records: z.array(publicRow).max(MAX_BILL_RECONCILIATION_RESULT_ROWS),
  suggestions: z.array(suggestion).max(MAX_BILL_RECONCILIATION_SUGGESTIONS), assertions: z.record(reference, sourceRow),
}).strict();

export function reconciliationShanghaiDate(value: string): string {
  const milliseconds = new Date(value).getTime();
  if (!Number.isFinite(milliseconds)) throw new BillReconciliationError("INVALID");
  return new Date(milliseconds + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

export function validateBillReconciliationRequest(input: unknown): BillReconciliationAgentRequest {
  try {
    if (billReconciliationBytes(input) > MAX_BILL_RECONCILIATION_BODY_BYTES) throw new Error();
    const value = requestSchema.parse(input);
    if (Number(value.batchId.slice(1)) > value.batchCount || new Set(value.rows.map(({ ref }) => ref)).size !== value.rows.length) throw new Error();
    if (value.rows.some((item) => item.date < value.range.from || item.date > value.range.to || reconciliationShanghaiDate(item.occurredAt) !== item.date)) throw new Error();
    return value;
  } catch { throw new BillReconciliationError("INVALID"); }
}

export function validateBillReconciliationResponse(request: BillReconciliationAgentRequest, input: unknown): BillReconciliationAgentResponse {
  try {
    if (billReconciliationBytes(input) > MAX_BILL_RECONCILIATION_BATCH_RESULT_BYTES) throw new Error();
    const value = z.object({ schemaVersion: z.literal(BILL_RECONCILIATION_SCHEMA_VERSION), batchId: z.literal(request.batchId),
      groups: z.array(proposal).max(MAX_BILL_RECONCILIATION_SUGGESTIONS),
    }).strict().parse(input);
    const allowed = new Set(request.rows.map(({ ref }) => ref));
    for (const group of value.groups) {
      const evidence = new Set(group.evidenceRefs);
      if (group.evidenceRefs.some((ref) => !allowed.has(ref))) throw new Error();
      const used = [...group.duplicateGroups.flat(), ...(group.offset ? [group.offset.expenseRef, ...group.offset.incomeRefs] : [])];
      if (used.some((ref) => !evidence.has(ref)) || (group.kind !== "notice" && !used.length)) throw new Error();
      if (group.kind !== "notice" && group.evidenceRefs.some((ref) => !used.includes(ref))) throw new Error();
      if (group.offset?.incomeRefs.includes(group.offset.expenseRef)) throw new Error();
    }
    return value;
  } catch { throw new BillReconciliationError("INVALID_RESPONSE"); }
}

function assertSourceMatches(record: z.infer<typeof publicRow>, source: ReconciliationSourceRow) {
  if (record.occurredAt !== source.occurredAt || record.date !== reconciliationShanghaiDate(source.occurredAt)
    || record.type !== source.type.toLowerCase() || record.amountFen !== source.amountFen || record.note !== source.note
    || record.source !== source.source || record.timePrecision !== source.timePrecision || record.timeSupplemented !== source.timeSupplemented
    || record.aggregated !== source.aggregated || record.memberLabel !== source.memberLabel || record.ledgerLabel !== source.ledgerLabel) throw new Error();
}

export function parseBillReconciliationContent(input: unknown): BillReconciliationContent {
  try {
    if (billReconciliationBytes(input) > MAX_BILL_RECONCILIATION_CONTENT_BYTES) throw new Error();
    const value = contentSchema.parse(input);
    if (billReconciliationBytes({ ...value, assertions: undefined }) > MAX_BILL_RECONCILIATION_RESULT_BYTES) throw new Error();
    const records = new Map(value.records.map((item) => [item.ref, item]));
    if (records.size !== value.records.length || new Set(value.suggestions.map(({ id }) => id)).size !== value.suggestions.length
      || Object.keys(value.assertions).length !== records.size) throw new Error();
    const identities = new Set<string>();
    for (const record of value.records) {
      const source = value.assertions[record.ref];
      if (!source || identities.has(source.id) || record.date < value.range.from || record.date > value.range.to) throw new Error();
      identities.add(source.id); assertSourceMatches(record, source);
    }
    for (const item of value.suggestions) {
      if (item.evidenceRefs.some((ref) => !records.has(ref)) || new Set(item.actions.map(({ ref }) => ref)).size !== item.actions.length
        || item.actions.length !== item.evidenceRefs.length || item.actions.some(({ ref }) => !item.evidenceRefs.includes(ref))) throw new Error();
      if (item.defaultSelected && (!item.canApply || item.confidence !== "high" || item.applied)
        || item.canApply && (item.kind === "notice" || item.readOnlyReason !== null)
        || !item.canApply && !item.readOnlyReason) throw new Error();
      const groupSources = item.evidenceRefs.map((ref) => value.assertions[ref]);
      if (item.canApply && (new Set(groupSources.map(({ ledgerId }) => ledgerId)).size !== 1
        || new Set(groupSources.map(({ actorMemberId }) => actorMemberId)).size !== 1 || groupSources.some(({ archivedAt }) => archivedAt !== null))) throw new Error();
      if (item.canApply) {
        if (!item.relations) throw new Error();
        const expectedKind = item.relations.offset ? item.relations.duplicateGroups.length || item.relations.offset.kind === "mixed" ? "combined" : item.relations.offset.kind : "duplicate";
        if (item.kind !== expectedKind) throw new Error();
        const expected = deriveReconciliationActions(value.records, value.assertions, item.relations);
        const ordered = [...item.actions].sort((left, right) => left.ref.localeCompare(right.ref));
        if (JSON.stringify(expected) !== JSON.stringify(ordered)) throw new Error();
      }
      for (const change of item.actions) {
        const original = records.get(change.ref)!;
        if (change.action === "update" && (original.type !== "expense" || change.amountFen >= original.amountFen)
          || change.action !== "update" && change.amountFen !== original.amountFen
          || !item.canApply && change.action !== "keep") throw new Error();
      }
    }
    return value;
  } catch { throw new BillReconciliationError("INVALID_RESPONSE"); }
}
