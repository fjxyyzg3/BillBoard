import { createHash } from "node:crypto";
import { getCategoryDisplayName } from "@/lib/i18n";
import type { BillReconciliationContent, BillReconciliationSnapshot, ReconciliationAction, ReconciliationRecord, ReconciliationSourceRow, ReconciliationSuggestion } from "./bill-reconciliation-types";
import {
  BILL_RECONCILIATION_SCHEMA_VERSION, BillReconciliationError, MAX_BILL_RECONCILIATION_BATCHES, MAX_BILL_RECONCILIATION_BATCH_ROWS,
  MAX_BILL_RECONCILIATION_BODY_BYTES, MAX_BILL_RECONCILIATION_CONTENT_BYTES, MAX_BILL_RECONCILIATION_INPUT_BYTES,
  MAX_BILL_RECONCILIATION_ROWS, MAX_BILL_RECONCILIATION_RESULT_BYTES, MAX_BILL_RECONCILIATION_RESULT_ROWS, MAX_BILL_RECONCILIATION_SUGGESTIONS,
  billReconciliationBytes, billReconciliationSnapshotSchema, parseBillReconciliationContent, reconciliationShanghaiDate,
  validateBillReconciliationRequest, validateBillReconciliationResponse,
  type BillReconciliationAgentRequest, type BillReconciliationAgentResponse, type BillReconciliationProposal,
} from "./bill-reconciliation-protocol";
import { canonicalReconciliationOffset, deriveReconciliationActions, hasReconciliationMatterEvidence, reconciliationMatter, reconciliationNoteIdentifiers } from "./bill-reconciliation-preview";

export type PreparedBillReconciliation = Omit<BillReconciliationSnapshot, "rows"> & {
  inputHash: string;
  batches: BillReconciliationAgentRequest[];
  records: ReconciliationRecord[];
  assertions: Record<string, ReconciliationSourceRow>;
};

function fail(code: "INVALID" | "TOO_LARGE" | "NO_DATA" | "INVALID_RESPONSE"): never { throw new BillReconciliationError(code); }
const signature = (group: Pick<BillReconciliationProposal, "duplicateGroups" | "offset" | "evidenceRefs">) => JSON.stringify({
  duplicateGroups: group.duplicateGroups.map((refs) => [...refs].sort()).sort((left, right) => left.join().localeCompare(right.join())),
  offset: group.offset ? { ...group.offset, incomeRefs: [...group.offset.incomeRefs].sort() } : null,
  evidenceRefs: [...group.evidenceRefs].sort(),
});

export function prepareBillReconciliation(input: BillReconciliationSnapshot): PreparedBillReconciliation {
  if (input.rows.length > MAX_BILL_RECONCILIATION_ROWS || billReconciliationBytes(input) > MAX_BILL_RECONCILIATION_CONTENT_BYTES) fail("TOO_LARGE");
  let snapshot: BillReconciliationSnapshot;
  try { snapshot = billReconciliationSnapshotSchema.parse(input); } catch { fail("INVALID"); }
  if (!snapshot.rows.length) fail("NO_DATA");
  const sources = [...snapshot.rows].sort((left, right) => new Date(left.occurredAt).getTime() - new Date(right.occurredAt).getTime() || left.id.localeCompare(right.id));
  if (new Set(sources.map(({ id }) => id)).size !== sources.length) fail("INVALID");
  const aliases = (values: string[], prefix: string) => new Map([...new Set(values)].sort().map((value, index) => [value, `${prefix}${index + 1}`]));
  const members = aliases(sources.map(({ actorMemberId }) => actorMemberId), "m"), ledgers = aliases(sources.map(({ ledgerId }) => ledgerId), "l");
  const identities = aliases(sources.flatMap((source) => source.source && source.sourceFingerprint ? [JSON.stringify([source.source, source.sourceFingerprint])] : []), "s");
  const records: ReconciliationRecord[] = sources.map((source, index) => ({ ref: `r${index + 1}`, occurredAt: source.occurredAt,
    date: reconciliationShanghaiDate(source.occurredAt), type: source.type === "INCOME" ? "income" : "expense", amountFen: source.amountFen,
    categoryName: getCategoryDisplayName(source.categoryName, snapshot.locale), memberLabel: source.memberLabel, ledgerLabel: source.ledgerLabel,
    memberAlias: members.get(source.actorMemberId)!, ledgerAlias: ledgers.get(source.ledgerId)!, note: source.note, source: source.source,
    timePrecision: source.timePrecision, timeSupplemented: source.timeSupplemented, aggregated: source.aggregated,
  }));
  if (records.some(({ date }) => date < snapshot.range.from || date > snapshot.range.to)) fail("INVALID");
  const assertions = Object.fromEntries(records.map((record, index) => [record.ref, sources[index]]));
  const wireRows: BillReconciliationAgentRequest["rows"] = records.map(({ memberLabel: _memberLabel, ledgerLabel: _ledgerLabel, ...record }, index) => ({
    ...record, occurredAt: new Date(new Date(record.occurredAt).getTime() + 8 * 3_600_000).toISOString().replace("Z", "+08:00"),
    source: sourceLabel(record.source), sourceIdentityAlias: sources[index].source && sources[index].sourceFingerprint
      ? identities.get(JSON.stringify([sources[index].source, sources[index].sourceFingerprint]))! : null,
    offsetEvidence: sources[index].offsetEvidence,
  }));
  const base = { schemaVersion: BILL_RECONCILIATION_SCHEMA_VERSION, locale: snapshot.locale, range: snapshot.range, snapshotAt: snapshot.snapshotAt };
  const make = (rows: typeof wireRows, stage: BillReconciliationAgentRequest["stage"], index = 24) => ({ ...base, stage, batchId: `b${index}`, batchCount: 24, rows });
  const batches: Array<{ stage: BillReconciliationAgentRequest["stage"]; rows: typeof wireRows }> = [];
  let current: typeof wireRows = [];
  let currentBytes = 0;
  const contextEnvelopeBytes = billReconciliationBytes(make([], "context"));
  for (const record of wireRows) {
    const bytes = billReconciliationBytes(record);
    if (contextEnvelopeBytes + bytes > MAX_BILL_RECONCILIATION_BODY_BYTES) fail("TOO_LARGE");
    if (current.length && (current.length >= MAX_BILL_RECONCILIATION_BATCH_ROWS || contextEnvelopeBytes + currentBytes + bytes + current.length > MAX_BILL_RECONCILIATION_BODY_BYTES)) {
      batches.push({ stage: "context", rows: current }); current = []; currentBytes = 0;
    }
    current.push(record); currentBytes += bytes;
  }
  if (current.length) batches.push({ stage: "context", rows: current });
  const owners = new Map(batches.flatMap((batch, index) => batch.rows.map((item) => [item.ref, index] as const)));
  const byRef = new Map(wireRows.map((item) => [item.ref, item]));
  const candidateGroups = crossBatchCandidates(records, assertions, owners);
  current = [];
  for (const refs of candidateGroups) {
    const group = refs.map((ref) => byRef.get(ref)!);
    if (group.length > MAX_BILL_RECONCILIATION_BATCH_ROWS || billReconciliationBytes(make(group, "candidate")) > MAX_BILL_RECONCILIATION_BODY_BYTES) fail("TOO_LARGE");
    if (current.length && (current.length + group.length > MAX_BILL_RECONCILIATION_BATCH_ROWS
      || billReconciliationBytes(make([...current, ...group], "candidate")) > MAX_BILL_RECONCILIATION_BODY_BYTES)) {
      batches.push({ stage: "candidate", rows: current }); current = [];
    }
    current.push(...group);
  }
  if (current.length) batches.push({ stage: "candidate", rows: current });
  if (batches.length > MAX_BILL_RECONCILIATION_BATCHES) fail("TOO_LARGE");
  const validated = batches.map((batch, index) => validateBillReconciliationRequest({ ...base, ...batch, batchId: `b${index + 1}`, batchCount: batches.length }));
  if (validated.reduce((sum, batch) => sum + billReconciliationBytes(batch), 2 + Math.max(0, validated.length - 1)) > MAX_BILL_RECONCILIATION_INPUT_BYTES) fail("TOO_LARGE");
  return { scope: snapshot.scope, locale: snapshot.locale, range: snapshot.range, snapshotAt: snapshot.snapshotAt,
    inputHash: createHash("sha256").update(JSON.stringify(snapshot)).digest("hex"), batches: validated, records, assertions };
}

function sourceLabel(source: string | null) { return source === null || ["cmb", "alipay", "wechat_pay", "sui_shou_ji"].includes(source) ? source : "other"; }

function crossBatchCandidates(records: ReconciliationRecord[], assertions: Record<string, ReconciliationSourceRow>, owners: Map<string, number>): string[][] {
  const indexes = new Map<string, string[]>();
  const rowByRef = new Map(records.map((item) => [item.ref, item]));
  const append = (key: string, ref: string) => { const refs = indexes.get(key) ?? []; refs.push(ref); indexes.set(key, refs); };
  for (const record of records) {
    const source = assertions[record.ref], matter = reconciliationMatter(record.note);
    append(`duplicate:${record.type}:${record.amountFen}:${matter || record.date}`, record.ref);
    if (source.source && source.sourceFingerprint) append(`source:${source.source}:${source.sourceFingerprint}`, record.ref);
    if (matter.length >= 4) append(`matter:${matter}`, record.ref);
    for (const id of reconciliationNoteIdentifiers(record.note)) append(`identifier:${id}`, record.ref);
  }
  const parent = new Map(records.map(({ ref }) => [ref, ref]));
  const find = (ref: string): string => { const current = parent.get(ref)!; if (ref === current) return ref; const root = find(current); parent.set(ref, root); return root; };
  const involved = new Set<string>();
  for (const [key, refs] of indexes) {
    if (refs.length < 2 || key.startsWith("matter:") && new Set(refs.map((ref) => rowByRef.get(ref)!.type)).size < 2) continue;
    if (refs.length > MAX_BILL_RECONCILIATION_BATCH_ROWS) fail("TOO_LARGE");
    for (const ref of refs) { involved.add(ref); parent.set(find(ref), find(refs[0])); }
  }
  const groups = new Map<string, string[]>();
  for (const ref of involved) { const root = find(ref), refs = groups.get(root) ?? []; refs.push(ref); groups.set(root, refs); }
  const result: string[][] = [];
  for (const refs of groups.values()) {
    if (refs.length > MAX_BILL_RECONCILIATION_BATCH_ROWS) fail("TOO_LARGE");
    if (new Set(refs.map((ref) => owners.get(ref))).size > 1) result.push(refs.sort((left, right) => Number(left.slice(1)) - Number(right.slice(1))));
  }
  return result.sort((left, right) => Number(left[0].slice(1)) - Number(right[0].slice(1)));
}

function coalesceProposals(values: BillReconciliationProposal[]): BillReconciliationProposal[] {
  const exact = new Map<string, BillReconciliationProposal>();
  for (const group of values) {
    const key = signature(group), previous = exact.get(key);
    if (!previous) exact.set(key, group);
    else if (group.confidence !== "high") previous.confidence = "review";
  }
  const groups = [...exact.values()];
  const duplicates = groups.filter((group) => !group.offset && group.duplicateGroups.length && group.kind !== "notice");
  const consumed = new Set<BillReconciliationProposal>();
  const output: BillReconciliationProposal[] = [];
  const offsets = new Map<string, BillReconciliationProposal>();
  for (const group of groups) {
    if (!group.offset || group.kind === "notice") continue;
    const merged: BillReconciliationProposal = { ...group, evidenceRefs: [...group.evidenceRefs], duplicateGroups: [...group.duplicateGroups], offset: { ...group.offset, incomeRefs: [...group.offset.incomeRefs] } };
    let changed = true;
    while (changed) {
      changed = false;
      for (const duplicate of duplicates) {
        if (duplicate.duplicateGroups.every((candidate) => merged.duplicateGroups.some((set) => JSON.stringify([...candidate].sort()) === JSON.stringify([...set].sort())))) continue;
        if (duplicate.evidenceRefs.some((ref) => merged.evidenceRefs.includes(ref))) {
          merged.duplicateGroups.push(...duplicate.duplicateGroups);
          merged.evidenceRefs = [...new Set([...merged.evidenceRefs, ...duplicate.evidenceRefs])];
          merged.confidence = merged.confidence === "high" && duplicate.confidence === "high" ? "high" : "review";
          consumed.add(duplicate); changed = true;
        }
      }
    }
    const relatedExpenses = new Set([merged.offset!.expenseRef]);
    let expenseSetChanged = true;
    while (expenseSetChanged) {
      const before = relatedExpenses.size;
      for (const duplicate of merged.duplicateGroups) if (duplicate.some((ref) => relatedExpenses.has(ref))) for (const ref of duplicate) relatedExpenses.add(ref);
      expenseSetChanged = relatedExpenses.size !== before;
    }
    const key = [...relatedExpenses].sort()[0];
    const existing = offsets.get(key);
    if (!existing) offsets.set(key, merged);
    else {
      existing.evidenceRefs = [...new Set([...existing.evidenceRefs, ...merged.evidenceRefs])];
      existing.duplicateGroups = [...new Map([...existing.duplicateGroups, ...merged.duplicateGroups].map((refs) => [JSON.stringify([...refs].sort()), refs])).values()];
      existing.offset!.incomeRefs = [...new Set([...existing.offset!.incomeRefs, ...merged.offset!.incomeRefs])];
      if (existing.offset!.kind !== merged.offset!.kind) existing.offset!.kind = "mixed";
      existing.confidence = existing.confidence === "high" && merged.confidence === "high" ? "high" : "review";
    }
  }
  output.push(...offsets.values());
  for (const group of groups) if ((!group.offset || group.kind === "notice") && !consumed.has(group)) output.push(group);
  return output;
}

function sameSourceIdentity(refs: string[], assertions: Record<string, ReconciliationSourceRow>): boolean {
  const first = assertions[refs[0]];
  return first.source !== null && first.sourceFingerprint !== null && refs.every((ref) => assertions[ref].source === first.source && assertions[ref].sourceFingerprint === first.sourceFingerprint);
}
function precise(ref: string, assertions: Record<string, ReconciliationSourceRow>) {
  const source = assertions[ref]; return ["second", "minute"].includes(source.timePrecision) && !source.timeSupplemented && !source.aggregated;
}
function distinctSourceIdentities(refs: string[], assertions: Record<string, ReconciliationSourceRow>) {
  const sources = new Map<string, Set<string>>();
  for (const ref of refs) { const source = assertions[ref]; if (!source.source || !source.sourceFingerprint) continue;
    const identities = sources.get(source.source) ?? new Set(); identities.add(source.sourceFingerprint); sources.set(source.source, identities); }
  return [...sources.values()].some((set) => set.size > 1);
}
function sharedPaymentIdentity(refs: string[], records: Map<string, ReconciliationRecord>) {
  const first = new Set(reconciliationNoteIdentifiers(records.get(refs[0])!.note, true));
  return [...first].some((id) => refs.every((ref) => reconciliationNoteIdentifiers(records.get(ref)!.note, true).includes(id)));
}
function highDuplicate(refs: string[], prepared: PreparedBillReconciliation, records: Map<string, ReconciliationRecord>) {
  if (distinctSourceIdentities(refs, prepared.assertions)) return false;
  if (sameSourceIdentity(refs, prepared.assertions) || sharedPaymentIdentity(refs, records)) return true;
  if (!refs.every((ref) => precise(ref, prepared.assertions))) return false;
  const unit = refs.some((ref) => prepared.assertions[ref].timePrecision === "minute") ? 60_000 : 1000;
  const time = Math.floor(new Date(records.get(refs[0])!.occurredAt).getTime() / unit);
  const matter = reconciliationMatter(records.get(refs[0])!.note);
  return matter.length >= 6 && refs.every((ref) => Math.floor(new Date(records.get(ref)!.occurredAt).getTime() / unit) === time
    && reconciliationMatter(records.get(ref)!.note) === matter && hasReconciliationMatterEvidence(records.get(refs[0])!, records.get(ref)!));
}

function makeSuggestion(group: BillReconciliationProposal, prepared: PreparedBillReconciliation, id: string): ReconciliationSuggestion {
  const byRef = new Map(prepared.records.map((item) => [item.ref, item]));
  const refs = [...new Set(group.evidenceRefs)].sort();
  const keep = refs.map((ref) => ({ ref, action: "keep" as const, amountFen: byRef.get(ref)!.amountFen }));
  const relations = { duplicateGroups: group.duplicateGroups, offset: group.offset };
  let readOnlyReason: string | null = group.kind === "notice" ? "unsupported" : null;
  let actions: ReconciliationAction[] = keep;
  if (!readOnlyReason) {
    try { actions = deriveReconciliationActions(prepared.records, prepared.assertions, relations); }
    catch (error) { readOnlyReason = error instanceof Error && ["cross_scope", "archived", "amount_mismatch", "unproven", "consumed", "over_offset", "unsupported"].includes(error.message) ? error.message : "unproven"; }
  }
  let high = readOnlyReason === null && group.confidence === "high" && group.duplicateGroups.every((duplicates) => highDuplicate(duplicates, prepared, byRef));
  const actualOffset = group.offset && readOnlyReason === null ? canonicalReconciliationOffset(prepared.records, prepared.assertions, relations) : null;
  if (actualOffset) {
    const expense = byRef.get(actualOffset.expenseRef)!;
    for (const ref of actualOffset.incomeRefs) {
      const income = byRef.get(ref)!;
      high &&= income.date > expense.date || income.date === expense.date
        && precise(expense.ref, prepared.assertions) && precise(ref, prepared.assertions)
        && new Date(income.occurredAt).getTime() >= new Date(expense.occurredAt).getTime();
      const candidates = prepared.records.filter((item) => item.type === "expense" && item.memberAlias === expense.memberAlias && item.ledgerAlias === expense.ledgerAlias
        && item.amountFen >= income.amountFen && hasReconciliationMatterEvidence(item, income));
      const represented = new Set(actualOffset.duplicateExpenseRefs);
      high &&= candidates.every((item) => represented.has(item.ref));
    }
  }
  const kind = group.offset ? group.duplicateGroups.length || group.offset.kind === "mixed" ? "combined" : group.offset.kind : group.kind === "notice" ? "notice" : "duplicate";
  return { id, kind, title: group.title, reason: group.reason, evidenceRefs: refs, confidence: high && !readOnlyReason ? "high" : "review",
    canApply: readOnlyReason === null, defaultSelected: high && readOnlyReason === null, readOnlyReason, actions, ...(readOnlyReason ? {} : { relations }) };
}

export function buildBillReconciliationContent(prepared: PreparedBillReconciliation, results: BillReconciliationAgentResponse[]): BillReconciliationContent {
  if (results.length !== prepared.batches.length) fail("INVALID_RESPONSE");
  const proposals = prepared.batches.flatMap((batch, index) => validateBillReconciliationResponse(batch, results[index]).groups);
  const groups = coalesceProposals(proposals);
  if (groups.length > MAX_BILL_RECONCILIATION_SUGGESTIONS) fail("TOO_LARGE");
  const suggestions = groups.map((group, index) => makeSuggestion(group, prepared, `s${index + 1}`));
  const owners = new Map<string, ReconciliationSuggestion[]>();
  for (const item of suggestions) if (item.canApply) for (const ref of item.evidenceRefs) { const list = owners.get(ref) ?? []; list.push(item); owners.set(ref, list); }
  for (const overlapping of owners.values()) if (overlapping.length > 1) for (const item of overlapping) { item.defaultSelected = false; item.confidence = "review"; }
  const used = new Set(suggestions.flatMap(({ evidenceRefs }) => evidenceRefs));
  if (used.size > MAX_BILL_RECONCILIATION_RESULT_ROWS) fail("TOO_LARGE");
  const records = prepared.records.filter(({ ref }) => used.has(ref));
  if (billReconciliationBytes({ purpose: "reconciliation", version: 1, locale: prepared.locale, range: prepared.range, snapshotAt: prepared.snapshotAt, records, suggestions }) > MAX_BILL_RECONCILIATION_RESULT_BYTES) fail("TOO_LARGE");
  return parseBillReconciliationContent({ purpose: "reconciliation", version: 1, locale: prepared.locale, range: prepared.range, snapshotAt: prepared.snapshotAt,
    records, suggestions, assertions: Object.fromEntries([...used].map((ref) => [ref, prepared.assertions[ref]])) });
}
