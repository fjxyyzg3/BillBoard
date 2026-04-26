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
    <section className="rounded-2xl border border-stone-200 bg-white p-5 shadow-sm">
      <div className="space-y-1">
        <h2 className="text-lg font-semibold text-stone-900">Expense categories</h2>
        <p className="text-sm text-stone-500">Where spending is concentrated in this range.</p>
      </div>

      {items.length === 0 ? (
        <p className="mt-5 text-sm text-stone-500">No expense activity yet for the selected filters.</p>
      ) : (
        <div className="mt-5 space-y-4">
          {items.map((item) => (
            <Link
              className="block rounded-xl border border-transparent p-2 transition hover:border-stone-200 hover:bg-stone-50"
              href={getCategoryHref(item)}
              key={item.categoryId}
            >
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-medium text-stone-900">{item.categoryName}</p>
                  <p className="text-xs text-stone-500">{item.transactionCount} transactions</p>
                </div>
                <p className="text-sm font-semibold text-stone-900">{totalExpenseLabel(item.amountFen)}</p>
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
