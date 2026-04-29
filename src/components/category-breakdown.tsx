import Link from "next/link";
import { formatLocaleNumber, getCategoryDisplayName, type Locale } from "@/lib/i18n";

type CategoryBreakdownItem = {
  amountFen: number;
  categoryId: string;
  categoryName: string;
  share: number;
  transactionCount: number;
};

type CategoryBreakdownProps = {
  getCategoryHref: (item: CategoryBreakdownItem) => string;
  items: CategoryBreakdownItem[];
  labels: {
    description: string;
    empty: string;
    title: string;
    transactionCount: (countLabel: string, count: number) => string;
  };
  locale: Locale;
  totalExpenseLabel: (amountFen: number) => string;
};

export function CategoryBreakdown({
  getCategoryHref,
  items,
  labels,
  locale,
  totalExpenseLabel,
}: CategoryBreakdownProps) {
  return (
    <section className="ios-panel p-5 min-w-0">
      <div className="min-w-0 space-y-1">
        <h2 className="text-lg font-semibold text-stone-900">{labels.title}</h2>
        <p className="text-sm text-stone-500">{labels.description}</p>
      </div>

      {items.length === 0 ? (
        <p className="mt-5 text-sm text-stone-500">{labels.empty}</p>
      ) : (
        <div className="mt-5 space-y-4">
          {items.map((item) => (
            <Link
              className="block min-w-0 rounded-xl border border-transparent p-2 transition hover:border-black/10 hover:bg-black/[0.03]"
              href={getCategoryHref(item)}
              key={item.categoryId}
            >
              <div className="flex min-w-0 items-center justify-between gap-3">
                <div className="min-w-0">
                  <p className="text-sm font-medium text-stone-900">
                    {getCategoryDisplayName(item.categoryName, locale)}
                  </p>
                  <p className="text-xs text-stone-500">
                    {labels.transactionCount(
                      formatLocaleNumber(item.transactionCount, locale),
                      item.transactionCount,
                    )}
                  </p>
                </div>
                <p className="shrink-0 text-sm font-semibold text-stone-900">
                  {totalExpenseLabel(item.amountFen)}
                </p>
              </div>
              <div className="mt-2 h-2 rounded-full bg-stone-100">
                <div
                  className="h-2 rounded-full bg-stone-900"
                  style={{ width: `${Math.max(item.share * 100, 4)}%` }}
                />
              </div>
            </Link>
          ))}
        </div>
      )}
    </section>
  );
}
