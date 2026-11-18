import { getCategoryDisplayName, getMessages, type Locale } from "@/lib/i18n";
import type {
  ManagedImportCategoryMapping,
  ManagedImportCategoryMappingChange,
} from "@/lib/imports/category-mapping-management";
import { IGNORE_IMPORT_MAPPING_VALUE } from "@/lib/imports/mapping-form";

export type ManagedImportMappingFilters = {
  source: ManagedImportCategoryMapping["source"] | "";
  transactionType: ManagedImportCategoryMapping["transactionType"] | "";
  keyword: string;
};

export function filterManagedImportMappings(
  mappings: ManagedImportCategoryMapping[],
  filters: ManagedImportMappingFilters,
  locale: Locale,
): ManagedImportCategoryMapping[] {
  const keyword = filters.keyword.trim().toLocaleLowerCase(locale);
  const labels = getMessages(locale).import;

  return mappings.filter((mapping) => {
    if (filters.source && mapping.source !== filters.source) return false;
    if (filters.transactionType && mapping.transactionType !== filters.transactionType) return false;
    if (!keyword) return true;

    const currentTarget = mapping.categoryId === null ? labels.ignoreMapping
      : getCategoryDisplayName(mapping.categoryName ?? "", locale);
    return [mapping.primaryCategory, mapping.secondaryCategory, currentTarget]
      .some((value) => value.toLocaleLowerCase(locale).includes(keyword));
  });
}

export function getManagedImportMappingChanges(
  mappings: ManagedImportCategoryMapping[],
  choices: Record<string, string>,
): ManagedImportCategoryMappingChange[] {
  return mappings.flatMap((mapping) => {
    const initialValue = mapping.categoryId ?? IGNORE_IMPORT_MAPPING_VALUE;
    const choice = choices[mapping.id] ?? initialValue;
    if (!choice || choice === initialValue) return [];

    return [{
      id: mapping.id,
      categoryId: choice === IGNORE_IMPORT_MAPPING_VALUE ? null : choice,
      expectedUpdatedAt: mapping.updatedAt,
    }];
  });
}
