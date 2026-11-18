"use client";

import { getLedgerDisplayName, getMessages, type Locale } from "@/lib/i18n";
import { normalizeNaturalLanguageText } from "@/lib/transactions/natural-language-protocol";
import type { EntryFeedback } from "@/lib/transactions/natural-language-controller";

export function NaturalLanguageFeedback({ feedback, id, text, locale }: { feedback: EntryFeedback | null; id?: string; text: string; locale: Locale }) {
  if (!feedback) return null;
  const labels = getMessages(locale).add.naturalLanguage;
  const result = feedback.result;
  if (result.status === "error") {
    const snapshot = feedback.snapshotText;
    const issues = snapshot !== null && snapshot === normalizeNaturalLanguageText(text)
      ? result.issues?.filter((issue) => Number.isInteger(issue.start) && Number.isInteger(issue.end) &&
        issue.start >= 0 && issue.end > issue.start && issue.end <= snapshot.length && typeof labels.issues[issue.code] === "string") : null;
    return <div className="space-y-2 text-sm text-red-700" id={id} role="alert">
      {feedback.target ? <p className="text-xs text-[var(--bb-muted)]">{getMessages(locale).ledgers.target} · {getLedgerDisplayName(feedback.target.ledgerName, locale)}</p> : null}
      <p>{labels.errors[result.code]}</p>
      {issues?.length ? <ul className="space-y-1">{issues.map((issue, index) =>
        <li className="break-words" key={`${issue.code}-${issue.start}-${index}`}>
          {labels.issues[issue.code]}：<q className="whitespace-pre-wrap">{snapshot!.slice(issue.start, issue.end)}</q>
        </li>)}</ul> : null}
    </div>;
  }
  if (result.status !== "success") return null;
  const formatter = new Intl.NumberFormat(locale, { minimumFractionDigits: 2, maximumFractionDigits: 2 });
  return <div className="space-y-1" role="status">
    {feedback.target ? <p className="text-xs text-[var(--bb-muted)]">{getMessages(locale).ledgers.target} · {getLedgerDisplayName(feedback.target.ledgerName, locale)}</p> : null}
    <p className="text-sm font-semibold text-[var(--bb-income-ink)]">
    {labels.success(result.count, result.incomeCount ? formatter.format(result.incomeAmountFen / 100) : null,
      result.expenseCount ? formatter.format(result.expenseAmountFen / 100) : null)}
    </p>
  </div>;
}
