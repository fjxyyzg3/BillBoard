import type { ReconciliationAction, ReconciliationPreview, ReconciliationRecord, ReconciliationSourceRow, ReconciliationSuggestion, ReconciliationTotals } from "./bill-reconciliation-types";

export type ReconciliationRelations = { duplicateGroups: string[][];
  offset: { expenseRef: string; incomeRefs: string[]; kind: "refund" | "reimbursement" | "mixed" } | null };

export function reconciliationNoteIdentifiers(note: string | null, paymentsOnly = false): string[] {
  if (!note) return [];
  const pattern = paymentsOnly
    ? /(?:支付(?:流水)?|交易(?:流水)?|流水(?:号)?|凭证(?:号)?|payment(?:\s+id)?|transaction(?:\s+id)?|receipt(?:\s+id)?)[\s:#：=-]*([a-z0-9][a-z0-9_-]{4,80})/giu
    : /(?:支付(?:流水)?|交易(?:流水)?|流水(?:号)?|凭证(?:号)?|订单(?:号)?|payment(?:\s+id)?|transaction(?:\s+id)?|receipt(?:\s+id)?|order(?:\s+id)?)[\s:#：=-]*([a-z0-9][a-z0-9_-]{4,80})/giu;
  return [...new Set([...note.matchAll(pattern)].map((match) => match[1].toLowerCase()).filter((id) => id.length >= 6 && /\d/.test(id)))];
}

export function reconciliationMatter(note: string | null): string {
  return (note ?? "").normalize("NFKC").toLowerCase()
    .replace(/退款|退回|返还|报销款?|收到|收入|支出|refund(?:ed)?|reimburse(?:ment|d)?|returned|expense|income/gu, "")
    .replace(/[^\p{L}\p{N}]/gu, "");
}

export function hasReconciliationMatterEvidence(left: ReconciliationRecord, right: ReconciliationRecord): boolean {
  const identifiers = new Set(reconciliationNoteIdentifiers(left.note));
  if (reconciliationNoteIdentifiers(right.note).some((id) => identifiers.has(id))) return true;
  const first = reconciliationMatter(left.note), second = reconciliationMatter(right.note);
  return first.length >= 4 && first === second && !/^(?:退款|报销|餐饮|购物|转账|消费|手续费|coffee|lunch|dinner|refund|payment|merchant|bank)$/iu.test(first);
}

function relationRefs(relations: ReconciliationRelations): string[] {
  return [...new Set([...relations.duplicateGroups.flat(), ...(relations.offset ? [relations.offset.expenseRef, ...relations.offset.incomeRefs] : [])])].sort();
}

function unsupportedOffsetNote(note: string | null): boolean {
  const text = (note ?? "").normalize("NFKC");
  const movement = /借款|借贷|借入|借出|出借|归还本金|还款|还本|贷款|本金|转账|划转|互转|汇款|提现|取款|存款|入金|出金|资金(?:调拨|转移|转入|转出)|(?:账户|帐户|钱包|银行卡)(?:[^。；;\n]{0,10})(?:充值|转入|转出|存入|取出)|\b(?:loan|borrow(?:ed|ing)?|lend(?:ing)?|lent|repay(?:ment|ments|ing)?|repaid|principal|transfer(?:red|ring|s)?|remittance|withdraw(?:al|als)?|credit[-\s]?card\s+payment|(?:account|balance|wallet|funds?)\s+(?:top[-\s]?up|deposit|movement))\b/iu;
  const deniedChinese = /(?:不是|并非|不属于|不算|不予|没有|尚未|未曾|未收到|未到账|拒绝)(?:[^。；;\n]{0,12})(?:退款|退回|返还|报销)|(?:不|未|无|非)\s*(?:退款|退回|返还|报销)|(?:退款|退回|返还|报销)(?:失败|被拒绝|申请中|尚?未(?:收到|到账|完成|通过|批准)|待(?:处理|审批|到账))/u;
  const deniedEnglish = /\b(?:not|no|never|without|non[-\s]?|un[-\s]?|isn['’]?t|wasn['’]?t)\s*(?:(?:a|an|the|any|actual|eligible|for)\s+){0,3}(?:refund(?:ed|able)?|reimburs(?:ement|ed|able)?|return(?:ed)?)\b|\b(?:refund|reimbursement|return)(?:\s+(?:was|is|has|been)){0,3}\s+(?:not|never|pending|denied|rejected|failed)\b/iu;
  return movement.test(text) || deniedChinese.test(text) || deniedEnglish.test(text);
}

function canonicalRefs(originals: Map<string, ReconciliationRecord>, assertions: Record<string, ReconciliationSourceRow>, relations: ReconciliationRelations): Map<string, string> {
  const refs = relationRefs(relations);
  if (refs.length < 2 || refs.length > 500 || refs.some((ref) => !originals.has(ref) || !assertions[ref])) throw new Error("unproven");
  const parent = new Map(refs.map((ref) => [ref, ref]));
  const find = (ref: string): string => { const owner = parent.get(ref); if (!owner) throw new Error("unproven"); if (owner === ref) return ref; const result = find(owner); parent.set(ref, result); return result; };
  for (const group of relations.duplicateGroups) {
    if (group.length < 2 || new Set(group).size !== group.length) throw new Error("unproven");
    const first = originals.get(group[0])!;
    if (group.some((ref) => !originals.has(ref) || originals.get(ref)!.type !== first.type || originals.get(ref)!.amountFen !== first.amountFen)) throw new Error("amount_mismatch");
    const source = assertions[group[0]];
    if (!group.every((ref) => source.source !== null && assertions[ref].source === source.source && source.sourceFingerprint !== null && assertions[ref].sourceFingerprint === source.sourceFingerprint)
      && group.slice(1).some((ref) => !hasReconciliationMatterEvidence(first, originals.get(ref)!))) throw new Error("unproven");
    for (const ref of group.slice(1)) parent.set(find(ref), find(group[0]));
  }
  const groups = new Map<string, string[]>();
  for (const ref of refs) { const key = find(ref), group = groups.get(key) ?? []; group.push(ref); groups.set(key, group); }
  const canonical = new Map<string, string>();
  const rank = (ref: string) => { const source = assertions[ref]; return (source.sourceFingerprint ? 10_000 : 0) + Math.min(source.note?.length ?? 0, 4000); };
  for (const group of groups.values()) {
    const ordered = [...group].sort((left, right) => rank(right) - rank(left) || assertions[left].createdAt.localeCompare(assertions[right].createdAt) || assertions[left].id.localeCompare(assertions[right].id));
    for (const ref of ordered) canonical.set(ref, ordered[0]);
  }
  return canonical;
}

export function canonicalReconciliationOffset(records: ReconciliationRecord[], assertions: Record<string, ReconciliationSourceRow>, relations: ReconciliationRelations) {
  if (!relations.offset) return null;
  const canonical = canonicalRefs(new Map(records.map((item) => [item.ref, item])), assertions, relations);
  const expenseRef = canonical.get(relations.offset.expenseRef)!;
  return { expenseRef, incomeRefs: [...new Set(relations.offset.incomeRefs.map((ref) => canonical.get(ref)!))],
    duplicateExpenseRefs: relationRefs(relations).filter((ref) => canonical.get(ref) === expenseRef) };
}

export function deriveReconciliationActions(
  records: ReconciliationRecord[], assertions: Record<string, ReconciliationSourceRow>, relations: ReconciliationRelations,
): ReconciliationAction[] {
  const originals = new Map(records.map((item) => [item.ref, item]));
  const refs = relationRefs(relations);
  if (refs.length < 2 || refs.length > 500 || refs.some((ref) => !originals.has(ref) || !assertions[ref])) throw new Error("unproven");
  const sources = refs.map((ref) => assertions[ref]);
  if (new Set(sources.map(({ ledgerId }) => ledgerId)).size !== 1 || new Set(sources.map(({ actorMemberId }) => actorMemberId)).size !== 1) throw new Error("cross_scope");
  if (sources.some(({ archivedAt }) => archivedAt !== null)) throw new Error("archived");
  if (relations.offset && refs.some((ref) => unsupportedOffsetNote(originals.get(ref)!.note))) throw new Error("unsupported");
  const canonical = canonicalRefs(originals, assertions, relations);
  const actions = new Map<string, ReconciliationAction>(refs.map((ref) => [ref,
    { ref, action: canonical.get(ref) === ref ? "keep" : "delete", amountFen: originals.get(ref)!.amountFen }]));
  if (relations.offset) {
    const expenseRef = canonical.get(relations.offset.expenseRef)!;
    const incomeRefs = [...new Set(relations.offset.incomeRefs.map((ref) => canonical.get(ref)!))];
    if (!incomeRefs.length || incomeRefs.includes(expenseRef) || originals.get(expenseRef)!.type !== "expense"
      || incomeRefs.some((ref) => !ref || originals.get(ref)!.type !== "income")) throw new Error("unproven");
    if (incomeRefs.some((ref) => !/(?:退款|退回|返还|refund|returned|报销|reimburs)/iu.test(originals.get(ref)!.note ?? "")
      || !hasReconciliationMatterEvidence(originals.get(expenseRef)!, originals.get(ref)!))) throw new Error("unproven");
    const kinds = new Set(incomeRefs.map((ref) => /(?:报销|reimburs)/iu.test(originals.get(ref)!.note ?? "") ? "reimbursement" : "refund"));
    const expectedKind = kinds.size === 2 ? "mixed" : [...kinds][0];
    if (expectedKind !== relations.offset.kind) throw new Error("unproven");
    const expenseDate = originals.get(expenseRef)!.date;
    if (incomeRefs.some((ref) => originals.get(ref)!.date < expenseDate)) throw new Error("unproven");
    if ([expenseRef, ...incomeRefs].some((ref) => assertions[ref].offsetEvidence !== "unconsumed")) {
      throw new Error([expenseRef, ...incomeRefs].some((ref) => assertions[ref].offsetEvidence === "consumed") ? "consumed" : "unproven");
    }
    const returnedFen = incomeRefs.reduce((sum, ref) => integer(sum + originals.get(ref)!.amountFen), 0);
    const remainingFen = originals.get(expenseRef)!.amountFen - returnedFen;
    if (remainingFen < 0) throw new Error("over_offset");
    actions.set(expenseRef, { ref: expenseRef, action: remainingFen === 0 ? "delete" : "update", amountFen: remainingFen || originals.get(expenseRef)!.amountFen });
    for (const ref of incomeRefs) actions.set(ref, { ref, action: "delete", amountFen: originals.get(ref)!.amountFen });
  }
  return [...actions.values()].sort((left, right) => left.ref.localeCompare(right.ref));
}

const empty = (): ReconciliationTotals => ({ incomeFen: 0, expenseFen: 0, netFen: 0, transactionCount: 0 });
function integer(value: number) {
  if (!Number.isSafeInteger(value)) throw new Error("Invalid reconciliation arithmetic");
  return value;
}
function add(target: ReconciliationTotals, type: "income" | "expense", amountFen: number, count: number) {
  const key = type === "income" ? "incomeFen" : "expenseFen";
  target[key] = integer(target[key] + amountFen);
  target.transactionCount = integer(target.transactionCount + count);
  target.netFen = integer(target.incomeFen - target.expenseFen);
}

export function previewReconciliation(records: ReconciliationRecord[], suggestions: ReconciliationSuggestion[], selectedIds: string[]): ReconciliationPreview {
  if (new Set(selectedIds).size !== selectedIds.length || selectedIds.length > 200 || new Set(records.map(({ ref }) => ref)).size !== records.length) throw new Error("Invalid reconciliation selection");
  const available = new Map(suggestions.map((item) => [item.id, item]));
  const originals = new Map(records.map((item) => [item.ref, item]));
  const selectedRefs = new Set<string>();
  const before = empty(), after = empty(), delta = empty();
  const days = new Map<string, ReconciliationTotals>(), months = new Map<string, ReconciliationTotals>();
  for (const id of selectedIds) {
    const item = available.get(id);
    if (!item || !item.canApply || item.applied || item.readOnlyReason !== null || !item.actions.length) throw new Error("Unavailable reconciliation suggestion");
    if (new Set(item.actions.map(({ ref }) => ref)).size !== item.actions.length || item.actions.length !== item.evidenceRefs.length) throw new Error("Invalid reconciliation actions");
    for (const change of item.actions) {
      const original = originals.get(change.ref);
      if (!original || !item.evidenceRefs.includes(change.ref) || selectedRefs.has(change.ref)) throw new Error("Overlapping reconciliation selection");
      if (!Number.isSafeInteger(original.amountFen) || original.amountFen <= 0 || original.amountFen > 2_147_483_647
        || !Number.isSafeInteger(change.amountFen) || change.amountFen <= 0 || change.amountFen > 2_147_483_647) throw new Error("Invalid reconciliation amount");
      if (!["keep", "delete", "update"].includes(change.action) || change.action === "update" && (original.type !== "expense" || change.amountFen >= original.amountFen)
        || change.action !== "update" && change.amountFen !== original.amountFen) throw new Error("Invalid reconciliation action");
      selectedRefs.add(change.ref);
      add(before, original.type, original.amountFen, 1);
      const nextAmount = change.action === "delete" ? 0 : change.amountFen;
      const nextCount = change.action === "delete" ? 0 : 1;
      add(after, original.type, nextAmount, nextCount);
      const amountDelta = nextAmount - original.amountFen, countDelta = nextCount - 1;
      add(delta, original.type, amountDelta, countDelta);
      if (amountDelta !== 0 || countDelta !== 0) {
        const date = new Date(new Date(original.occurredAt).getTime() + 8 * 3_600_000).toISOString().slice(0, 10);
        if (original.date !== date) throw new Error("Invalid reconciliation date");
        for (const [map, key] of [[days, date], [months, date.slice(0, 7)]] as const) {
          const bucket = map.get(key) ?? empty();
          add(bucket, original.type, amountDelta, countDelta); map.set(key, bucket);
        }
      }
    }
  }
  if (selectedRefs.size > 1000) throw new Error("Reconciliation selection is too large");
  const points = (map: Map<string, ReconciliationTotals>) => [...map].sort(([left], [right]) => left.localeCompare(right)).map(([key, point]) => ({ key, delta: point }));
  return { before, after, delta, days: points(days), months: points(months) };
}
