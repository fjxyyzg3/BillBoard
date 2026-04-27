import Link from "next/link";

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
  totalExpenseLabel: (amountFen: number) => string;
};

export function CategoryBreakdown({
  getCategoryHref,
  items,
  totalExpenseLabel,
}: CategoryBreakdownProps) {
  return (
    <section className="ios-panel p-5 min-w-0">
      <div className="min-w-0 space-y-1">
        <h2 className="text-lg font-semibold text-stone-900">Expense categories</h2>
        <p className="text-sm text-stone-500">Where spending is concentrated in this range.</p>
      </div>

      {items.length === 0 ? (
        <p className="mt-5 text-sm text-stone-500">No expense activity yet for the selected filters.</p>
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
                  <p className="text-sm font-medium text-stone-900">{item.categoryName}</p>
                  <p className="text-xs text-stone-500">{item.transactionCount} transactions</p>
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
