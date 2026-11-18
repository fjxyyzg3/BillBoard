export type BillAnalysisAgentCall = { sequence: number; stage: "batch" | "summary" | "context" | "candidate"; batchId: string };
export type BillAnalysisAgentCalls = { count: number; calls: BillAnalysisAgentCall[] };

export async function readBillAnalysisAgentCalls(): Promise<BillAnalysisAgentCalls> {
  const url = new URL(process.env.IMPORT_AGENT_URL ?? "");
  const token = process.env.IMPORT_AGENT_TOKEN;
  if (url.protocol !== "http:" || !["127.0.0.1", "localhost"].includes(url.hostname) || url.username || url.password || !token) {
    throw new Error("Analysis observations require the authenticated loopback Agent fixture");
  }
  const response = await fetch(new URL("/_test/bill-analysis-calls", url), { headers: { Authorization: `Bearer ${token}` }, cache: "no-store", signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Could not read synthetic Agent observations");
  const result = await response.json() as BillAnalysisAgentCalls;
  if (!Number.isSafeInteger(result.count) || !Array.isArray(result.calls) || result.calls.some((call) => !Number.isSafeInteger(call.sequence) || !["batch", "summary", "context", "candidate"].includes(call.stage) || typeof call.batchId !== "string")) {
    throw new Error("Invalid synthetic Agent observation metadata");
  }
  return result;
}
