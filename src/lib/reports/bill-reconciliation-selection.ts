import { previewReconciliation } from "./bill-reconciliation-preview";
import type { ReconciliationAction, ReconciliationManualGroup, ReconciliationManualSelectionGroup, ReconciliationPreview, ReconciliationRecord, ReconciliationRetentionGroup, ReconciliationSelection, ReconciliationSuggestion } from "./bill-reconciliation-types";

const reference = /^r[1-9]\d{0,4}$/;
const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
const groupKey = (group: ReconciliationManualGroup) => JSON.stringify([group.noticeId, group.refs, group.keepRef]);
const retentionKey = (group: ReconciliationRetentionGroup) => JSON.stringify([group.noticeId, group.refs, group.keepRefs]);

export function normalizeReconciliationManualGroups(groups: readonly ReconciliationManualGroup[]): ReconciliationManualGroup[] {
  if (groups.length > 200) throw new Error("Reconciliation selection is too large");
  const participants = new Set<string>();
  const normalized = groups.map((group) => {
    if (!group || typeof group.noticeId !== "string" || !group.noticeId.length || group.noticeId.length > 128
      || !Array.isArray(group.refs) || group.refs.length < 2 || group.refs.length > 500
      || group.refs.some((ref) => typeof ref !== "string" || !reference.test(ref))
      || !group.refs.includes(group.keepRef)) throw new Error("Invalid manual reconciliation group");
    for (const ref of group.refs) {
      if (participants.has(ref)) throw new Error("Overlapping reconciliation selection");
      participants.add(ref);
    }
    return { noticeId: group.noticeId, refs: [...group.refs].sort(compare), keepRef: group.keepRef };
  });
  if (participants.size > 1000) throw new Error("Reconciliation selection is too large");
  return normalized.sort((left, right) => compare(groupKey(left), groupKey(right)));
}

export function normalizeReconciliationRetentionGroups(groups: readonly ReconciliationRetentionGroup[]): ReconciliationRetentionGroup[] {
  if (groups.length > 200) throw new Error("Reconciliation selection is too large");
  const participants = new Set<string>();
  const normalized = groups.map((group) => {
    if (!group || typeof group.noticeId !== "string" || !group.noticeId.length || group.noticeId.length > 128
      || !Array.isArray(group.refs) || group.refs.length < 2 || group.refs.length > 500
      || group.refs.some((ref) => typeof ref !== "string" || !reference.test(ref))
      || !Array.isArray(group.keepRefs) || !group.keepRefs.length || group.keepRefs.length >= group.refs.length
      || new Set(group.keepRefs).size !== group.keepRefs.length
      || group.keepRefs.some((ref) => !group.refs.includes(ref)) || "keepRef" in group) throw new Error("Invalid manual reconciliation group");
    for (const ref of group.refs) {
      if (participants.has(ref)) throw new Error("Overlapping reconciliation selection");
      participants.add(ref);
    }
    return { noticeId: group.noticeId, refs: [...group.refs].sort(compare), keepRefs: [...group.keepRefs].sort(compare) };
  });
  if (participants.size > 1000) throw new Error("Reconciliation selection is too large");
  return normalized.sort((left, right) => compare(retentionKey(left), retentionKey(right)));
}

export function normalizeReconciliationSelectionGroups(groups: readonly ReconciliationManualSelectionGroup[]): ReconciliationManualSelectionGroup[] {
  if (groups.every((group): group is ReconciliationRetentionGroup => Boolean(group && "keepRefs" in group))) return normalizeReconciliationRetentionGroups(groups);
  if (groups.some((group) => group && "keepRefs" in group)) throw new Error("Mixed reconciliation group versions");
  return normalizeReconciliationManualGroups(groups as readonly ReconciliationManualGroup[]);
}

export function reconciliationManualGroupKey(group: ReconciliationManualSelectionGroup): string {
  return "keepRefs" in group ? retentionKey(normalizeReconciliationRetentionGroups([group])[0]) : groupKey(normalizeReconciliationManualGroups([group])[0]);
}

export function deriveManualReconciliationActions(
  records: ReconciliationRecord[], suggestions: ReconciliationSuggestion[], groups: readonly ReconciliationManualSelectionGroup[],
): ReconciliationAction[] {
  const normalized = normalizeReconciliationSelectionGroups(groups);
  const originals = new Map(records.map((record) => [record.ref, record]));
  const notices = new Map(suggestions.map((suggestion) => [suggestion.id, suggestion]));
  if (originals.size !== records.length || notices.size !== suggestions.length) throw new Error("Invalid reconciliation selection");
  const actions: ReconciliationAction[] = [];
  for (const group of normalized) {
    const notice = notices.get(group.noticeId);
    if (!notice || notice.kind !== "notice" || notice.applied || group.refs.some((ref) => !notice.evidenceRefs.includes(ref))) throw new Error("Unavailable manual reconciliation notice");
    const first = originals.get(group.refs[0]);
    if (!first || !first.memberAlias || !first.ledgerAlias) throw new Error("Invalid manual reconciliation record");
    for (const ref of group.refs) {
      const original = originals.get(ref);
      if (!original || !["income", "expense"].includes(original.type)) throw new Error("Invalid manual reconciliation record");
      if (original.memberAlias !== first.memberAlias || original.ledgerAlias !== first.ledgerAlias) throw new Error("cross_scope");
      if (original.type !== first.type || original.amountFen !== first.amountFen) throw new Error("amount_mismatch");
      if (!Number.isSafeInteger(original.amountFen) || original.amountFen <= 0 || original.amountFen > 2_147_483_647) throw new Error("Invalid reconciliation amount");
      const keep = "keepRefs" in group ? group.keepRefs.includes(ref) : ref === group.keepRef;
      actions.push({ ref, action: keep ? "keep" : "delete", amountFen: original.amountFen });
    }
  }
  return actions.sort((left, right) => compare(left.ref, right.ref));
}

export function previewReconciliationSelection(
  records: ReconciliationRecord[], suggestions: ReconciliationSuggestion[], selection: ReconciliationSelection,
): ReconciliationPreview {
  if (selection.suggestionIds.length + selection.manualGroups.length > 200) throw new Error("Reconciliation selection is too large");
  if (!selection.manualGroups.length) return previewReconciliation(records, suggestions, selection.suggestionIds);
  const groups = normalizeReconciliationSelectionGroups(selection.manualGroups);
  const actions = new Map(deriveManualReconciliationActions(records, suggestions, groups).map((action) => [action.ref, action]));
  const usedIds = new Set([...suggestions.map((suggestion) => suggestion.id), ...selection.suggestionIds]);
  // Temporary suggestions reuse the existing arithmetic without changing the report or its notices.
  const manual = groups.map((group, index): ReconciliationSuggestion => {
    let id = `\u0000manual:${index}`;
    while (usedIds.has(id)) id += ":";
    usedIds.add(id);
    return { id, kind: "duplicate", title: "", reason: "", evidenceRefs: group.refs,
      confidence: "review", defaultSelected: false, canApply: true, readOnlyReason: null,
      actions: group.refs.map((ref) => actions.get(ref)!) };
  });
  return previewReconciliation(records, [...suggestions, ...manual], [...selection.suggestionIds, ...manual.map((suggestion) => suggestion.id)]);
}
