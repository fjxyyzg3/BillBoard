import type { Locale } from "@/lib/i18n";
import type { BillReconciliationReportDto } from "./bill-reconciliation-types";

export const BILL_ANALYSIS_VERSION = 1;

export type BillAnalysisScope = {
  mode: "month" | "year";
  period: string;
  ledgerId: string | null;
  actorMemberId: string | null;
};

export type BillAnalysisMetric = {
  ref: string;
  label: string;
  value: number;
  unit: "fen" | "count" | "ratio";
};

export type BillAnalysisEvidence = {
  ref: string;
  date: string;
  type: "income" | "expense";
  amountFen: number;
  categoryName: string;
  memberAlias: string;
  ledgerAlias: string;
};

export type BillAnalysisFinding = { title: string; detail: string; evidenceRefs: string[] };
export type BillAnalysisBody = {
  overview: string;
  observations: BillAnalysisFinding[];
  recommendations: BillAnalysisFinding[];
  limitations: string[];
};

export type BillAnalysisReportListItem = {
  purpose?: "analysis" | "reconciliation";
  id: string;
  scope: BillAnalysisScope;
  scopeLabels: { ledger: string; member: string };
  locale: Locale;
  generatedAt: string;
  snapshotAt: string;
  range: { from: string; to: string };
  generation: number;
};

export type BillAnalysisReportDto = BillAnalysisReportListItem & {
  purpose?: "analysis";
  body: BillAnalysisBody;
  metrics: BillAnalysisMetric[];
  evidence: BillAnalysisEvidence[];
};

export type AnyBillReportDto = BillAnalysisReportDto | BillReconciliationReportDto;

export type BillAnalysisErrorCode =
  | "INVALID" | "CONSENT_REQUIRED" | "BUSY" | "TOO_LARGE" | "NO_DATA"
  | "NOT_ACCEPTED" | "CONFLICT" | "UNAUTHORIZED" | "ENCRYPTION_CHANGED"
  | "TIMEOUT" | "CANCELLED" | "INTERRUPTED" | "INVALID_RESPONSE" | "UNAVAILABLE";

export type BillAnalysisOutcome = {
  requestId: string;
  status: "processing" | "stopping" | "unknown" | "error" | "success";
  error?: BillAnalysisErrorCode;
  reportId?: string;
  generation?: number;
  superseded?: boolean;
  phase?: BillAnalysisPhase;
  completedBatches?: number;
  totalBatches?: number;
};

export type BillAnalysisPhase = "preparing" | "analyzing" | "waiting" | "summarizing" | "saving";
export type BillAnalysisProgress = { phase: BillAnalysisPhase; completedBatches: number; totalBatches: number };

export type BillAnalysisTaskDto = {
  id: string;
  status: "processing" | "stopping" | "error" | "success";
  phase: BillAnalysisPhase | null;
  completedBatches: number;
  totalBatches: number;
  error?: BillAnalysisErrorCode;
  startedAt: string;
  updatedAt: string;
  canCancel: boolean;
  requestId?: string;
};

export type BillAnalysisEntryDto = {
  purpose?: "analysis" | "reconciliation";
  id: string;
  scope: BillAnalysisScope;
  scopeLabels: { ledger: string; member: string };
  updatedAt: string;
  report: BillAnalysisReportListItem | null;
  task: BillAnalysisTaskDto | null;
};

export type BillAnalysisEntriesDto = { entries: BillAnalysisEntryDto[]; cursor: string | null; active: BillAnalysisEntryDto | null };

export type BillAnalysisEvent =
  | { type: "progress"; requestId: string; phase: BillAnalysisPhase; completedBatches?: number; totalBatches?: number }
  | { type: "result"; result: BillAnalysisOutcome }
  | { type: "heartbeat" };
