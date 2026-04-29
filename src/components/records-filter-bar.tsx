"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { IosSelect } from "@/components/ios-select";

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
  const categoryOptions = [
    { value: "", label: "All categories" },
    ...visibleCategories.map((category) => ({
      value: category.id,
      label: category.name,
    })),
  ];

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
        <span className="text-sm font-medium text-[var(--ios-muted)]">Type</span>
        <IosSelect
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
          options={[
            { value: "", label: "All types" },
            { value: "expense", label: "Expense" },
            { value: "income", label: "Income" },
          ]}
          value={selectedType ?? ""}
        />
      </label>

      <label className="space-y-2">
        <span className="text-sm font-medium text-[var(--ios-muted)]">Category</span>
        <IosSelect
          onChange={(event) => {
            replaceFilters(selectedType ?? "", event.target.value);
          }}
          options={categoryOptions}
          value={selectedCategoryId}
        />
      </label>
    </div>
  );
}
