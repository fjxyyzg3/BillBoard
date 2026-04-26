type TransactionCategory = {
  id: string;
  name: string;
  type: "income" | "expense";
};

type CategoryPickerProps = {
  categories: TransactionCategory[];
  selectedType: TransactionCategory["type"];
  selectedCategoryId: string;
  onSelect: (categoryId: string) => void;
};

export type { TransactionCategory };

export function CategoryPicker({
  categories,
  selectedType,
  selectedCategoryId,
  onSelect,
}: CategoryPickerProps) {
  const availableCategories = categories.filter((category) => category.type === selectedType);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-sm font-medium text-stone-700">Category</span>
      </div>
      <input name="categoryId" readOnly required type="hidden" value={selectedCategoryId} />
      <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
        {availableCategories.map((category) => (
          <button
            className={`rounded-xl border px-3 py-3 text-sm font-medium transition ${
              selectedCategoryId === category.id
                ? "border-stone-900 bg-stone-900 text-white"
                : "border-stone-300 bg-white text-stone-700 hover:border-stone-500"
            }`}
            key={category.id}
            onClick={() => onSelect(category.id)}
            type="button"
          >
            {category.name}
          </button>
        ))}
      </div>
    </div>
  );
}
