import { randomBytes } from "node:crypto";
import { createServer } from "node:http";
import {
  IMPORT_AGENT_SCHEMA_VERSION,
  validateAgentRequest,
  type ImportAgentResponse,
} from "../../src/lib/imports/agent-protocol";
import { getCurrentShanghaiDateTimeLocal, parseShanghaiDateTimeLocal } from "../../src/lib/transactions/datetime";
import {
  NATURAL_LANGUAGE_SCHEMA_VERSION,
  validateNaturalLanguageRequest,
  validateNaturalLanguageResponse,
  type NaturalLanguageIssue,
  type NaturalLanguageRequest,
  type NaturalLanguageResponse,
} from "../../src/lib/transactions/natural-language-protocol";
import {
  BILL_ANALYSIS_SCHEMA_VERSION, validateBillAnalysisRequest, validateBillAnalysisResponse,
  type BillAnalysisAgentRequest, type BillAnalysisAgentResponse,
} from "../../src/lib/reports/bill-analysis-protocol";
import type { BillAnalysisAgentCall } from "./bill-analysis-agent-observer";
import { BILL_RECONCILIATION_SCHEMA_VERSION, validateBillReconciliationRequest, validateBillReconciliationResponse,
  type BillReconciliationAgentRequest, type BillReconciliationAgentResponse } from "../../src/lib/reports/bill-reconciliation-protocol";

function syntheticReconciliation(input: BillReconciliationAgentRequest): BillReconciliationAgentResponse {
  const byPayment = new Map<string, typeof input.rows>();
  const byManualReview = new Map<string, typeof input.rows>();
  for (const row of input.rows) {
    const key = /payment\s+id\s*[:#]?\s*([a-z0-9-]+)/i.exec(row.note ?? "")?.[1]?.toLowerCase();
    if (key) byPayment.set(key, [...byPayment.get(key) ?? [], row]);
    const manualKey = /manual review id\s*[:#]?\s*([a-z0-9-]+)/i.exec(row.note ?? "")?.[1]?.toLowerCase();
    if (manualKey) byManualReview.set(manualKey, [...byManualReview.get(manualKey) ?? [], row]);
  }
  const groups: BillReconciliationAgentResponse["groups"] = [];
  for (const [key, rows] of byManualReview) {
    if (rows.length < 2) continue;
    groups.push({ kind: "notice", title: input.locale === "zh-CN" ? "相邻日期的跨来源支出待核对" : "Review adjacent cross-source expenses",
      reason: input.locale === "zh-CN" ? `以下记录包含同金额、同方向的跨来源线索。时间精度未知，描述相似不足以证明同笔支付，请人工核对。Manual review id ${key}` : `These records include possible equal-amount links across sources. Original time precision is unknown. Confirm the actual transactions manually. Manual review id ${key}`,
      confidence: "review", evidenceRefs: rows.map((row) => row.ref), duplicateGroups: [], offset: null });
  }
  for (const [key, rows] of byPayment) {
    if (rows.length < 2) continue;
    const duplicateKeys = new Map<string, string[]>();
    for (const row of rows) {
      const groupKey = `${row.type}:${row.amountFen}`;
      duplicateKeys.set(groupKey, [...duplicateKeys.get(groupKey) ?? [], row.ref]);
    }
    const duplicateGroups = [...duplicateKeys.values()].filter((refs) => refs.length > 1);
    const expenses = rows.filter((row) => row.type === "expense"), incomes = rows.filter((row) => row.type === "income");
    const incomeKinds = new Set(incomes.map((row) => /reimburse|报销/i.test(row.note ?? "") ? "reimbursement" : "refund"));
    const offset = expenses.length && incomes.length ? { expenseRef: expenses[0].ref, incomeRefs: incomes.map((row) => row.ref), kind: incomeKinds.size > 1 ? "mixed" as const : incomeKinds.has("reimbursement") ? "reimbursement" as const : "refund" as const } : null;
    if (!duplicateGroups.length && !offset) continue;
    const used = new Set([...duplicateGroups.flat(), ...offset ? [offset.expenseRef, ...offset.incomeRefs] : []]);
    groups.push({ kind: offset ? duplicateGroups.length ? "combined" : offset.kind === "reimbursement" ? "reimbursement" : "refund" : "duplicate",
      title: input.locale === "zh-CN" ? "核对关联账目" : "Reconcile related entries",
      reason: `Payment id ${key}`, confidence: "high", evidenceRefs: rows.filter((row) => used.has(row.ref)).map((row) => row.ref), duplicateGroups, offset });
  }
  return validateBillReconciliationResponse(input, { schemaVersion: BILL_RECONCILIATION_SCHEMA_VERSION, batchId: input.batchId, groups });
}

function syntheticAnalysis(input: BillAnalysisAgentRequest): BillAnalysisAgentResponse {
  const ref = input.metrics.find((metric) => metric.ref === "current.expenseFen")?.ref ?? input.metrics[0].ref;
  const rows = input.stage === "batch" ? input.rows : input.evidence;
  const row = rows.find((candidate) => candidate.type === "expense") ?? rows[0];
  const evidenceRefs = [ref, ...(row ? [row.ref] : [])];
  const chinese = input.locale === "zh-CN";
  const result: BillAnalysisAgentResponse = {
    schemaVersion: BILL_ANALYSIS_SCHEMA_VERSION, batchId: input.batchId,
    body: {
      overview: chinese ? "已根据本期账目与比较摘要完成收支复盘。" : "This review is based on the period’s recorded transactions and comparison statistics.",
      observations: [{ title: chinese ? "核对本期已记录支出" : "Review recorded spending",
        detail: chinese ? "结合分类与单笔记录，核对本期支出的用途。" : "Check the purpose of recorded expenses against their categories and transaction evidence.", evidenceRefs }],
      recommendations: [{ title: chinese ? "结合家庭需要复盘" : "Review against household needs",
        detail: chinese ? "先核对账目是否完整，再按家庭需要考虑可调整的消费。" : "Check whether entries are complete before deciding which spending fits household needs.", evidenceRefs }],
      limitations: [...input.limitations.slice(0, 10), chinese ? "只根据当前选择范围的已记录账目分析。" : "Only recorded transactions in the selected scope were analyzed."],
    },
  };
  validateBillAnalysisResponse(input, result);
  return result;
}

function parseSyntheticTransactions(input: NaturalLanguageRequest): NaturalLanguageResponse {
  const transactions: Extract<NaturalLanguageResponse, { outcome: "success" }>["transactions"] = [];
  const issues: NaturalLanguageIssue[] = [];
  for (const fragment of input.text.matchAll(/[^，,；;\n]+/g)) {
    const text = fragment[0].trim();
    const start = fragment.index + fragment[0].indexOf(text);
    const end = start + text.length;
    const amount = /(?:[¥￥]\s*)?(\d+)(?:\.(\d{1,2}))?\s*(?:元|CNY|RMB)?/i.exec(text);
    const incomeKind = [
      { name: "Salary", pattern: /工资|薪水|salary/i, zhNote: "工资", enNote: "Salary" },
      { name: "Bonus", pattern: /奖金|bonus/i, zhNote: "奖金", enNote: "Bonus" },
      { name: "Reimbursement", pattern: /报销|reimbursement/i, zhNote: "报销", enNote: "Reimbursement" },
      { name: "Refund", pattern: /退款|refund/i, zhNote: "退款", enNote: "Refund" },
      { name: "Investment", pattern: /投资|investment/i, zhNote: "投资", enNote: "Investment" },
      { name: "Other", pattern: /收入|income/i, zhNote: "其他收入", enNote: "Other income" },
    ].find(({ pattern }) => pattern.test(text));
    if (/美元|USD|EUR|外币|修改|删除|delete|edit/i.test(text) || (!incomeKind && /转账|transfer/i.test(text))) {
      issues.push({ code: "unsupported_transaction", start, end });
      continue;
    }
    if (!amount) {
      issues.push({ code: "missing_amount", start, end });
      continue;
    }
    const transport = /打车|交通|taxi/i.test(text);
    if (!incomeKind && !transport && !/午饭|lunch/i.test(text)) {
      issues.push({ code: "unclear_expense", start, end });
      continue;
    }
    const type = incomeKind ? "INCOME" : "EXPENSE";
    const category = input.categories.find(({ name, type: categoryType }) =>
      categoryType === type && name === (incomeKind?.name ?? (transport ? "Transport" : "Dining")),
    );
    if (!category) throw new Error("Synthetic transaction category is unavailable");
    const namedPayer = input.members.find(({ displayName }) =>
      text.includes(`${displayName}付了`) || text.includes(`${displayName}付款`),
    );
    const otherPayer = /老婆(?:付了|付款|支付)|wife paid/i.test(text)
      ? input.members.find(({ id }) => id !== input.currentMemberId) : undefined;
    const namedRecipient = input.members.find(({ displayName }) =>
      text.includes(`${displayName}收到`) || text.includes(`${displayName}获得`),
    );
    const otherRecipient = /老婆(?:昨天|今天)?(?:收到|获得)|wife received/i.test(text)
      ? input.members.find(({ id }) => id !== input.currentMemberId) : undefined;
    const memberId = incomeKind
      ? namedRecipient?.id ?? otherRecipient?.id ?? input.currentMemberId
      : namedPayer?.id ?? otherPayer?.id ?? input.currentMemberId;
    let occurredAt: string | null = null;
    if (/昨天|yesterday/i.test(text)) {
      const previousDay = new Date(parseShanghaiDateTimeLocal(input.referenceDateTime).getTime() - 24 * 60 * 60 * 1000);
      occurredAt = `${getCurrentShanghaiDateTimeLocal(previousDay).split("T")[0]}T00:00`;
    } else if (/今天|today/i.test(text)) {
      occurredAt = `${input.referenceDateTime.split("T")[0]}T00:00`;
    }
    transactions.push({
      start, end, type, amountFen: Number(amount[1]) * 100 + Number((amount[2] ?? "").padEnd(2, "0")),
      occurredAt, memberId, categoryId: category.id,
      note: incomeKind ? (/[a-z]/i.test(text) ? incomeKind.enNote : incomeKind.zhNote)
        : transport ? (/taxi/i.test(text) ? "taxi" : "打车") : (/lunch/i.test(text) ? "Lunch" : "午饭"),
    });
  }
  return validateNaturalLanguageResponse(input, issues.length ? {
    schemaVersion: NATURAL_LANGUAGE_SCHEMA_VERSION, outcome: "needs_correction", issues,
  } : {
    schemaVersion: NATURAL_LANGUAGE_SCHEMA_VERSION, outcome: "success", transactions,
  });
}

export async function startAgentFixture() {
  const token = randomBytes(32).toString("hex");
  const failures = new Set<string>();
  const analyses = new Map<string, { fail: boolean; delayed: boolean }>();
  const analysisCalls: BillAnalysisAgentCall[] = [];
  let analysisCallCount = 0;
  const server = createServer(async (request, response) => {
    if (request.method === "GET" && request.url === "/_test/bill-analysis-calls" && request.headers.authorization === `Bearer ${token}`) {
      response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ count: analysisCallCount, calls: analysisCalls }));
      return;
    }
    if (request.method !== "POST" || !["/suggest", "/parse-expenses", "/analyze-bill", "/reconcile-bill"].includes(request.url ?? "") || request.headers.authorization !== `Bearer ${token}`) {
      response.writeHead(401).end();
      return;
    }

    try {
      const chunks: Buffer[] = [];
      for await (const chunk of request) chunks.push(Buffer.from(chunk));
      const body: unknown = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      if (request.url === "/reconcile-bill") {
        const input = validateBillReconciliationRequest(body);
        analysisCalls.push({ sequence: ++analysisCallCount, stage: input.stage, batchId: input.batchId });
        if (analysisCalls.length > 4096) analysisCalls.shift();
        const failed = input.rows.some((row) => /__analysis_fail__|__reconcile_fail__/.test(row.note ?? ""));
        if (input.rows.some((row) => /__analysis_delayed__|__reconcile_delayed__/.test(row.note ?? ""))) {
          await new Promise<void>((resolve) => {
            const done = () => { clearTimeout(timer); response.off("close", done); resolve(); };
            const timer = setTimeout(done, 4000);
            response.once("close", done);
          });
        }
        if (response.destroyed) return;
        if (failed) { response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unavailable" })); return; }
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(syntheticReconciliation(input)));
        return;
      }
      if (request.url === "/analyze-bill") {
        const input = validateBillAnalysisRequest(body);
        analysisCalls.push({ sequence: ++analysisCallCount, stage: input.stage, batchId: input.batchId });
        if (analysisCalls.length > 4096) analysisCalls.shift();
        const key = JSON.stringify([input.snapshotAt, input.range, input.locale, input.batchCount]);
        const flags = analyses.get(key) ?? { fail: false, delayed: false };
        if (input.stage === "batch") {
          flags.fail ||= input.rows.some((row) => row.note?.includes("__analysis_fail__"));
          flags.delayed ||= input.rows.some((row) => row.note?.includes("__analysis_delayed__"));
          analyses.set(key, flags);
        }
        // Markers belong only to this synthetic fixture, never to the production model runtime.
        if (flags.delayed) {
          await new Promise<void>((resolve) => {
            const done = () => { clearTimeout(timer); response.off("close", done); resolve(); };
            const timer = setTimeout(done, input.stage === "batch" ? 4000 : 2000);
            response.once("close", done);
          });
        }
        if (response.destroyed) return;
        if (input.stage === "summary") analyses.delete(key);
        if (flags.fail && input.stage === "summary") {
          response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unavailable" }));
          return;
        }
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(syntheticAnalysis(input)));
        return;
      }
      if (request.url === "/parse-expenses") {
        const input = validateNaturalLanguageRequest(body);
        if (input.text.includes("__agent_fail__")) {
          response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unavailable" }));
          return;
        }
        if (input.text.includes("__agent_delayed__")) {
          await new Promise((resolve) => setTimeout(resolve, 1500));
        }
        response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(parseSyntheticTransactions(input)));
        return;
      }
      const input = validateAgentRequest(body);
      const labels = input.groups.map((group) => `${group.primaryCategory}|${group.secondaryCategory}`);
      const failedOnce = labels.find((label) => label.includes("__agent_fail_once__") && !failures.has(label));
      if (failedOnce) failures.add(failedOnce);
      if (failedOnce || labels.some((label) => label.includes("__agent_fail__"))) {
        response.writeHead(503, { "Content-Type": "application/json" }).end(JSON.stringify({ error: "unavailable" }));
        return;
      }
      if (labels.some((label) => label.includes("__agent_delayed__"))) {
        await new Promise((resolve) => setTimeout(resolve, 1500));
      }

      const result: ImportAgentResponse = {
        schemaVersion: IMPORT_AGENT_SCHEMA_VERSION,
        suggestions: input.groups.map((group, index) => {
          if (labels[index].includes("__agent_ignore__")) return { groupId: group.id, action: "ignore" };
          const category = input.categories.find((candidate) => candidate.name === "Dining" && candidate.type === group.transactionType);
          if (labels[index].includes("__agent_uncertain__") || !category) return { groupId: group.id, action: "uncertain" };
          return { groupId: group.id, action: "map", categoryId: category.id };
        }),
      };
      response.writeHead(200, { "Content-Type": "application/json" }).end(JSON.stringify(result));
    } catch {
      response.writeHead(400).end();
    }
  });

  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(0, "127.0.0.1", resolve);
  });
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Agent fixture did not bind a TCP port");
  process.env.IMPORT_AGENT_URL = `http://127.0.0.1:${address.port}`;
  process.env.IMPORT_AGENT_TOKEN = token;

  return async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
  };
}
