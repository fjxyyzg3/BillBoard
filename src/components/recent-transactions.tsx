import Link from "next/link";
import type { ReportTransaction } from "@/lib/reports/aggregate";
import { formatFen } from "@/lib/money";

type RecentTransactionsProps = {
  getRecordHref: (transaction: ReportTransaction) => string;
  items: ReportTransaction[];
};

function getNoteExcerpt(note: string | null) {
  if (!note) {
    return "No note";
  }

  if (note.length <= 64) {
    return note;
  }

  return `${note.slice(0, 61)}...`;
}

function formatOccurredAt(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    month: "short",
    timeZone: "Asia/Shanghai",
  }).format(date);
}

export function RecentTransactions({ getRecordHref, items }: RecentTransactionsProps) {
  return (
    <section className="ios-panel overflow-hidden">
      <div className="border-b border-stone-100 px-5 py-4">
        <h2 className="text-lg font-semibold text-stone-900">Recent transactions</h2>
        <p className="text-sm text-stone-500">Jump straight into the records that shaped this view.</p>
      </div>

      {items.length === 0 ? (
        <div className="px-5 py-6">
          <p className="text-sm text-stone-500">No transactions yet for the selected filters.</p>
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
                      {transaction.type === "income" ? "Income" : "Expense"}
                    </span>
                    <span className="min-w-0 text-sm text-stone-600">{transaction.categoryName}</span>
                  </div>
                  <p className="min-w-0 text-sm text-stone-600">{getNoteExcerpt(transaction.note)}</p>
                  <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
                    <span>Actor: {transaction.actorMemberName}</span>
                    <span>Created by: {transaction.createdByMemberName}</span>
                  </div>
                </div>
                <p className="shrink-0 text-sm text-stone-500">{formatOccurredAt(transaction.occurredAt)}</p>
              </Link>
            </li>
          ))}
        </ul>
      )}
    </section>
  );
}
