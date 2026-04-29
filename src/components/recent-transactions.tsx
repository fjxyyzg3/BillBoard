import Link from "next/link";
import type { ReportTransaction } from "@/lib/reports/aggregate";
import { formatLocaleDateTime, getCategoryDisplayName, type Locale } from "@/lib/i18n";
import { formatFen } from "@/lib/money";

type RecentTransactionsProps = {
  getRecordHref: (transaction: ReportTransaction) => string;
  items: ReportTransaction[];
  labels: {
    common: {
      actor: string;
      createdBy: string;
      expense: string;
      income: string;
      noNote: string;
    };
    recent: {
      description: string;
      empty: string;
      title: string;
    };
  };
  locale: Locale;
};

function getNoteExcerpt(note: string | null, noNoteLabel: string) {
  if (!note) {
    return noNoteLabel;
  }

  if (note.length <= 64) {
    return note;
  }

  return `${note.slice(0, 61)}...`;
}

export function RecentTransactions({ getRecordHref, items, labels, locale }: RecentTransactionsProps) {
  return (
    <section className="ios-panel overflow-hidden">
      <div className="border-b border-stone-100 px-5 py-4">
        <h2 className="text-lg font-semibold text-stone-900">{labels.recent.title}</h2>
        <p className="text-sm text-stone-500">{labels.recent.description}</p>
      </div>

      {items.length === 0 ? (
        <div className="px-5 py-6">
          <p className="text-sm text-stone-500">{labels.recent.empty}</p>
        </div>
      ) : (
        <ul className="divide-y divide-stone-100">
          {items.map((transaction) => (
            <li key={transaction.id}>
              <Link
                className="flex min-w-0 flex-col gap-3 px-5 py-4 transition hover:bg-black/[0.03] sm:flex-row sm:items-start sm:justify-between"
                href={getRecordHref(transaction)}
                scroll={false}
              >
                <div className="min-w-0 space-y-2">
                  <div className="flex min-w-0 flex-wrap items-center gap-2">
                    <span className="ios-amount text-base text-stone-900">
                      {transaction.type === "income" ? "+" : "-"}
                      {formatFen(transaction.amountFen)}
                    </span>
                    <span
                      className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                        transaction.type === "income"
                          ? "bg-emerald-50 text-emerald-700"
                          : "bg-stone-100 text-stone-700"
                      }`}
                    >
                      {transaction.type === "income" ? labels.common.income : labels.common.expense}
                    </span>
                    <span className="min-w-0 text-sm text-stone-600">
                      {getCategoryDisplayName(transaction.categoryName, locale)}
                    </span>
                  </div>
                  <p className="min-w-0 text-sm text-stone-600">
                    {getNoteExcerpt(transaction.note, labels.common.noNote)}
                  </p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
                    <span>
                      {labels.common.actor}: {transaction.actorMemberName}
                    </span>
                    <span>
                      {labels.common.createdBy}: {transaction.createdByMemberName}
                    </span>
                  </div>
                </div>
                <p className="shrink-0 text-sm text-stone-500">
                  {formatLocaleDateTime(transaction.occurredAt, locale)}
                </p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
