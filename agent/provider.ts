import type { BillAnalyzer, BillReconciler, ImportAgentClassifier, NaturalLanguageParser } from "./runtime";
import { createWheelMakerBillAnalyzer, createWheelMakerBillReconciler, createWheelMakerClassifier, createWheelMakerNaturalLanguageParser } from "./wheelmaker";

export interface AgentRuntimes {
  provider: "wheelmaker";
  classify: ImportAgentClassifier;
  parseExpenses: NaturalLanguageParser;
  analyzeBill: BillAnalyzer;
  reconcileBill: BillReconciler;
}

export function createAgentRuntimes(env: Partial<NodeJS.ProcessEnv> = process.env): AgentRuntimes {
  const options = {
    baseUrl: env.WHEELMAKER_BASE_URL ?? "",
    apiKey: env.WHEELMAKER_API_KEY ?? "",
    model: env.IMPORT_AGENT_MODEL?.trim() || "gpt-6-luna",
    reasoningEffort: env.IMPORT_AGENT_REASONING_EFFORT?.trim() || "high",
  };
  return {
    provider: "wheelmaker",
    classify: createWheelMakerClassifier(options),
    parseExpenses: createWheelMakerNaturalLanguageParser(options),
    analyzeBill: createWheelMakerBillAnalyzer({ ...options,
      model: env.BILL_ANALYSIS_AGENT_MODEL?.trim() || "gpt-6-astra",
      reasoningEffort: env.BILL_ANALYSIS_AGENT_REASONING_EFFORT?.trim() || "high",
    }),
    reconcileBill: createWheelMakerBillReconciler({ ...options,
      model: env.BILL_ANALYSIS_AGENT_MODEL?.trim() || "gpt-6-astra",
      reasoningEffort: env.BILL_ANALYSIS_AGENT_REASONING_EFFORT?.trim() || "high",
    }),
  };
}
