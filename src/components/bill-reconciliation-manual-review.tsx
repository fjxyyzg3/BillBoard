"use client";

import { useId } from "react";
import { getCategoryDisplayName, getMessages, type Locale } from "@/lib/i18n";
import type { ReconciliationRetentionCandidate } from "@/lib/reports/bill-reconciliation-grouping";
import type { ReconciliationRetentionGroup } from "@/lib/reports/bill-reconciliation-types";
import styles from "./bill-reconciliation-retention.module.css";

type Props = {
  candidate: ReconciliationRetentionCandidate;
  group?: ReconciliationRetentionGroup;
  index: number;
  locale: Locale;
  locked: boolean;
  conflict: boolean;
  complete?: boolean;
  unavailable: Map<string, "handled" | "archived">;
  onChange: (group: ReconciliationRetentionGroup) => void;
};

export function ReconciliationManualReview({ candidate, group, index, locale, locked, conflict, complete = false, unavailable, onChange }: Props) {
  const messages = getMessages(locale);
  const labels = messages.billReconciliation;
  const id = useId();
  const first = candidate.records[0];
  const skipped = complete || !group || group.keepRefs.length === group.refs.length;
  const removed = group ? group.refs.length - group.keepRefs.length : 0;
  const blocked = !skipped && group?.refs.some((ref) => unavailable.has(ref));
  const zeroKept = group && !group.keepRefs.length;
  const tooLarge = !skipped && group && group.refs.length > 500;
  const error = zeroKept ? labels.retentionMinimum : blocked ? labels.manualGroupUnavailable : conflict && !skipped ? labels.selectionConflict : tooLarge ? labels.errors.TOO_LARGE : null;
  const money = (fen: number) => new Intl.NumberFormat(locale, { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(fen / 100);
  const sourceKeys = { sui_shou_ji: "suiShouJi", wechat_pay: "wechatPay", alipay: "alipay", cmb: "cmb" } as const;
  return <article className={`${styles.group} ${error ? styles.groupInvalid : ""}`} data-testid="reconciliation-retention-group" data-group-key={candidate.key} aria-labelledby={`${id}-title`}>
    <header className={styles.groupHeader}>
      <div className={styles.groupHeading}>
        <span className={styles.groupNumber} aria-hidden="true">{String(index + 1).padStart(2, "0")}</span>
        <div className={styles.groupTitle}>
          <h5 id={`${id}-title`}>{labels.retentionGroupCount(index + 1)} · {money(first.amountFen)}</h5>
          <p className={styles.groupContext}>{messages.billAnalysis[first.type]} · {first.memberLabel} · {first.ledgerLabel}</p>
        </div>
        {group && !complete ? <button type="button" className={styles.keepAll} data-testid="retention-keep-all" disabled={locked} onClick={() => onChange({ ...group, keepRefs: [...group.refs] })}>{labels.retentionKeepAll}</button> : null}
      </div>
      <p className={styles.reason} id={`${id}-reason`}>{candidate.notice.title} · {candidate.notice.reason}</p>
    </header>
    <fieldset className={styles.records} disabled={locked} aria-describedby={`${id}-reason${error ? ` ${id}-error` : ""}`}>
      <legend className="sr-only">{labels.retentionChoose}</legend>
      {candidate.records.map((row) => {
        const participating = group?.refs.includes(row.ref) ?? false;
        const checked = Boolean(participating && group?.keepRefs.includes(row.ref));
        const status = unavailable.get(row.ref);
        const sourceKey = row.source === null ? null : sourceKeys[row.source as keyof typeof sourceKeys];
        const source = sourceKey ? messages.import.sources[sourceKey] : row.source ?? labels.manual;
        const date = new Intl.DateTimeFormat(locale, { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit", ...(row.timePrecision !== "day" && !row.timeSupplemented ? { hour: "2-digit", minute: "2-digit" } as const : {}) }).format(new Date(row.occurredAt));
        return <label className={`${styles.record} ${checked ? styles.recordKept : ""} ${!participating || status ? styles.recordReadonly : ""}`} key={row.ref} data-testid={`manual-record-${row.ref}`}>
          <span className={styles.choice}>
            {participating ? <input type="checkbox" checked={checked} disabled={Boolean(status)} aria-label={`${labels.retentionKeep} · ${row.ref}`} aria-invalid={Boolean(zeroKept)} aria-describedby={error ? `${id}-error` : undefined}
              onChange={() => { if (group) onChange({ ...group, keepRefs: checked ? group.keepRefs.filter((ref) => ref !== row.ref) : [...group.keepRefs, row.ref] }); }} /> : null}
            <span data-testid={`manual-action-${row.ref}`}>{status ? status === "archived" ? labels.retentionArchived : complete && participating ? `${labels.applied} · ${checked ? labels.retentionKeep : labels.retentionDelete}` : labels.applied : participating ? checked ? labels.retentionKeep : labels.retentionDelete : labels.retentionEvidence}</span>
          </span>
          <span>
            <span className={styles.note}>{row.note ?? getCategoryDisplayName(row.categoryName, locale)}</span>
            <span className={styles.metadata}><span>{source}</span><time dateTime={row.occurredAt}>{date}</time></span>
            {row.timeSupplemented || row.timePrecision === "day" ? <span className={styles.precision}>{labels.dateOnly}</span> : row.timePrecision === "unknown" ? <span className={styles.precision}>{labels.unknownPrecision}</span> : null}
            {row.aggregated ? <span className={styles.precision}>{labels.aggregated}</span> : null}
          </span>
          <span className={styles.amount}>{row.type === "income" ? "+" : "−"}{money(row.amountFen)}<span className={styles.category}>{getCategoryDisplayName(row.categoryName, locale)}</span></span>
        </label>;
      })}
    </fieldset>
    <div className={styles.groupBottom}>
      <span>{group ? labels.retentionCounts(group.keepRefs.length, removed) : labels.noManualCandidates}</span>
      <span className={skipped ? styles.skipped : styles.effect}>{complete ? labels.applied : skipped ? group ? labels.retentionSkipped : labels.retentionEvidence : labels.retentionEffect(messages.billAnalysis[first.type], money(removed * first.amountFen))}</span>
    </div>
    {error ? <p className={styles.error} id={`${id}-error`} role="alert">{error}</p> : null}
  </article>;
}
