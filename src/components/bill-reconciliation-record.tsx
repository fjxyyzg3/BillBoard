import { getCategoryDisplayName, getMessages, type Locale } from "@/lib/i18n";
import type { ReconciliationRecord } from "@/lib/reports/bill-reconciliation-types";

export function ReconciliationRecordDetails({ row, locale }: { row: ReconciliationRecord; locale: Locale }) {
  const messages = getMessages(locale);
  const labels = messages.billReconciliation;
  const sourceKeys = { sui_shou_ji: "suiShouJi", wechat_pay: "wechatPay", alipay: "alipay", cmb: "cmb" } as const;
  const sourceKey = row.source === null ? null : sourceKeys[row.source as keyof typeof sourceKeys];
  const source = sourceKey ? messages.import.sources[sourceKey] : row.source ?? labels.manual;
  const date = new Intl.DateTimeFormat(locale, { timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
    ...(row.timePrecision !== "day" && !row.timeSupplemented ? { hour: "2-digit", minute: "2-digit" } as const : {}) }).format(new Date(row.occurredAt));
  const amount = new Intl.NumberFormat(locale, { style: "currency", currency: "CNY", minimumFractionDigits: 2, maximumFractionDigits: 2 }).format(row.amountFen / 100);
  return <div className="min-w-0 text-xs">
    <p className="break-words leading-5">{date} · {row.memberLabel} · {row.ledgerLabel}</p>
    <p className="mt-1 flex min-w-0 flex-wrap items-baseline justify-between gap-x-3 gap-y-1"><span>{getCategoryDisplayName(row.categoryName, locale)} · {messages.billAnalysis[row.type]}</span><span className="break-all font-medium tabular-nums">{amount}</span></p>
    <p className="mt-1 break-words leading-5 text-[var(--bb-muted)]">{labels.source} · {source}</p>
    {row.timeSupplemented || row.timePrecision === "day" ? <p className="mt-1 leading-5 text-[var(--bb-muted)]">{labels.dateOnly}</p> : row.timePrecision === "unknown" ? <p className="mt-1 leading-5 text-[var(--bb-muted)]">{labels.unknownPrecision}</p> : null}
    {row.aggregated ? <p className="mt-1 leading-5 text-[var(--bb-muted)]">{labels.aggregated}</p> : null}
    {row.note ? <p className="mt-2 whitespace-pre-wrap break-words leading-5">{row.note}</p> : null}
  </div>;
}
