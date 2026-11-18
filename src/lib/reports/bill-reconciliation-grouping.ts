import type { BillReconciliationReportDto, ReconciliationRecord, ReconciliationRetentionGroup, ReconciliationSuggestion } from "./bill-reconciliation-types";

export type ReconciliationRetentionCandidate = {
  key: string;
  notice: ReconciliationSuggestion;
  records: ReconciliationRecord[];
  group: ReconciliationRetentionGroup;
};

const compare = (left: string, right: string) => left < right ? -1 : left > right ? 1 : 0;
export const compareReconciliationRecords = (left: ReconciliationRecord, right: ReconciliationRecord) =>
  Date.parse(left.occurredAt) - Date.parse(right.occurredAt) || Number(left.ref.slice(1)) - Number(right.ref.slice(1));

function key(noticeId: string, row: ReconciliationRecord) {
  return JSON.stringify([noticeId, row.ledgerAlias, row.memberAlias, row.type, row.amountFen]);
}

export function reconciliationRetentionGroupKey(group: ReconciliationRetentionGroup, records: Map<string, ReconciliationRecord>): string {
  const first = records.get(group.refs[0]);
  return first ? key(group.noticeId, first) : JSON.stringify([group.noticeId, group.refs]);
}

export function reconciliationRetentionDecisionKey(group: ReconciliationRetentionGroup): string {
  return JSON.stringify([group.noticeId, [...group.refs].sort(compare), [...group.keepRefs].sort(compare)]);
}

export function buildReconciliationRetentionCandidates(report: BillReconciliationReportDto): ReconciliationRetentionCandidate[] {
  const records = new Map((report.records ?? []).map((row) => [row.ref, row]));
  const unavailable = new Set(report.manualReview?.records.filter((row) => row.status !== "available").map((row) => row.ref));
  const candidates: ReconciliationRetentionCandidate[] = [];
  for (const notice of report.suggestions) {
    if (notice.kind !== "notice") continue;
    const buckets = new Map<string, ReconciliationRecord[]>();
    for (const ref of notice.evidenceRefs) {
      const row = records.get(ref);
      if (!row) continue;
      const groupKey = key(notice.id, row);
      const bucket = buckets.get(groupKey) ?? [];
      bucket.push(row);
      buckets.set(groupKey, bucket);
    }
    for (const [groupKey, rows] of buckets) {
      rows.sort(compareReconciliationRecords);
      const refs = rows.filter((row) => !notice.applied && !unavailable.has(row.ref)).map((row) => row.ref);
      candidates.push({ key: groupKey, notice, records: rows, group: { noticeId: notice.id, refs, keepRefs: refs.length ? [refs[0]] : [] } });
    }
  }
  return candidates.sort((left, right) => compareReconciliationRecords(left.records[0], right.records[0])
    || compare(left.notice.id, right.notice.id) || compare(left.key, right.key));
}

export function defaultReconciliationRetentionGroups(report: BillReconciliationReportDto): ReconciliationRetentionGroup[] {
  return buildReconciliationRetentionCandidates(report).filter((candidate) => candidate.group.refs.length >= 2).map(({ group }) => group);
}

export function activeReconciliationRetentionGroups(groups: readonly ReconciliationRetentionGroup[]): ReconciliationRetentionGroup[] {
  return groups.filter((group) => group.keepRefs.length !== group.refs.length);
}
