type TransactionCategory = {
  id: string;
  name: string;
  type: "income" | "expense";
};

type CategoryPickerProps = {
  categories: TransactionCategory[];
  selectedType: TransactionCategory["type"];
};

export type { TransactionCategory };

export function CategoryPicker({
  categories,
  selectedType,
}: CategoryPickerProps) {
  const availableCategories = categories.filter((category) => category.type === selectedType);
  const defaultCategoryId = availableCategories[0]?.id ?? "";

  return (
    <label className="space-y-2">
      <span className="text-sm font-medium text-stone-700">Category</span>
      <select
        className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-stone-500"
        defaultValue={defaultCategoryId}
        key={selectedType}
        name="categoryId"
        required
      >
        {availableCategories.map((category) => (
          <option key={category.id} value={category.id}>
            {category.name}
          </option>
        ))}
      </select>
    </label>
  );
}
