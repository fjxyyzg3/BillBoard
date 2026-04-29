import { getCategoryDisplayName, type Locale, type Messages } from "@/lib/i18n";

type TransactionCategory = {
  id: string;
  name: string;
  type: "income" | "expense";
};

type CategoryPickerProps = {
  categories: TransactionCategory[];
  label: Messages["common"]["category"];
  locale: Locale;
  selectedType: TransactionCategory["type"];
  selectedCategoryId: string;
  onSelect: (categoryId: string) => void;
};

export type { TransactionCategory };

export function CategoryPicker({
  categories,
  label,
  locale,
  selectedType,
  selectedCategoryId,
  onSelect,
}: CategoryPickerProps) {
  const availableCategories = categories.filter((category) => category.type === selectedType);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-stone-700">{label}</span>
      </div>
      <input name="categoryId" readOnly required type="hidden" value={selectedCategoryId} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {availableCategories.map((category) => (
          <button
            className={`min-h-12 rounded-2xl border px-3 py-3 text-sm font-semibold transition ${
              selectedCategoryId === category.id
                ? "border-[var(--ios-blue)] bg-[var(--ios-blue-soft)] text-[var(--ios-blue)] shadow-[0_8px_22px_rgba(0,122,255,0.12)]"
                : "border-black/10 bg-white text-[var(--ios-text)] hover:border-black/20 hover:bg-black/[0.03]"
            }`}
            key={category.id}
            onClick={() => onSelect(category.id)}
            type="button"
          >
            {getCategoryDisplayName(category.name, locale)}
          </button>
        ))}
      </div>
    </div>
  );
}
