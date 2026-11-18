import type { ImportAgentRequest, ImportAgentResponse } from "../src/lib/imports/agent-protocol";
import type { NaturalLanguageRequest, NaturalLanguageResponse } from "../src/lib/transactions/natural-language-protocol";
import type { BillAnalysisAgentRequest } from "../src/lib/reports/bill-analysis-protocol";
import type { BillAnalysisBody } from "../src/lib/reports/bill-analysis-types";
import type { BillReconciliationAgentRequest, BillReconciliationAgentResponse } from "../src/lib/reports/bill-reconciliation-protocol";

export type AgentRuntimeErrorCode = "authentication_required" | "timeout" | "cancelled" | "invalid_response" | "unavailable";

export class AgentRuntimeError extends Error {
  constructor(readonly code: AgentRuntimeErrorCode) {
    super(code);
    this.name = "AgentRuntimeError";
  }
}

export type ImportAgentClassifier = (request: ImportAgentRequest, signal?: AbortSignal) => Promise<ImportAgentResponse>;
export type NaturalLanguageParser = (request: NaturalLanguageRequest, signal?: AbortSignal) => Promise<NaturalLanguageResponse>;
export type BillAnalyzer = (request: BillAnalysisAgentRequest, signal?: AbortSignal) => Promise<BillAnalysisBody>;
export type BillReconciler = (request: BillReconciliationAgentRequest, signal?: AbortSignal) => Promise<BillReconciliationAgentResponse>;
