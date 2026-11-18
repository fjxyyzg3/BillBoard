import { z } from "zod";
import type { BillAnalysisBody, BillAnalysisEvidence } from "./bill-analysis-types";

export const BILL_ANALYSIS_SCHEMA_VERSION = "bill-analysis.v1";
export const MAX_BILL_ANALYSIS_ROWS = 10_000;
export const MAX_BILL_ANALYSIS_INPUT_BYTES = 8 * 1024 * 1024;
export const MAX_BILL_ANALYSIS_BATCH_ROWS = 500;
export const MAX_BILL_ANALYSIS_BATCHES = 24;
export const MAX_BILL_ANALYSIS_BODY_BYTES = 256 * 1024;
export const MAX_BILL_ANALYSIS_SUMMARY_BYTES = 64 * 1024;
export const MAX_BILL_ANALYSIS_BATCH_RESULT_BYTES = 4 * 1024;
export const MAX_BILL_ANALYSIS_RESULT_BYTES = 64 * 1024;
export const BILL_ANALYSIS_BATCH_TIMEOUT_MS = 90_000;
export const BILL_ANALYSIS_SUMMARY_TIMEOUT_MS = 120_000;
export const BILL_ANALYSIS_TOTAL_TIMEOUT_MS = 8 * 60_000;
export const BILL_ANALYSIS_LEASE_MS = 9 * 60_000;

const reference = z.string().regex(/^[A-Za-z][A-Za-z0-9_.:-]{0,99}$/);
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine((value) => {
  const parsed = new Date(`${value}T00:00:00Z`);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString().slice(0, 10) === value;
});
export const billAnalysisRangeSchema = z.object({ from: date, to: date }).strict().refine((range) => range.from <= range.to);
export const billAnalysisScopeSchema = z.object({
  mode: z.enum(["month", "year"]), period: z.string(),
  ledgerId: z.string().min(1).max(128).nullable(), actorMemberId: z.string().min(1).max(128).nullable(),
}).strict().refine((scope) => scope.mode === "month"
  ? /^\d{4}-(0[1-9]|1[0-2])$/.test(scope.period) && Number(scope.period.slice(0, 4)) > 0
  : /^\d{4}$/.test(scope.period) && Number(scope.period) > 0);
export const billAnalysisMetricSchema = z.object({ ref: reference, label: z.string().min(1).max(400),
  value: z.number().finite().min(-Number.MAX_SAFE_INTEGER).max(Number.MAX_SAFE_INTEGER), unit: z.enum(["fen", "count", "ratio"]),
}).strict().refine((item) => item.unit === "ratio" || (Number.isSafeInteger(item.value) && (item.unit !== "count" || item.value >= 0)));
const evidence = z.object({ ref: z.string().regex(/^r[1-9]\d{0,4}$/), date, type: z.enum(["income", "expense"]),
  amountFen: z.number().int().positive().max(Number.MAX_SAFE_INTEGER), categoryName: z.string().min(1).max(400),
  memberAlias: z.string().regex(/^m[1-9]\d{0,4}$/), ledgerAlias: z.string().regex(/^l[1-9]\d{0,4}$/),
}).strict();
const finding = z.object({ title: z.string().min(1).max(160), detail: z.string().min(1).max(1800),
  evidenceRefs: z.array(reference).min(1).max(8).refine((refs) => new Set(refs).size === refs.length),
}).strict();
export const billAnalysisBodySchema = z.object({ overview: z.string().min(1).max(4000),
  observations: z.array(finding).max(8), recommendations: z.array(finding).max(5),
  limitations: z.array(z.string().min(1).max(1000)).max(12),
}).strict();
const comparison = z.object({ period: z.enum(["previous", "yearAgo"]), range: billAnalysisRangeSchema,
  availability: z.enum(["available", "partial", "missing"]), metrics: z.array(billAnalysisMetricSchema).max(4096),
}).strict();
const common = {
  schemaVersion: z.literal(BILL_ANALYSIS_SCHEMA_VERSION), locale: z.enum(["zh-CN", "en-US"]),
  range: billAnalysisRangeSchema, snapshotAt: z.iso.datetime(), metrics: z.array(billAnalysisMetricSchema).min(1).max(4096),
  comparisons: z.array(comparison).max(2), limitations: z.array(z.string().min(1).max(1000)).max(12),
  batchCount: z.number().int().min(1).max(MAX_BILL_ANALYSIS_BATCHES),
};
const requestSchema = z.discriminatedUnion("stage", [
  z.object({ ...common, stage: z.literal("batch"), batchId: z.string().regex(/^b[1-9]\d?$/),
    rows: z.array(evidence.extend({ note: z.string().nullable() }).strict()).min(1).max(MAX_BILL_ANALYSIS_BATCH_ROWS),
  }).strict(),
  z.object({ ...common, stage: z.literal("summary"), batchId: z.literal("summary"),
    findings: z.array(z.object({ batchId: z.string().regex(/^b[1-9]\d?$/), body: billAnalysisBodySchema }).strict()).min(1).max(MAX_BILL_ANALYSIS_BATCHES),
    evidence: z.array(evidence).max(MAX_BILL_ANALYSIS_ROWS),
  }).strict(),
]);
export type BillAnalysisAgentRequest = z.infer<typeof requestSchema>;
export type BillAnalysisAgentResponse = { schemaVersion: typeof BILL_ANALYSIS_SCHEMA_VERSION; batchId: string; body: BillAnalysisBody };
export type BillAnalysisComparison = z.infer<typeof comparison>;

export function billAnalysisBytes(value: unknown): number {
  return Buffer.byteLength(JSON.stringify(value), "utf8");
}

function references(request: BillAnalysisAgentRequest) {
  return new Set([
    ...request.metrics.map(({ ref }) => ref), ...request.comparisons.flatMap(({ metrics }) => metrics.map(({ ref }) => ref)),
    ...(request.stage === "batch" ? request.rows : request.evidence).map(({ ref }) => ref),
  ]);
}

export function billAnalysisReferencedEvidence(body: BillAnalysisBody, rows: BillAnalysisEvidence[]) {
  const refs = new Set([...body.observations, ...body.recommendations].flatMap(({ evidenceRefs }) => evidenceRefs));
  return rows.filter(({ ref }) => refs.has(ref));
}

export function validateBillAnalysisRequest(input: unknown): BillAnalysisAgentRequest {
  try {
    if (billAnalysisBytes(input) > MAX_BILL_ANALYSIS_BODY_BYTES) throw new Error();
    const result = requestSchema.parse(input);
    const metrics = [...result.metrics, ...result.comparisons.flatMap(({ metrics }) => metrics)];
    if (new Set(metrics.map(({ ref }) => ref)).size !== metrics.length
      || new Set(result.comparisons.map(({ period }) => period)).size !== result.comparisons.length) throw new Error();
    const rows = result.stage === "batch" ? result.rows : result.evidence;
    if (new Set(rows.map(({ ref }) => ref)).size !== rows.length || rows.some(({ date }) => date < result.range.from || date > result.range.to)) throw new Error();
    if (result.stage === "batch") {
      if (Number(result.batchId.slice(1)) > result.batchCount) throw new Error();
    } else {
      if (result.findings.length !== result.batchCount || result.findings.some((item, index) => item.batchId !== `b${index + 1}`)) throw new Error();
      const allowed = references(result);
      for (const item of result.findings) {
        if (billAnalysisBytes(item.body) > MAX_BILL_ANALYSIS_BATCH_RESULT_BYTES) throw new Error();
        if ([...item.body.observations, ...item.body.recommendations].some((finding) => finding.evidenceRefs.some((ref) => !allowed.has(ref)))) throw new Error();
      }
    }
    return result;
  } catch { throw new Error("Invalid bill analysis request"); }
}

export function validateBillAnalysisResponse(request: BillAnalysisAgentRequest, value: unknown): BillAnalysisBody {
  try {
    const result = z.object({ schemaVersion: z.literal(BILL_ANALYSIS_SCHEMA_VERSION),
      batchId: z.literal(request.batchId), body: billAnalysisBodySchema,
    }).strict().parse(value);
    if (billAnalysisBytes(result.body) > (request.stage === "batch" ? MAX_BILL_ANALYSIS_BATCH_RESULT_BYTES : MAX_BILL_ANALYSIS_RESULT_BYTES)) throw new Error();
    const allowed = references(request);
    if ([...result.body.observations, ...result.body.recommendations].some((finding) => finding.evidenceRefs.some((ref) => !allowed.has(ref)))) throw new Error();
    return result.body;
  } catch { throw new Error("Invalid bill analysis response"); }
}
