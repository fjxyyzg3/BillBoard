import { createHash } from "node:crypto";
import { getCategoryDisplayName, getMessages, type Locale } from "@/lib/i18n";
import type { BillAnalysisBody, BillAnalysisEvidence, BillAnalysisMetric, BillAnalysisScope } from "./bill-analysis-types";
import {
  BILL_ANALYSIS_SCHEMA_VERSION, MAX_BILL_ANALYSIS_BATCH_ROWS, MAX_BILL_ANALYSIS_BATCHES,
  MAX_BILL_ANALYSIS_BODY_BYTES, MAX_BILL_ANALYSIS_INPUT_BYTES, MAX_BILL_ANALYSIS_ROWS,
  MAX_BILL_ANALYSIS_SUMMARY_BYTES, billAnalysisBytes, billAnalysisReferencedEvidence,
  billAnalysisScopeSchema, validateBillAnalysisRequest, validateBillAnalysisResponse,
  type BillAnalysisAgentRequest, type BillAnalysisComparison,
} from "./bill-analysis-protocol";
import { EXPENSE_BUCKETS } from "./analytics";

export type BillAnalysisSourceRow = { id: string; ledgerId: string; actorMemberId: string; occurredAt: Date;
  type: "INCOME" | "EXPENSE"; amountFen: number; categoryId: string; categoryName: string; note: string | null };
export type BillAnalysisSourceSnapshot = { scope: BillAnalysisScope; locale: Locale; snapshotAt: string;
  range: { from: string; to: string }; current: BillAnalysisSourceRow[];
  previous: { range: { from: string; to: string }; rows: BillAnalysisSourceRow[] } | null;
  yearAgo: { range: { from: string; to: string }; rows: BillAnalysisSourceRow[] } | null;
  firstRecordedDate: string | null };
export type PreparedBillAnalysis = Pick<BillAnalysisSourceSnapshot, "scope" | "locale" | "range" | "snapshotAt"> & {
  inputHash: string; batches: Array<Extract<BillAnalysisAgentRequest, { stage: "batch" }>>;
  metrics: BillAnalysisMetric[]; evidence: BillAnalysisEvidence[];
  transactionRefs: Record<string, string>;
};

export class BillAnalysisPreparationError extends Error {
  constructor(readonly code: "INVALID" | "TOO_LARGE" | "NO_DATA") { super(code); }
}

function shanghaiDate(value: Date): string {
  if (!Number.isFinite(value.getTime())) throw new BillAnalysisPreparationError("INVALID");
  return new Date(value.getTime() + 8 * 60 * 60_000).toISOString().slice(0, 10);
}

function sum(values: number[]) {
  let result = 0;
  for (const value of values) {
    if (!Number.isSafeInteger(value) || value < 0) throw new BillAnalysisPreparationError("INVALID");
    result += value;
    if (!Number.isSafeInteger(result)) throw new BillAnalysisPreparationError("TOO_LARGE");
  }
  return result;
}

function periodMetrics(rows: BillAnalysisSourceRow[], period: string, locale: Locale, categoryAliases: Map<string, string>): BillAnalysisMetric[] {
  const labels = getMessages(locale).home.analytics;
  const periodLabel = period === "current" ? labels.current : period === "previous" ? labels.previous : labels.yearAgo;
  const make = (suffix: string, label: string, value: number, unit: BillAnalysisMetric["unit"] = "fen"): BillAnalysisMetric => ({
    ref: `${period}.${suffix}`, label: `${periodLabel} · ${label}`, value, unit,
  });
  const income = rows.filter(({ type }) => type === "INCOME"), expense = rows.filter(({ type }) => type === "EXPENSE");
  const incomeFen = sum(income.map(({ amountFen }) => amountFen)), expenseFen = sum(expense.map(({ amountFen }) => amountFen));
  const metrics = [make("incomeFen", labels.income, incomeFen), make("expenseFen", labels.expense, expenseFen), make("netFen", labels.net, incomeFen - expenseFen),
    make("incomeCount", `${labels.income} · ${labels.count}`, income.length, "count"),
    make("expenseCount", `${labels.expense} · ${labels.count}`, expense.length, "count"), make("transactionCount", labels.count, rows.length, "count")];
  const categories = new Map<string, BillAnalysisSourceRow[]>();
  for (const row of rows) {
    if (!Number.isSafeInteger(row.amountFen) || row.amountFen <= 0 || !["INCOME", "EXPENSE"].includes(row.type)) throw new BillAnalysisPreparationError("INVALID");
    const key = `${row.categoryId}:${row.type}`;
    const group = categories.get(key) ?? [];
    group.push(row); categories.set(key, group);
  }
  for (const group of categories.values()) {
    const first = group[0], alias = categoryAliases.get(first.categoryId)!;
    const direction = first.type === "INCOME" ? "income" : "expense";
    const label = `${getCategoryDisplayName(first.categoryName, locale)} · ${labels[direction]}`;
    metrics.push(make(`category.${alias}.${direction}Fen`, label, sum(group.map(({ amountFen }) => amountFen))),
      make(`category.${alias}.${direction}Count`, `${label} · ${labels.count}`, group.length, "count"));
  }
  return metrics;
}

function currentDetailMetrics(snapshot: BillAnalysisSourceSnapshot): BillAnalysisMetric[] {
  const labels = getMessages(snapshot.locale).home.analytics;
  const result: BillAnalysisMetric[] = [];
  const timeGroups = new Map<string, BillAnalysisSourceRow[]>();
  for (const row of snapshot.current) {
    const day = shanghaiDate(row.occurredAt);
    const key = snapshot.scope.mode === "year" ? day.slice(0, 7) : day;
    const rows = timeGroups.get(key) ?? [];
    rows.push(row); timeGroups.set(key, rows);
  }
  for (const [date, rows] of [...timeGroups].sort(([left], [right]) => left.localeCompare(right))) {
    for (const [direction, type] of [["income", "INCOME"], ["expense", "EXPENSE"]] as const) {
      const matching = rows.filter((row) => row.type === type);
      result.push({ ref: `current.time.${date}.${direction}Fen`, label: `${date} · ${labels[direction]}`, value: sum(matching.map(({ amountFen }) => amountFen)), unit: "fen" });
    }
  }
  const expenses = snapshot.current.filter(({ type }) => type === "EXPENSE").map(({ amountFen }) => amountFen).sort((left, right) => left - right);
  for (const bucket of EXPENSE_BUCKETS) {
    const amounts = expenses.filter((amount) => amount >= bucket.minFen && (bucket.maxFen === null || amount <= bucket.maxFen));
    result.push({ ref: `current.bucket.${bucket.key}.expenseFen`, label: `${labels.buckets[bucket.key]} · ${labels.expense}`, value: sum(amounts), unit: "fen" },
      { ref: `current.bucket.${bucket.key}.expenseCount`, label: `${labels.buckets[bucket.key]} · ${labels.count}`, value: amounts.length, unit: "count" });
  }
  if (expenses.length) {
    const median = expenses.length % 2 ? expenses[(expenses.length - 1) / 2] : expenses[expenses.length / 2 - 1] / 2 + expenses[expenses.length / 2] / 2;
    result.push({ ref: "current.maximumFen", label: labels.maximum, value: expenses[expenses.length - 1], unit: "fen" },
      { ref: "current.medianFen", label: labels.median, value: Math.round(median), unit: "fen" },
      { ref: "current.topFiveShare", label: labels.topFive, value: sum(expenses.slice(-5)) / sum(expenses), unit: "ratio" });
  }
  return result;
}

export function prepareBillAnalysis(snapshot: BillAnalysisSourceSnapshot): PreparedBillAnalysis {
  if (!billAnalysisScopeSchema.safeParse(snapshot.scope).success || !["zh-CN", "en-US"].includes(snapshot.locale)) throw new BillAnalysisPreparationError("INVALID");
  if (!snapshot.current.length) throw new BillAnalysisPreparationError("NO_DATA");
  if (snapshot.current.length > MAX_BILL_ANALYSIS_ROWS) throw new BillAnalysisPreparationError("TOO_LARGE");
  const current = [...snapshot.current].sort((left, right) => left.occurredAt.getTime() - right.occurredAt.getTime() || left.id.localeCompare(right.id));
  if (new Set(current.map(({ id }) => id)).size !== current.length) throw new BillAnalysisPreparationError("INVALID");
  const allRows = [...current, ...snapshot.previous?.rows ?? [], ...snapshot.yearAgo?.rows ?? []];
  const aliases = (values: string[], prefix: string) => new Map([...new Set(values)].sort().map((id, index) => [id, `${prefix}${index + 1}`]));
  const memberAliases = aliases(current.map(({ actorMemberId }) => actorMemberId), "m");
  const ledgerAliases = aliases(current.map(({ ledgerId }) => ledgerId), "l");
  const categoryAliases = aliases(allRows.map(({ categoryId }) => categoryId), "c");
  const rows = current.map((row, index) => ({ ref: `r${index + 1}`, date: shanghaiDate(row.occurredAt),
    type: row.type === "INCOME" ? "income" as const : "expense" as const, amountFen: row.amountFen,
    categoryName: getCategoryDisplayName(row.categoryName, snapshot.locale), memberAlias: memberAliases.get(row.actorMemberId)!,
    ledgerAlias: ledgerAliases.get(row.ledgerId)!, note: row.note,
  }));
  const metrics = [...periodMetrics(current, "current", snapshot.locale, categoryAliases), ...currentDetailMetrics(snapshot)];
  const comparisons: BillAnalysisComparison[] = [];
  const labels = getMessages(snapshot.locale).home.analytics;
  const limitations: string[] = [labels.recordedOnly];
  for (const period of ["previous", "yearAgo"] as const) {
    const comparison = snapshot[period];
    if (!comparison) continue;
    const available = comparison.rows.length === 0 ? "missing"
      : snapshot.firstRecordedDate !== null && snapshot.firstRecordedDate > comparison.range.from ? "partial" : "available";
    const comparisonMetrics = periodMetrics(comparison.rows, period, snapshot.locale, categoryAliases);
    if (available === "missing") limitations.push(`${period === "previous" ? labels.previous : labels.yearAgo} · ${labels.noBaseline}`);
    if (available === "partial") limitations.push(`${period === "previous" ? labels.previous : labels.yearAgo} · ${labels.partialBaseline}`);
    if (available !== "missing") {
      for (const direction of ["income", "expense", "net"] as const) {
        const value = metrics.find(({ ref }) => ref === `current.${direction}Fen`)!.value;
        const baseline = comparisonMetrics.find(({ ref }) => ref === `${period}.${direction}Fen`)!.value;
        comparisonMetrics.push({ ref: `${period}.${direction}ChangeFen`, label: `${period === "previous" ? labels.previous : labels.yearAgo} · ${labels[direction]} · ${labels.delta}`, value: value - baseline, unit: "fen" });
        if (available === "available" && baseline > 0) comparisonMetrics.push({ ref: `${period}.${direction}ChangeRatio`, label: `${period === "previous" ? labels.previous : labels.yearAgo} · ${labels[direction]} · ${labels.delta}`, value: (value - baseline) / baseline, unit: "ratio" });
      }
    }
    comparisons.push({ period, range: comparison.range, availability: available, metrics: comparisonMetrics });
  }
  if (billAnalysisBytes({ metrics, comparisons, limitations }) > MAX_BILL_ANALYSIS_SUMMARY_BYTES) throw new BillAnalysisPreparationError("TOO_LARGE");
  const base = { schemaVersion: BILL_ANALYSIS_SCHEMA_VERSION, locale: snapshot.locale, range: snapshot.range,
    snapshotAt: snapshot.snapshotAt, metrics, comparisons, limitations };
  const modelInput = JSON.stringify({ ...base, rows });
  if (Buffer.byteLength(modelInput, "utf8") > MAX_BILL_ANALYSIS_INPUT_BYTES) throw new BillAnalysisPreparationError("TOO_LARGE");
  const chunks: typeof rows[] = [];
  let chunk: typeof rows = [], chunkBytes = 0;
  const envelopeBytes = billAnalysisBytes({ ...base, stage: "batch", batchId: "b24", batchCount: MAX_BILL_ANALYSIS_BATCHES, rows: [] });
  for (const row of rows) {
    const rowBytes = billAnalysisBytes(row);
    if (envelopeBytes + rowBytes > MAX_BILL_ANALYSIS_BODY_BYTES) throw new BillAnalysisPreparationError("TOO_LARGE");
    if (chunk.length && (chunk.length >= MAX_BILL_ANALYSIS_BATCH_ROWS || envelopeBytes + chunkBytes + rowBytes + chunk.length > MAX_BILL_ANALYSIS_BODY_BYTES)) {
      chunks.push(chunk); chunk = []; chunkBytes = 0;
    }
    chunk.push(row); chunkBytes += rowBytes;
  }
  if (chunk.length) chunks.push(chunk);
  if (chunks.length > MAX_BILL_ANALYSIS_BATCHES) throw new BillAnalysisPreparationError("TOO_LARGE");
  const batches = chunks.map((chunk, index) => {
    const request = validateBillAnalysisRequest({ ...base, stage: "batch", batchId: `b${index + 1}`, batchCount: chunks.length, rows: chunk });
    if (request.stage !== "batch") throw new BillAnalysisPreparationError("INVALID");
    return request;
  });
  return { scope: snapshot.scope, locale: snapshot.locale, range: snapshot.range, snapshotAt: snapshot.snapshotAt,
    inputHash: createHash("sha256").update(modelInput).digest("hex"), batches,
    metrics: [...metrics, ...comparisons.flatMap(({ metrics }) => metrics)], evidence: rows.map(({ note: _note, ...row }) => row),
    transactionRefs: Object.fromEntries(current.map(({ id }, index) => [`r${index + 1}`, id])) };
}

export function buildBillAnalysisSummary(prepared: PreparedBillAnalysis, batchResults: BillAnalysisBody[]): BillAnalysisAgentRequest {
  if (!prepared.batches.length || batchResults.length !== prepared.batches.length) throw new BillAnalysisPreparationError("INVALID");
  const findings = prepared.batches.map((batch, index) => ({ batchId: batch.batchId,
    body: validateBillAnalysisResponse(batch, { schemaVersion: BILL_ANALYSIS_SCHEMA_VERSION, batchId: batch.batchId, body: batchResults[index] }),
  }));
  const refs = new Set(findings.flatMap(({ body }) => billAnalysisReferencedEvidence(body, prepared.evidence).map(({ ref }) => ref)));
  const first = prepared.batches[0];
  const request = { schemaVersion: BILL_ANALYSIS_SCHEMA_VERSION, stage: "summary", batchId: "summary", batchCount: prepared.batches.length,
    locale: prepared.locale, range: prepared.range, snapshotAt: prepared.snapshotAt, metrics: first.metrics,
    comparisons: first.comparisons, limitations: first.limitations, findings, evidence: prepared.evidence.filter(({ ref }) => refs.has(ref)) };
  if (billAnalysisBytes(request) > MAX_BILL_ANALYSIS_BODY_BYTES) throw new BillAnalysisPreparationError("TOO_LARGE");
  return validateBillAnalysisRequest(request);
}
