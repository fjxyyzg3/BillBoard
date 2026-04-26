"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";

type CategoryOption = {
  id: string;
  name: string;
  type: "income" | "expense";
};

type RecordsFilterBarProps = {
  categories: CategoryOption[];
};

function parseType(value: string | null): CategoryOption["type"] | undefined {
  if (value === "income" || value === "expense") {
    return value;
  }

  return undefined;
}

export function RecordsFilterBar({ categories }: RecordsFilterBarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedType = parseType(searchParams.get("type"));
  const selectedCategoryId = searchParams.get("category") ?? "";
  const visibleCategories = categories.filter(
    (category) => !selectedType || category.type === selectedType,
  );

  function replaceFilters(nextType: string, nextCategoryId: string) {
    const params = new URLSearchParams(searchParams.toString());

    params.delete("record");

    if (nextType) {
      params.set("type", nextType);
    } else {
      params.delete("type");
    }

    if (nextCategoryId) {
      params.set("category", nextCategoryId);
    } else {
      params.delete("category");
    }

    const query = params.toString();

    router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
  }

  return (
    <div className="grid gap-3 sm:grid-cols-2">
      <label className="space-y-2">
        <span className="text-sm font-medium text-stone-700">Type</span>
        <select
          className="w-full rounded-2xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900"
          onChange={(event) => {
            const nextType = parseType(event.target.value) ?? "";
            const nextCategoryId =
              selectedCategoryId &&
              categories.some(
                (category) =>
                  category.id === selectedCategoryId &&
                  (!nextType || category.type === nextType),
              )
                ? selectedCategoryId
                : "";

            replaceFilters(nextType, nextCategoryId);
          }}
          value={selectedType ?? ""}
        >
          <option value="">All types</option>
          <option value="expense">Expense</option>
          <option value="income">Income</option>
        </select>
      </label>

      <label className="space-y-2">
        <span className="text-sm font-medium text-stone-700">Category</span>
        <select
          className="w-full rounded-2xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900"
          onChange={(event) => {
            replaceFilters(selectedType ?? "", event.target.value);
          }}
          value={selectedCategoryId}
        >
          <option value="">All categories</option>
          {visibleCategories.map((category) => (
            <option key={category.id} value={category.id}>
              {category.name}
            </option>
          ))}
        </select>
      </label>
    </div>
  );
}
