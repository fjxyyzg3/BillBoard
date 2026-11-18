import { describe, expect, it } from "vitest";
import type { BillReconciliationSnapshot, ReconciliationSourceRow } from "../../src/lib/reports/bill-reconciliation-types";

function row(index: number, patch: Partial<ReconciliationSourceRow> = {}): ReconciliationSourceRow {
  const time = new Date(Date.UTC(2026, 0, 1, 0, index)).toISOString();
  return { id: `private-row-${index}`, ledgerId: "private-ledger", actorMemberId: "private-member", createdByMemberId: "private-member",
    clientRequestId: null, categoryId: "private-category", categoryName: "Dining", memberLabel: "Member", ledgerLabel: "Ledger",
    type: "EXPENSE", amountFen: 10_000 + index, occurredAt: time, createdAt: time, updatedAt: time, note: `Independent purchase ${index}`,
    source: null, sourceFingerprint: null, sourceImportedAt: null, archivedAt: null,
    timePrecision: "second", timeSupplemented: false, aggregated: false, offsetEvidence: "unconsumed", dependencyHash: "a".repeat(64), ...patch };
}
function snapshot(rows: ReconciliationSourceRow[]): BillReconciliationSnapshot {
  return { scope: { mode: "year", period: "2026", ledgerId: null, actorMemberId: null }, locale: "zh-CN",
    range: { from: "2026-01-01", to: "2026-12-31" }, snapshotAt: "2026-11-05T00:00:00.000Z", rows };
}

async function domain() { return import("../../src/lib/reports/bill-reconciliation-prepare"); }

describe("complete and evidence-bound reconciliation preparation", () => {
  it("prepares 10,000 sparse records completely in twenty bounded context batches without private identifiers", async () => {
    const { prepareBillReconciliation } = await domain();
    const input = snapshot(Array.from({ length: 10_000 }, (_, index) => row(index)));
    const prepared = prepareBillReconciliation(input);
    const context = prepared.batches.filter((batch) => batch.stage === "context");
    expect(context).toHaveLength(20);
    expect(context.flatMap((batch) => batch.rows)).toHaveLength(10_000);
    expect(new Set(context.flatMap((batch) => batch.rows.map((item) => item.ref))).size).toBe(10_000);
    expect(prepared.batches.every((batch) => batch.rows.length <= 500 && Buffer.byteLength(JSON.stringify(batch)) <= 256 * 1024)).toBe(true);
    const wire = JSON.stringify(prepared.batches);
    expect(Buffer.byteLength(wire)).toBeLessThanOrEqual(8 * 1024 * 1024);
    expect(wire).not.toContain("private-");
    expect(wire).not.toContain("dependencyHash");
  });

  it("puts a cross-batch duplicate candidate in a shared review batch before any model call", async () => {
    const { prepareBillReconciliation } = await domain();
    const rows = Array.from({ length: 501 }, (_, index) => row(index));
    rows[0] = row(0, { amountFen: 42_000, note: "Receipt PAY-ABC123 coffee" });
    rows[500] = row(500, { amountFen: 42_000, note: "Receipt PAY-ABC123 coffee" });
    const prepared = prepareBillReconciliation(snapshot(rows));
    expect(prepared.batches.some((batch) => batch.stage === "candidate" && batch.rows.some((item) => item.ref === "r1") && batch.rows.some((item) => item.ref === "r501"))).toBe(true);
  });

  it("fits four complete 500-row bridge groups at 10,000 rows but rejects a fifth bridge batch", async () => {
    const { prepareBillReconciliation } = await domain();
    const input = (groups: number) => snapshot(Array.from({ length: 10_000 }, (_, index) => row(index,
      index < groups * 500 ? { amountFen: 6000 + index % groups, note: `Receipt PAY-GROUP${index % groups}` } : {})));
    const allowed = prepareBillReconciliation(input(4));
    expect(allowed.batches.filter((batch) => batch.stage === "context")).toHaveLength(20);
    expect(allowed.batches.filter((batch) => batch.stage === "candidate")).toHaveLength(4);
    expect(allowed.batches).toHaveLength(24);
    expect(() => prepareBillReconciliation(input(5))).toThrow(expect.objectContaining({ code: "TOO_LARGE" }));
  });

  it("rejects dense oversized candidate groups and oversized notes rather than dropping candidates", async () => {
    const { prepareBillReconciliation } = await domain();
    const dense = Array.from({ length: 501 }, (_, index) => row(index, { amountFen: 1000, note: "Receipt PAY-SAME123" }));
    expect(() => prepareBillReconciliation(snapshot(dense))).toThrow(expect.objectContaining({ code: "TOO_LARGE" }));
    expect(() => prepareBillReconciliation(snapshot([row(0, { note: "秘".repeat(100_000) })]))).toThrow(expect.objectContaining({ code: "TOO_LARGE" }));
    expect(() => prepareBillReconciliation(snapshot([]))).toThrow(expect.objectContaining({ code: "NO_DATA" }));
  });

  it("builds a combined deduplication and refund using server arithmetic and only referenced assertions", async () => {
    const { prepareBillReconciliation, buildBillReconciliationContent } = await domain();
    const input = snapshot([
      row(0, { note: "Order PAY-ABC123 bicycle charging", amountFen: 10_000 }),
      row(1, { note: "Order PAY-ABC123 bicycle charging", amountFen: 10_000 }),
      row(2, { note: "Refund Order PAY-ABC123 bicycle charging", type: "INCOME", amountFen: 3000 }), row(3),
    ]);
    const prepared = prepareBillReconciliation(input);
    const results = prepared.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId,
      groups: batch.stage === "context" ? [{ kind: "combined" as const, title: "核对充电记录", reason: "重复记账及明确退款",
        confidence: "high" as const, evidenceRefs: ["r1", "r2", "r3"], duplicateGroups: [["r1", "r2"]],
        offset: { expenseRef: "r1", incomeRefs: ["r3"], kind: "refund" as const } }] : [] }));
    const content = buildBillReconciliationContent(prepared, results);
    expect(content.suggestions).toHaveLength(1);
    expect(content.suggestions[0]).toMatchObject({ kind: "combined", canApply: true });
    expect(content.suggestions[0].actions).toEqual(expect.arrayContaining([
      { ref: "r1", action: "update", amountFen: 7000 }, { ref: "r2", action: "delete", amountFen: 10_000 }, { ref: "r3", action: "delete", amountFen: 3000 },
    ]));
    expect(Object.keys(content.assertions).sort()).toEqual(["r1", "r2", "r3"]);
    expect(JSON.stringify(content.records)).not.toContain("private-");
  });

  it.each([
    { patch: { timePrecision: "day" as const, timeSupplemented: true }, reason: "day-only bank timestamps" },
    { patch: { timePrecision: "unknown" as const }, reason: "unknown timestamps" },
    { patch: { aggregated: true }, reason: "aggregated rows" },
    { patch: { source: "CMB", sourceFingerprint: "b".repeat(64) }, reason: "contradicting source identities" },
  ])("does not preselect a time-only match for $reason", async ({ patch }) => {
    const { prepareBillReconciliation, buildBillReconciliationContent } = await domain();
    const shared = { amountFen: 1000, note: "Bicycle charging north station", occurredAt: "2026-01-01T00:00:00.000Z" };
    const input = snapshot([row(0, { ...shared, source: "CMB", sourceFingerprint: "a".repeat(64), ...patch }), row(1, { ...shared, ...patch, sourceFingerprint: "c".repeat(64) })]);
    const prepared = prepareBillReconciliation(input);
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId,
      groups: [{ kind: "duplicate" as const, title: "核对", reason: "相同展示字段", confidence: "high" as const, evidenceRefs: ["r1", "r2"], duplicateGroups: [["r1", "r2"]], offset: null }] })));
    expect(content.suggestions[0].defaultSelected).toBe(false);
  });

  it.each([
    { patch: { actorMemberId: "private-other-member" }, expected: "cross_scope" },
    { patch: { ledgerId: "private-other-ledger" }, expected: "cross_scope" },
    { patch: { archivedAt: "2026-10-01T00:00:00.000Z" }, expected: "archived" },
    { patch: { amountFen: 11_000 }, expected: "amount_mismatch" },
  ])("never offers invalid duplicate groups as applicable", async ({ patch, expected }) => {
    const { prepareBillReconciliation, buildBillReconciliationContent } = await domain();
    const prepared = prepareBillReconciliation(snapshot([row(0, { note: "Receipt PAY-ABC123", amountFen: 10_000 }), row(1, { note: "Receipt PAY-ABC123", amountFen: 10_000, ...patch })]));
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId,
      groups: [{ kind: "duplicate" as const, title: "核对", reason: "同事项", confidence: "high" as const, evidenceRefs: ["r1", "r2"], duplicateGroups: [["r1", "r2"]], offset: null }] })));
    expect(content.suggestions[0]).toMatchObject({ canApply: false, defaultSelected: false, readOnlyReason: expected });
  });

  it.each(["consumed", "unknown"] as const)("requires positive unconsumed evidence before offsetting %s history", async (offsetEvidence) => {
    const { prepareBillReconciliation, buildBillReconciliationContent } = await domain();
    const prepared = prepareBillReconciliation(snapshot([row(0, { note: "Order PAY-ABC123", amountFen: 10_000, offsetEvidence }), row(1, { note: "Refund Order PAY-ABC123", type: "INCOME", amountFen: 3000 })]));
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId,
      groups: [{ kind: "refund" as const, title: "退款", reason: "同订单", confidence: "high" as const, evidenceRefs: ["r1", "r2"], duplicateGroups: [], offset: { expenseRef: "r1", incomeRefs: ["r2"], kind: "refund" as const } }] })));
    expect(content.suggestions[0].canApply).toBe(false);
  });

  it("coalesces separate duplicate and offset findings, including duplicate income, before computing the net", async () => {
    const { prepareBillReconciliation, buildBillReconciliationContent } = await domain();
    const prepared = prepareBillReconciliation(snapshot([
      row(0, { note: "Order PAY-ABC123", amountFen: 10_000 }), row(1, { note: "Order PAY-ABC123", amountFen: 10_000 }),
      row(2, { note: "Refund Order PAY-ABC123", type: "INCOME", amountFen: 3000 }), row(3, { note: "Refund Order PAY-ABC123", type: "INCOME", amountFen: 3000 }),
    ]));
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId, groups: [
      { kind: "duplicate" as const, title: "去重", reason: "同一笔支付与同一笔退款", confidence: "high" as const, evidenceRefs: ["r1", "r2", "r3", "r4"], duplicateGroups: [["r1", "r2"], ["r3", "r4"]], offset: null },
      { kind: "refund" as const, title: "退款", reason: "对应原支付", confidence: "high" as const, evidenceRefs: ["r1", "r3"], duplicateGroups: [], offset: { expenseRef: "r1", incomeRefs: ["r3"], kind: "refund" as const } },
    ] })));
    expect(content.suggestions).toHaveLength(1);
    expect(content.suggestions[0].actions).toEqual([
      { ref: "r1", action: "update", amountFen: 7000 }, { ref: "r2", action: "delete", amountFen: 10_000 },
      { ref: "r3", action: "delete", amountFen: 3000 }, { ref: "r4", action: "delete", amountFen: 3000 },
    ]);
  });

  it.each([3000, 10_000, 12_000])("computes a %i-fen reimbursement without inventing an amount", async (returnedFen) => {
    const { prepareBillReconciliation, buildBillReconciliationContent } = await domain();
    const prepared = prepareBillReconciliation(snapshot([row(0, { amountFen: 10_000, note: "Order PAY-ABC123 office trip" }), row(1, { type: "INCOME", amountFen: returnedFen, note: "Reimbursement Order PAY-ABC123 office trip" })]));
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId,
      groups: [{ kind: "reimbursement" as const, title: "报销", reason: "同一事项", confidence: "high" as const, evidenceRefs: ["r1", "r2"], duplicateGroups: [], offset: { expenseRef: "r1", incomeRefs: ["r2"], kind: "reimbursement" as const } }] })));
    expect(content.suggestions[0].canApply).toBe(returnedFen <= 10_000);
    if (returnedFen < 10_000) expect(content.suggestions[0].actions[0]).toEqual({ ref: "r1", action: "update", amountFen: 10_000 - returnedFen });
    if (returnedFen === 10_000) expect(content.suggestions[0].actions.every((action) => action.action === "delete" && action.amountFen > 0)).toBe(true);
    if (returnedFen > 10_000) expect(content.suggestions[0].readOnlyReason).toBe("over_offset");
  });

  it("does not permit ordinary income to be offset and downgrades competing refund associations", async () => {
    const { prepareBillReconciliation, buildBillReconciliationContent } = await domain();
    const prepared = prepareBillReconciliation(snapshot([row(0, { amountFen: 10_000, note: "Order PAY-ABC123" }), row(1, { amountFen: 11_000, note: "Order PAY-ABC123" }), row(2, { type: "INCOME", amountFen: 3000, note: "Refund Order PAY-ABC123" })]));
    const groups = ["r1", "r2"].map((expenseRef) => ({ kind: "refund" as const, title: "核对", reason: "候选事项", confidence: "high" as const,
      evidenceRefs: [expenseRef, "r3"], duplicateGroups: [], offset: { expenseRef, incomeRefs: ["r3"], kind: "refund" as const } }));
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId, groups })));
    expect(content.suggestions).toHaveLength(2);
    expect(content.suggestions.every((item) => item.canApply && !item.defaultSelected)).toBe(true);
    const ordinary = prepareBillReconciliation(snapshot([row(0, { amountFen: 10_000, note: "Order PAY-ABC123" }), row(1, { type: "INCOME", amountFen: 3000, note: "Salary Order PAY-ABC123" })]));
    const unavailable = buildBillReconciliationContent(ordinary, ordinary.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId, groups: [{ ...groups[0], evidenceRefs: ["r1", "r2"], offset: { ...groups[0].offset, incomeRefs: ["r2"] } }] })));
    expect(unavailable.suggestions[0]).toMatchObject({ canApply: false, readOnlyReason: "unproven" });
  });

  it("recomputes persisted actions from relations and original assertions before accepting content", async () => {
    const { prepareBillReconciliation, buildBillReconciliationContent } = await domain();
    const { parseBillReconciliationContent } = await import("../../src/lib/reports/bill-reconciliation-protocol");
    const prepared = prepareBillReconciliation(snapshot([row(0, { amountFen: 10_000, note: "Order PAY-ABC123" }), row(1, { type: "INCOME", amountFen: 3000, note: "Refund Order PAY-ABC123" })]));
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId, groups: [{ kind: "refund" as const, title: "退款", reason: "同笔原支付", confidence: "high" as const, evidenceRefs: ["r1", "r2"], duplicateGroups: [], offset: { expenseRef: "r1", incomeRefs: ["r2"], kind: "refund" as const } }] })));
    const forged = structuredClone(content); forged.suggestions[0].actions[0].amountFen = 1;
    expect(() => parseBillReconciliationContent(forged)).toThrow();
    const missing = structuredClone(content); delete missing.suggestions[0].relations;
    expect(() => parseBillReconciliationContent(missing)).toThrow();
  });

  it("never treats generic words after a receipt label as a unique payment identifier", async () => {
    const { prepareBillReconciliation, buildBillReconciliationContent } = await domain();
    const prepared = prepareBillReconciliation(snapshot([
      row(0, { note: "Receipt coffee", amountFen: 1000, timePrecision: "unknown" }),
      row(1, { note: "Receipt coffee", amountFen: 1000, timePrecision: "unknown" }),
    ]));
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId,
      groups: [{ kind: "duplicate" as const, title: "核对", reason: "相同普通摘要", confidence: "high" as const, evidenceRefs: ["r1", "r2"], duplicateGroups: [["r1", "r2"]], offset: null }] })));
    expect(content.suggestions[0].defaultSelected).toBe(false);
  });

  it.each(["day", "unknown"] as const)("uses established cross-day chronology for a unique offset with %s time precision", async (timePrecision) => {
    const { prepareBillReconciliation, buildBillReconciliationContent } = await domain();
    const prepared = prepareBillReconciliation(snapshot([
      row(0, { note: "Payment PAY-ABC123 office trip", amountFen: 10_000, occurredAt: "2026-01-10T16:00:00.000Z", timePrecision, timeSupplemented: true }),
      row(1, { note: "Reimbursement Payment PAY-ABC123 office trip", type: "INCOME", amountFen: 3000, occurredAt: "2026-02-10T16:00:00.000Z", timePrecision, timeSupplemented: true }),
    ]));
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId,
      groups: [{ kind: "reimbursement" as const, title: "报销抵扣", reason: "唯一的原支付和后续报销", confidence: "high" as const, evidenceRefs: ["r1", "r2"], duplicateGroups: [], offset: { expenseRef: "r1", incomeRefs: ["r2"], kind: "reimbursement" as const } }] })));
    expect(content.suggestions[0]).toMatchObject({ canApply: true, confidence: "high", defaultSelected: true });
  });

  it.each([
    { timePrecision: "unknown" as const, timeSupplemented: false, aggregated: false },
    { timePrecision: "day" as const, timeSupplemented: true, aggregated: false },
    { timePrecision: "second" as const, timeSupplemented: false, aggregated: true },
  ])("does not infer intraday chronology from unknown, supplemented or aggregated timestamps", async (precision) => {
    const { prepareBillReconciliation, buildBillReconciliationContent } = await domain();
    const prepared = prepareBillReconciliation(snapshot([
      row(0, { note: "Payment PAY-ABC123 office trip", amountFen: 10_000, occurredAt: "2026-01-10T00:00:00.000Z", ...precision }),
      row(1, { note: "Refund Payment PAY-ABC123 office trip", type: "INCOME", amountFen: 3000, occurredAt: "2026-01-10T01:00:00.000Z", ...precision }),
    ]));
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId,
      groups: [{ kind: "refund" as const, title: "核对退款", reason: "原支付的退款", confidence: "high" as const, evidenceRefs: ["r1", "r2"], duplicateGroups: [], offset: { expenseRef: "r1", incomeRefs: ["r2"], kind: "refund" as const } }] })));
    expect(content.suggestions[0]).toMatchObject({ canApply: true, defaultSelected: false });
  });

  it.each([
    ["Loan principal transfer", "Loan principal refund", "refund"],
    ["Borrowed money paid out", "Borrowed money refund", "refund"],
    ["Principal paid out", "Principal refund", "refund"],
    ["Own-account transfer", "Own-account refund", "refund"],
    ["Account top-up", "Account top-up refund", "refund"],
    ["借款转出", "借款退款", "refund"],
    ["归还本金", "本金退回", "refund"],
    ["同名账户资金划转", "同名账户资金退回", "refund"],
    ["银行存款", "存款返还", "refund"],
    ["信用卡还款", "信用卡还款退款", "refund"],
    ["Purchase office supplies", "not a refund", "refund"],
    ["Purchase office supplies", "no reimbursement", "reimbursement"],
    ["Purchase office supplies", "refund not received", "refund"],
    ["Purchase office supplies", "not refundable", "refund"],
    ["Purchase office supplies", "unreimbursed", "reimbursement"],
    ["购买办公用品", "不是退款", "refund"],
    ["购买办公用品", "并非报销", "reimbursement"],
    ["购买办公用品", "未收到退款", "refund"],
    ["购买办公用品", "不退款", "refund"],
    ["购买办公用品", "未报销", "reimbursement"],
    ["购买办公用品", "退款未到账", "refund"],
  ] as const)("keeps explicit non-consumption or negated offset evidence read-only: %s / %s", async (expenseNote, incomeNote, kind) => {
    const { prepareBillReconciliation, buildBillReconciliationContent } = await domain();
    const prepared = prepareBillReconciliation(snapshot([
      row(0, { amountFen: 10_000, note: `${expenseNote} Payment SYN-LOAN123`, occurredAt: "2026-01-01T00:00:00.000Z", timePrecision: "unknown" }),
      row(1, { type: "INCOME", amountFen: 3000, note: `${incomeNote} Payment SYN-LOAN123`, occurredAt: "2026-01-02T00:00:00.000Z", timePrecision: "unknown" }),
    ]));
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId,
      groups: [{ kind, title: "核对款项", reason: "模型声称同一笔高可信退款或报销", confidence: "high" as const, evidenceRefs: ["r1", "r2"], duplicateGroups: [], offset: { expenseRef: "r1", incomeRefs: ["r2"], kind } }] })));
    expect(content.suggestions[0]).toMatchObject({ canApply: false, defaultSelected: false, readOnlyReason: "unsupported" });
    expect(content.suggestions[0].actions.every((change) => change.action === "keep")).toBe(true);
  });

  it("rejects stored applicable offset actions with explicit loan evidence during content revalidation", async () => {
    const { prepareBillReconciliation, buildBillReconciliationContent } = await domain();
    const { parseBillReconciliationContent } = await import("../../src/lib/reports/bill-reconciliation-protocol");
    const prepared = prepareBillReconciliation(snapshot([
      row(0, { amountFen: 10_000, note: "Purchase Payment SYN-STORE123", occurredAt: "2026-01-01T00:00:00.000Z" }),
      row(1, { type: "INCOME", amountFen: 3000, note: "Refund Payment SYN-STORE123", occurredAt: "2026-01-02T00:00:00.000Z" }),
    ]));
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId,
      groups: [{ kind: "refund" as const, title: "退款", reason: "同笔支付", confidence: "high" as const, evidenceRefs: ["r1", "r2"], duplicateGroups: [], offset: { expenseRef: "r1", incomeRefs: ["r2"], kind: "refund" as const } }] })));
    expect(content.suggestions[0].canApply).toBe(true);
    const forged = structuredClone(content);
    forged.records[0].note = forged.assertions.r1.note = "Loan principal transfer Payment SYN-STORE123";
    forged.records[1].note = forged.assertions.r2.note = "Loan principal refund Payment SYN-STORE123";
    expect(() => parseBillReconciliationContent(forged)).toThrow(expect.objectContaining({ code: "INVALID_RESPONSE" }));
  });

  it("checks offset chronology against the canonical retained expense rather than a deleted duplicate", async () => {
    const { prepareBillReconciliation, buildBillReconciliationContent } = await domain();
    const prepared = prepareBillReconciliation(snapshot([
      row(0, { amountFen: 10_000, note: "Payment SYN-123456", occurredAt: "2026-01-01T00:00:00.000Z", timePrecision: "unknown" }),
      row(1, { type: "INCOME", amountFen: 3000, note: "Refund Payment SYN-123456", occurredAt: "2026-01-02T01:00:00.000Z", timePrecision: "unknown" }),
      row(2, { amountFen: 10_000, note: "Payment SYN-123456 with more detail", occurredAt: "2026-01-02T10:00:00.000Z", timePrecision: "unknown" }),
    ]));
    const content = buildBillReconciliationContent(prepared, prepared.batches.map((batch) => ({ schemaVersion: batch.schemaVersion, batchId: batch.batchId,
      groups: [{ kind: "combined" as const, title: "去重及退款", reason: "同笔支付", confidence: "high" as const, evidenceRefs: ["r1", "r2", "r3"], duplicateGroups: [["r1", "r3"]], offset: { expenseRef: "r1", incomeRefs: ["r2"], kind: "refund" as const } }] })));
    expect(content.suggestions[0].actions).toContainEqual({ ref: "r3", action: "update", amountFen: 7000 });
    expect(content.suggestions[0]).toMatchObject({ canApply: true, defaultSelected: false, confidence: "review" });
  });
});
