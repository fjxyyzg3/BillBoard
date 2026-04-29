"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { IosSelect } from "@/components/ios-select";
import { getCategoryDisplayName, type Locale, type Messages } from "@/lib/i18n";

type CategoryOption = {
  id: string;
  name: string;
  type: "income" | "expense";
};

type RecordsFilterBarProps = {
  categories: CategoryOption[];
  labels: {
    common: Messages["common"];
  };
  locale: Locale;
};

function parseType(value: string | null): CategoryOption["type"] | undefined {
  if (value === "income" || value === "expense") {
    return value;
  }

  return undefined;
}

export function RecordsFilterBar({ categories, labels, locale }: RecordsFilterBarProps) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const selectedType = parseType(searchParams.get("type"));
  const selectedCategoryId = searchParams.get("category") ?? "";
  const visibleCategories = categories.filter(
    (category) => !selectedType || category.type === selectedType,
  );
  const categoryOptions = [
    { value: "", label: labels.common.allCategories },
    ...visibleCategories.map((category) => ({
      value: category.id,
      label: getCategoryDisplayName(category.name, locale),
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
        <span className="text-sm font-medium text-[var(--ios-muted)]">{labels.common.type}</span>
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
            { value: "", label: labels.common.allTypes },
            { value: "expense", label: labels.common.expense },
            { value: "income", label: labels.common.income },
          ]}
          value={selectedType ?? ""}
        />
      </label>

      <label className="space-y-2">
        <span className="text-sm font-medium text-[var(--ios-muted)]">
          {labels.common.category}
        </span>
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
