import type { Locale } from "@/lib/i18n";
import type { BillAnalysisErrorCode, BillAnalysisReportListItem, BillAnalysisScope } from "./bill-analysis-types";

export type ReconciliationTimePrecision = "second" | "minute" | "day" | "unknown";
export type ReconciliationSourceRow = {
  id: string;
  ledgerId: string;
  actorMemberId: string;
  createdByMemberId: string;
  clientRequestId: string | null;
  categoryId: string;
  categoryName: string;
  memberLabel: string;
  ledgerLabel: string;
  type: "INCOME" | "EXPENSE";
  amountFen: number;
  occurredAt: string;
  createdAt: string;
  updatedAt: string;
  note: string | null;
  source: string | null;
  sourceFingerprint: string | null;
  sourceImportedAt: string | null;
  archivedAt: string | null;
  timePrecision: ReconciliationTimePrecision;
  timeSupplemented: boolean;
  aggregated: boolean;
  offsetEvidence: "unconsumed" | "consumed" | "unknown";
  dependencyHash: string;
};

export type ReconciliationRecord = {
  ref: string;
  occurredAt: string;
  date: string;
  type: "income" | "expense";
  amountFen: number;
  categoryName: string;
  memberLabel: string;
  ledgerLabel: string;
  memberAlias: string;
  ledgerAlias: string;
  note: string | null;
  source: string | null;
  timePrecision: ReconciliationTimePrecision;
  timeSupplemented: boolean;
  aggregated: boolean;
};

export type ReconciliationAction = { ref: string; action: "keep" | "delete" | "update"; amountFen: number };
export type ReconciliationManualGroup = { noticeId: string; refs: string[]; keepRef: string };
export type ReconciliationRetentionGroup = { noticeId: string; refs: string[]; keepRefs: string[] };
export type ReconciliationManualSelectionGroup = ReconciliationManualGroup | ReconciliationRetentionGroup;
export type ReconciliationAppliedManualGroup = ReconciliationManualGroup & {
  transactions: Array<{ ref: string; transactionId: string }>;
  keepTransactionId: string;
  deletedTransactionIds: string[];
};
export type ReconciliationAppliedRetentionGroup = ReconciliationRetentionGroup & {
  transactions: Array<{ ref: string; transactionId: string }>;
  keepTransactionIds: string[];
  deletedTransactionIds: string[];
};
export type ReconciliationSelection = { suggestionIds: string[]; manualGroups: ReconciliationManualSelectionGroup[] };
export type ReconciliationManualReview = {
  processing: boolean;
  records: Array<{ ref: string; status: "available" | "handled" | "archived" }>;
};
export type ReconciliationSuggestion = {
  id: string;
  kind: "duplicate" | "refund" | "reimbursement" | "combined" | "notice";
  title: string;
  reason: string;
  evidenceRefs: string[];
  confidence: "high" | "review";
  defaultSelected: boolean;
  canApply: boolean;
  readOnlyReason: string | null;
  actions: ReconciliationAction[];
  relations?: { duplicateGroups: string[][]; offset: { expenseRef: string; incomeRefs: string[]; kind: "refund" | "reimbursement" | "mixed" } | null };
  applied?: boolean;
};
export type ReconciliationTotals = { incomeFen: number; expenseFen: number; netFen: number; transactionCount: number };
export type ReconciliationPreview = {
  before: ReconciliationTotals;
  after: ReconciliationTotals;
  delta: ReconciliationTotals;
  days: Array<{ key: string; delta: ReconciliationTotals }>;
  months: Array<{ key: string; delta: ReconciliationTotals }>;
};
export type BillReconciliationContent = {
  purpose: "reconciliation";
  version: 1;
  locale: Locale;
  range: { from: string; to: string };
  snapshotAt: string;
  records: ReconciliationRecord[];
  suggestions: ReconciliationSuggestion[];
  assertions: Record<string, ReconciliationSourceRow>;
};
export type BillReconciliationReportDto = BillAnalysisReportListItem & {
  purpose: "reconciliation";
  version: 1;
  records: ReconciliationRecord[];
  suggestions: ReconciliationSuggestion[];
  manualReview?: ReconciliationManualReview;
};
export type BillReconciliationSnapshot = {
  scope: BillAnalysisScope;
  locale: Locale;
  range: { from: string; to: string };
  snapshotAt: string;
  rows: ReconciliationSourceRow[];
};
type ReconciliationApplyBase = { requestId: string; reportId: string; generation: number; suggestionIds: string[] };
export type ReconciliationApplyInput = ReconciliationApplyBase & (
  { version?: undefined; manualGroups?: undefined } |
  { version: 2; manualGroups: ReconciliationManualGroup[] } |
  { version: 3; manualGroups: ReconciliationRetentionGroup[] }
);
export type ReconciliationApplyOutcome = {
  requestId: string;
  status: "success" | "error" | "unknown";
  error?: BillAnalysisErrorCode;
  reportId?: string;
  generation?: number;
  suggestionIds?: string[];
  affectedSuggestionIds?: string[];
  preview?: ReconciliationPreview;
  version?: 2 | 3;
  manualGroups?: ReconciliationManualSelectionGroup[];
};
export type ReconciliationApplicationDefinition = {
  inputHash: string | null;
  outcome: ReconciliationApplyOutcome;
  transactionIds?: string[];
  consumedIncomeIds?: string[];
} & (
  { version?: undefined; manualGroups?: undefined } |
  { version: 2; manualGroups: ReconciliationAppliedManualGroup[] } |
  { version: 3; manualGroups: ReconciliationAppliedRetentionGroup[] }
);
