import { describe, expect, it } from "vitest";
import { parseReconciliationApplicationDefinition, parseReconciliationApplyInput } from "@/lib/reports/bill-reconciliation-application-protocol";
import { deriveManualReconciliationActions, normalizeReconciliationManualGroups, normalizeReconciliationRetentionGroups, previewReconciliationSelection, reconciliationManualGroupKey } from "@/lib/reports/bill-reconciliation-selection";
import type { ReconciliationAppliedManualGroup, ReconciliationManualGroup, ReconciliationRecord, ReconciliationSuggestion } from "@/lib/reports/bill-reconciliation-types";

const request = { requestId: "064cf6dc-1846-476d-bd0e-f57c98289170", reportId: "report-one", generation: 1 };
const manualGroup = { noticeId: "s1", refs: ["r1", "r2"], keepRef: "r2" };
const manualInput = { ...request, version: 2, suggestionIds: [], manualGroups: [manualGroup] };
const record = (ref: string, patch: Partial<ReconciliationRecord> = {}): ReconciliationRecord => ({
  ref, occurredAt: "2026-01-10T00:00:00.000Z", date: "2026-01-10", type: "expense", amountFen: 5000,
  categoryName: "Dining", memberLabel: "Member", ledgerLabel: "Ledger", memberAlias: "m1", ledgerAlias: "l1",
  note: null, source: null, timePrecision: "unknown", timeSupplemented: false, aggregated: false, ...patch,
});
const notice = (records: ReconciliationRecord[], id = "s1"): ReconciliationSuggestion => ({
  id, kind: "notice", title: "Related payments", reason: "Confirm the original payments", evidenceRefs: records.map(({ ref }) => ref),
  confidence: "review", defaultSelected: false, canApply: false, readOnlyReason: "unsupported",
  actions: records.map(({ ref, amountFen }) => ({ ref, action: "keep", amountFen })),
});
const duplicate = (records: ReconciliationRecord[], id: string): ReconciliationSuggestion => ({
  ...notice(records, id), kind: "duplicate", confidence: "high", defaultSelected: true, canApply: true, readOnlyReason: null,
  actions: records.map(({ ref, amountFen }, index) => ({ ref, action: index === 0 ? "keep" : "delete", amountFen })),
});
const pair = [record("r1"), record("r2")];
const preview = previewReconciliationSelection(pair, [notice(pair)], { suggestionIds: [], manualGroups: [manualGroup] });

function receipt() {
  const protectedGroup: ReconciliationAppliedManualGroup = { ...manualGroup, transactions: [{ ref: "r1", transactionId: "transaction-one" }, { ref: "r2", transactionId: "transaction-two" }],
    keepTransactionId: "transaction-two", deletedTransactionIds: ["transaction-one"] };
  return { version: 2, inputHash: "a".repeat(64), outcome: { ...request, version: 2, status: "success", suggestionIds: [] as string[], manualGroups: [manualGroup], preview },
    transactionIds: ["transaction-one", "transaction-two"], consumedIncomeIds: [] as string[], manualGroups: [protectedGroup] };
}

describe("manual reconciliation application protocol", () => {
  it("accepts an explicit v2 selection containing only a confirmed manual group", () => {
    const input = { ...request, version: 2, suggestionIds: [], manualGroups: [manualGroup] };
    expect(() => parseReconciliationApplyInput(input)).not.toThrow();
    expect(parseReconciliationApplyInput(input)).toEqual(input);
  });

  it("preserves the original v1 shape without adding a version or manual defaults", () => {
    const input = { ...request, suggestionIds: ["s2"] };
    expect(parseReconciliationApplyInput(input)).toEqual(input);
    expect(parseReconciliationApplyInput(input)).not.toHaveProperty("version");
    expect(parseReconciliationApplyInput(input)).not.toHaveProperty("manualGroups");
  });

  it("accepts mixed and AI-only v2 selections without reinterpreting v1", () => {
    expect(parseReconciliationApplyInput({ ...manualInput, suggestionIds: ["s2"] })).toEqual({ ...manualInput, suggestionIds: ["s2"] });
    expect(parseReconciliationApplyInput({ ...manualInput, suggestionIds: ["s2"], manualGroups: [] })).toEqual({ ...manualInput, suggestionIds: ["s2"], manualGroups: [] });
    expect(() => parseReconciliationApplyInput({ ...request, suggestionIds: [] })).toThrow();
    expect(() => parseReconciliationApplyInput({ ...manualInput, version: undefined })).toThrow();
    expect(() => parseReconciliationApplyInput({ ...manualInput, version: 1 })).toThrow();
    expect(() => parseReconciliationApplyInput({ ...manualInput, version: 3 })).toThrow();
  });

  it.each([
    { suggestionIds: [], manualGroups: [] },
    { suggestionIds: ["s2", "s2"] },
    { suggestionIds: ["s1"] },
    { manualGroups: [{ noticeId: "s1", refs: ["r1", "r2"] }] },
    { manualGroups: [{ ...manualGroup, keepRef: "r3" }] },
    { manualGroups: [{ ...manualGroup, refs: ["r1", "r1"] }] },
    { manualGroups: [{ ...manualGroup, refs: ["r1"] }] },
    { manualGroups: [{ ...manualGroup, refs: ["r1", "private-transaction-id"] }] },
    { manualGroups: [manualGroup, { noticeId: "s2", refs: ["r2", "r3"], keepRef: "r3" }] },
    { manualGroups: [{ ...manualGroup, amountFen: 5000 }] },
    { manualGroups: [{ ...manualGroup, transactionId: "private-id" }] },
    { amountFen: 5000 },
    { actions: [{ ref: "r1", action: "delete", amountFen: 5000 }] },
  ])("rejects incomplete, overlapping or client-authored financial instructions: %j", (patch) => {
    expect(() => parseReconciliationApplyInput({ ...manualInput, ...patch })).toThrow();
  });

  it("bounds total items, per-group refs and distinct manual participants", () => {
    const groups = Array.from({ length: 200 }, (_, index) => ({ noticeId: "s1", refs: [`r${index * 2 + 1}`, `r${index * 2 + 2}`], keepRef: `r${index * 2 + 1}` }));
    expect(() => parseReconciliationApplyInput({ ...manualInput, manualGroups: groups })).not.toThrow();
    expect(() => parseReconciliationApplyInput({ ...manualInput, suggestionIds: ["s2"], manualGroups: groups })).toThrow();
    const group = (from: number, count: number) => ({ noticeId: "s1", refs: Array.from({ length: count }, (_, index) => `r${from + index}`), keepRef: `r${from}` });
    expect(() => parseReconciliationApplyInput({ ...manualInput, manualGroups: [group(1, 500), group(501, 500)] })).not.toThrow();
    expect(() => parseReconciliationApplyInput({ ...manualInput, manualGroups: [group(1, 501)] })).toThrow();
    expect(() => parseReconciliationApplyInput({ ...manualInput, manualGroups: [group(1, 500), group(501, 500), group(1001, 2)] })).toThrow();
  });
});

describe("confirmed manual duplicate actions", () => {
  it("keeps the explicitly chosen record even with less source and note information", () => {
    const records = [record("r1", { note: "Merchant and detailed receipt PAY123456", source: "WECHAT", timePrecision: "second" }),
      record("r2", { occurredAt: "2026-01-11T00:00:00.000Z", date: "2026-01-11" })];
    const suggestions = [notice(records)];
    const original = structuredClone({ records, suggestions });
    expect(deriveManualReconciliationActions(records, suggestions, [manualGroup])).toEqual([
      { ref: "r1", action: "delete", amountFen: 5000 }, { ref: "r2", action: "keep", amountFen: 5000 },
    ]);
    expect({ records, suggestions }).toEqual(original);
  });

  it("uses only the equal-amount subset of a notice with several unrelated pairs", () => {
    const records = [...pair, record("r3", { amountFen: 1390 }), record("r4", { amountFen: 1390 })];
    const suggestions = [notice(records)];
    expect(deriveManualReconciliationActions(records, suggestions, [manualGroup]).map((action) => action.ref)).toEqual(["r1", "r2"]);
    const groups = [manualGroup, { noticeId: "s1", refs: ["r3", "r4"], keepRef: "r3" }];
    expect(deriveManualReconciliationActions(records, suggestions, groups)).toHaveLength(4);
    expect(() => deriveManualReconciliationActions(records, suggestions, [{ ...manualGroup, refs: ["r1", "r3"], keepRef: "r1" }])).toThrow("amount_mismatch");
  });

  it.each([
    { memberAlias: "m2" }, { ledgerAlias: "l2" }, { type: "income" as const }, { amountFen: 4999 },
    { amountFen: 0 }, { amountFen: 1.1 }, { amountFen: 2_147_483_648 },
  ])("rejects an incompatible selected record: %j", (patch) => {
    const records = [record("r1"), record("r2", patch)];
    expect(() => deriveManualReconciliationActions(records, [notice(records)], [manualGroup])).toThrow();
  });

  it("requires a live notice containing every selected ref and an explicit group keeper", () => {
    expect(() => deriveManualReconciliationActions(pair, [duplicate(pair, "s1")], [manualGroup])).toThrow();
    expect(() => deriveManualReconciliationActions(pair, [], [manualGroup])).toThrow();
    expect(() => deriveManualReconciliationActions(pair, [{ ...notice(pair), applied: true }], [manualGroup])).toThrow();
    expect(() => deriveManualReconciliationActions(pair, [notice([pair[0]])], [manualGroup])).toThrow();
    expect(() => deriveManualReconciliationActions([pair[0]], [notice(pair)], [manualGroup])).toThrow();
    expect(() => deriveManualReconciliationActions(pair, [notice(pair)], [{ ...manualGroup, keepRef: "r3" }])).toThrow();
    expect(() => deriveManualReconciliationActions([...pair, pair[0]], [notice(pair)], [manualGroup])).toThrow();
  });
});

describe("mixed reconciliation selection preview", () => {
  it("combines manual expense dedupe and an AI offset across Shanghai days and months", () => {
    const records = [record("r1", { occurredAt: "2026-01-31T15:59:00.000Z", date: "2026-01-31" }),
      record("r2", { occurredAt: "2026-01-31T16:00:00.000Z", date: "2026-02-01" }),
      record("r3", { amountFen: 10_000, occurredAt: "2026-02-10T00:00:00.000Z", date: "2026-02-10" }),
      record("r4", { type: "income", amountFen: 3000, occurredAt: "2026-03-10T00:00:00.000Z", date: "2026-03-10" })];
    const offset: ReconciliationSuggestion = { ...duplicate(records.slice(2), "s2"), kind: "reimbursement",
      actions: [{ ref: "r3", action: "update", amountFen: 7000 }, { ref: "r4", action: "delete", amountFen: 3000 }] };
    const mixed = previewReconciliationSelection(records, [notice(records.slice(0, 2)), offset], { suggestionIds: ["s2"], manualGroups: [manualGroup] });
    expect(mixed.before).toEqual({ incomeFen: 3000, expenseFen: 20_000, netFen: -17_000, transactionCount: 4 });
    expect(mixed.after).toEqual({ incomeFen: 0, expenseFen: 12_000, netFen: -12_000, transactionCount: 2 });
    expect(mixed.delta).toEqual({ incomeFen: -3000, expenseFen: -8000, netFen: 5000, transactionCount: -2 });
    expect(mixed.months).toEqual([
      { key: "2026-01", delta: { incomeFen: 0, expenseFen: -5000, netFen: 5000, transactionCount: -1 } },
      { key: "2026-02", delta: { incomeFen: 0, expenseFen: -3000, netFen: 3000, transactionCount: 0 } },
      { key: "2026-03", delta: { incomeFen: -3000, expenseFen: 0, netFen: -3000, transactionCount: -1 } },
    ]);
    expect(mixed.days.map(({ key }) => key)).toEqual(["2026-01-31", "2026-02-10", "2026-03-10"]);
  });

  it("decreases net income for duplicate incomes without creating an offset", () => {
    const records = pair.map((item) => ({ ...item, type: "income" as const }));
    const result = previewReconciliationSelection(records, [notice(records)], { suggestionIds: [], manualGroups: [manualGroup] });
    expect(result.delta).toEqual({ incomeFen: -5000, expenseFen: 0, netFen: -5000, transactionCount: -1 });
  });

  it("rejects overlap on the kept ref as well as deleted refs across AI and manual actions", () => {
    const records = [...pair, record("r3")];
    const suggestions = [notice(records), duplicate(records.slice(1), "s2")];
    expect(() => previewReconciliationSelection(records, suggestions, { suggestionIds: ["s2"], manualGroups: [manualGroup] })).toThrow("Overlapping");
    expect(() => previewReconciliationSelection(records, suggestions, { suggestionIds: [], manualGroups: [manualGroup, { noticeId: "s1", refs: ["r2", "r3"], keepRef: "r2" }] })).toThrow("Overlapping");
    expect(() => previewReconciliationSelection(records, suggestions, { suggestionIds: ["s1"], manualGroups: [] })).toThrow();
  });

  it("enforces the shared item and participant limits for mixed selections", () => {
    const records = Array.from({ length: 1002 }, (_, index) => record(`r${index + 1}`));
    const groups: ReconciliationManualGroup[] = [{ noticeId: "s1", refs: records.slice(0, 500).map(({ ref }) => ref), keepRef: "r1" }];
    const suggestions = [notice(records.slice(0, 500)), duplicate(records.slice(500, 1000), "s2"), duplicate(records.slice(1000), "s3")];
    expect(previewReconciliationSelection(records.slice(0, 1000), suggestions, { suggestionIds: ["s2"], manualGroups: groups }).before.transactionCount).toBe(1000);
    expect(() => previewReconciliationSelection(records, suggestions, { suggestionIds: ["s2", "s3"], manualGroups: groups })).toThrow("too large");
    const auto = Array.from({ length: 200 }, (_, index) => duplicate(records.slice(2 + index * 2, 4 + index * 2), `s${index + 2}`));
    expect(() => previewReconciliationSelection(records, [notice(pair), ...auto], { suggestionIds: auto.slice(0, 199).map(({ id }) => id), manualGroups: [manualGroup] })).not.toThrow();
    expect(() => previewReconciliationSelection(records, [notice(pair), ...auto], { suggestionIds: auto.map(({ id }) => id), manualGroups: [manualGroup] })).toThrow("too large");
  });
});

describe("stable manual selection identity", () => {
  it("ignores input order while retaining grouping and explicit keeper in the identity", () => {
    const second = { noticeId: "s1", refs: ["r4", "r3"], keepRef: "r4" };
    const original = structuredClone([manualGroup, second]);
    expect(normalizeReconciliationManualGroups([second, { ...manualGroup, refs: ["r2", "r1"] }])).toEqual(normalizeReconciliationManualGroups([manualGroup, second]));
    expect(reconciliationManualGroupKey(manualGroup)).toBe(reconciliationManualGroupKey({ ...manualGroup, refs: ["r2", "r1"] }));
    expect(reconciliationManualGroupKey(manualGroup)).not.toBe(reconciliationManualGroupKey({ ...manualGroup, keepRef: "r1" }));
    expect(normalizeReconciliationManualGroups([manualGroup, second])).not.toEqual(normalizeReconciliationManualGroups([{ noticeId: "s1", refs: ["r1", "r2", "r3", "r4"], keepRef: "r2" }]));
    expect([manualGroup, second]).toEqual(original);
    expect(() => normalizeReconciliationManualGroups([manualGroup, manualGroup])).toThrow();
  });
});

describe("protected application receipt compatibility", () => {
  it("keeps original v1 success, rejection and query-closure shapes unchanged", () => {
    const receipts = [
      { inputHash: "b".repeat(64), outcome: { requestId: request.requestId, status: "success", suggestionIds: ["s2"], preview }, transactionIds: ["old-expense"], consumedIncomeIds: ["old-income"] },
      { inputHash: "b".repeat(64), outcome: { requestId: request.requestId, status: "error", error: "CONFLICT" } },
      { inputHash: null, outcome: { requestId: request.requestId, status: "error", error: "NOT_ACCEPTED" } },
    ];
    for (const value of receipts) expect(parseReconciliationApplicationDefinition(value)).toEqual(value);
  });

  it("parses a manual success using its original mapping without live record fields", () => {
    const value = receipt();
    expect(parseReconciliationApplicationDefinition(value)).toEqual(value);
    expect(value.outcome.suggestionIds).toEqual([]);
    expect(value.consumedIncomeIds).toEqual([]);
    expect(parseReconciliationApplicationDefinition({ version: 2, inputHash: "a".repeat(64), manualGroups: [],
      outcome: { requestId: request.requestId, status: "error", error: "CONFLICT" } })).toMatchObject({ version: 2 });
  });

  it("allows separate actual offset facts in a mixed success but rejects reused real IDs across manual groups", () => {
    const mixed = receipt();
    mixed.outcome.suggestionIds = ["s2"];
    mixed.transactionIds.push("offset-expense", "offset-income");
    mixed.consumedIncomeIds = ["offset-income"];
    expect(parseReconciliationApplicationDefinition(mixed)).toEqual(mixed);
    const reused = receipt();
    const second = { noticeId: "s1", refs: ["r3", "r4"], keepRef: "r4" };
    reused.outcome.suggestionIds = ["s2"];
    reused.outcome.manualGroups.push(second);
    reused.manualGroups.push({ ...second, transactions: [{ ref: "r3", transactionId: "transaction-one" }, { ref: "r4", transactionId: "transaction-two" }],
      keepTransactionId: "transaction-two", deletedTransactionIds: ["transaction-one"] });
    expect(() => parseReconciliationApplicationDefinition(reused)).toThrow();
  });

  it.each([
    (value: ReturnType<typeof receipt>) => { value.manualGroups[0].keepTransactionId = "transaction-one"; },
    (value: ReturnType<typeof receipt>) => { value.manualGroups[0].deletedTransactionIds = ["transaction-two"]; },
    (value: ReturnType<typeof receipt>) => { value.manualGroups[0].transactions[0].ref = "r2"; },
    (value: ReturnType<typeof receipt>) => { value.manualGroups[0].transactions[0].transactionId = "transaction-two"; },
    (value: ReturnType<typeof receipt>) => { value.transactionIds = ["transaction-two"]; },
    (value: ReturnType<typeof receipt>) => { value.transactionIds.push("transaction-one"); },
    (value: ReturnType<typeof receipt>) => { value.transactionIds.push("unexplained-transaction"); },
    (value: ReturnType<typeof receipt>) => { value.consumedIncomeIds = ["transaction-one"]; },
    (value: ReturnType<typeof receipt>) => { value.consumedIncomeIds = ["unrelated-income"]; },
    (value: ReturnType<typeof receipt>) => { value.outcome.manualGroups = [{ ...manualGroup, keepRef: "r1" }]; },
    (value: ReturnType<typeof receipt>) => { value.outcome.suggestionIds = ["s1"]; },
  ])("rejects an inconsistent v2 historical mapping %#", (corrupt) => {
    const value = receipt();
    corrupt(value);
    expect(() => parseReconciliationApplicationDefinition(value)).toThrow();
  });
});

describe("multiple retained records", () => {
  const group = { noticeId: "s1", refs: ["r1", "r2", "r3"], keepRefs: ["r1", "r3"] };
  const input = { ...request, version: 3, suggestionIds: [], manualGroups: [group] };

  it("accepts a v3 group with multiple explicit keepers without converting legacy inputs", () => {
    expect(() => parseReconciliationApplyInput(input)).not.toThrow();
    expect(parseReconciliationApplyInput(input)).toEqual(input);
    expect(parseReconciliationApplyInput(manualInput)).toEqual(manualInput);
  });

  it("keeps every explicitly retained record and derives only remaining deletions", () => {
    const records = [record("r1"), record("r2"), record("r3", { note: "Keep this distinct payment" })];
    const actions = deriveManualReconciliationActions(records, [notice(records)], [group]);
    expect(actions).toEqual([
      { ref: "r1", action: "keep", amountFen: 5000 },
      { ref: "r2", action: "delete", amountFen: 5000 },
      { ref: "r3", action: "keep", amountFen: 5000 },
    ]);
    expect(previewReconciliationSelection(records, [notice(records)], { suggestionIds: [], manualGroups: [group] }).delta)
      .toEqual({ incomeFen: 0, expenseFen: -5000, netFen: 5000, transactionCount: -1 });
  });

  it.each([
    { keepRefs: [] }, { keepRefs: ["r1", "r2", "r3"] }, { keepRefs: ["r1", "r1"] }, { keepRefs: ["r4"] },
    { refs: ["r1", "r1", "r3"] }, { keepRef: "r1" }, { amountFen: 5000 },
  ])("rejects v3 no-op, ambiguous or client-authored fields: %j", (patch) => {
    expect(() => parseReconciliationApplyInput({ ...input, manualGroups: [{ ...group, ...patch }] })).toThrow();
  });

  it("rejects overlap with any retained reference across manual groups and AI suggestions", () => {
    const records = [record("r1"), record("r2"), record("r3"), record("r4")];
    expect(() => parseReconciliationApplyInput({ ...input, manualGroups: [group, { noticeId: "s2", refs: ["r3", "r4"], keepRefs: ["r4"] }] })).toThrow();
    expect(() => previewReconciliationSelection(records, [notice(records), duplicate(records.slice(2), "s2")], { suggestionIds: ["s2"], manualGroups: [group] })).toThrow();
  });

  it("normalizes input order while retaining the complete keep set and shared bounds", () => {
    const reordered = { ...group, refs: ["r3", "r1", "r2"], keepRefs: ["r3", "r1"] };
    expect(normalizeReconciliationRetentionGroups([reordered])).toEqual(normalizeReconciliationRetentionGroups([group]));
    expect(reconciliationManualGroupKey(group)).toBe(reconciliationManualGroupKey(reordered));
    expect(reconciliationManualGroupKey(group)).not.toBe(reconciliationManualGroupKey({ ...group, keepRefs: ["r1"] }));
    const sized = (from: number, count: number) => ({ noticeId: "s1", refs: Array.from({ length: count }, (_, index) => `r${from + index}`), keepRefs: [`r${from}`] });
    expect(() => parseReconciliationApplyInput({ ...input, manualGroups: [sized(1, 500), sized(501, 500)] })).not.toThrow();
    expect(() => parseReconciliationApplyInput({ ...input, manualGroups: [sized(1, 501)] })).toThrow();
    expect(() => parseReconciliationApplyInput({ ...input, manualGroups: [sized(1, 500), sized(501, 500), sized(1001, 2)] })).toThrow();
    const many = Array.from({ length: 200 }, (_, index) => sized(index * 2 + 1, 2));
    expect(() => parseReconciliationApplyInput({ ...input, manualGroups: many })).not.toThrow();
    expect(() => parseReconciliationApplyInput({ ...input, suggestionIds: ["s2"], manualGroups: many })).toThrow();
    expect(reordered.keepRefs).toEqual(["r3", "r1"]);
  });

  function v3Receipt() {
    return { version: 3, inputHash: "c".repeat(64), outcome: { ...request, version: 3, status: "success", suggestionIds: [] as string[], manualGroups: [group], preview },
      transactionIds: ["transaction-one", "transaction-two", "transaction-three"], consumedIncomeIds: [] as string[],
      manualGroups: [{ ...group, transactions: [{ ref: "r1", transactionId: "transaction-one" }, { ref: "r2", transactionId: "transaction-two" }, { ref: "r3", transactionId: "transaction-three" }],
        keepTransactionIds: ["transaction-one", "transaction-three"], deletedTransactionIds: ["transaction-two"] }] };
  }

  it("validates a protected v3 receipt containing complete keep and delete mappings", () => {
    expect(() => parseReconciliationApplicationDefinition(v3Receipt())).not.toThrow();
    expect(parseReconciliationApplicationDefinition(v3Receipt())).toEqual(v3Receipt());
  });

  it.each([
    (value: ReturnType<typeof v3Receipt>) => { value.manualGroups[0].keepTransactionIds = ["transaction-one"]; },
    (value: ReturnType<typeof v3Receipt>) => { value.manualGroups[0].keepTransactionIds = ["transaction-one", "transaction-one"]; },
    (value: ReturnType<typeof v3Receipt>) => { value.manualGroups[0].deletedTransactionIds = ["transaction-three"]; },
    (value: ReturnType<typeof v3Receipt>) => { value.manualGroups[0].transactions[2].transactionId = "transaction-one"; },
    (value: ReturnType<typeof v3Receipt>) => { value.outcome.manualGroups[0] = { ...group, keepRefs: ["r1"] }; },
    (value: ReturnType<typeof v3Receipt>) => { value.consumedIncomeIds = ["transaction-two"]; },
  ])("rejects incomplete or inconsistent v3 historical facts %#", (corrupt) => {
    const value = v3Receipt();
    corrupt(value);
    expect(() => parseReconciliationApplicationDefinition(value)).toThrow();
  });
});
