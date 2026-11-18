import type { TransactionType } from "@prisma/client";

import type { ImportDraftMappingInput } from "@/lib/imports/drafts";

export const IGNORE_IMPORT_MAPPING_VALUE = "__ignore__";

type MappingGroupSummary = {
  count: number;
  mappingKey: string;
  primaryCategory: string | null;
  secondaryCategory: string | null;
  transactionType: TransactionType | null;
};

export type ImportMappingFormGroup = MappingGroupSummary & { initialValue: string };

export function getImportMappingGroups(
  missingMappings: MappingGroupSummary[],
  ignoredMappings: MappingGroupSummary[],
): ImportMappingFormGroup[] {
  const groups = new Map<string, ImportMappingFormGroup>();

  for (const mapping of ignoredMappings) {
    groups.set(mapping.mappingKey, {
      ...mapping,
      count: mapping.count + (groups.get(mapping.mappingKey)?.count ?? 0),
      initialValue: IGNORE_IMPORT_MAPPING_VALUE,
    });
  }

  for (const mapping of missingMappings) {
    groups.set(mapping.mappingKey, {
      ...mapping,
      count: mapping.count + (groups.get(mapping.mappingKey)?.count ?? 0),
      initialValue: "",
    });
  }

  return Array.from(groups.values()).sort((a, b) => a.mappingKey.localeCompare(b.mappingKey));
}

export function getImportMappingChanges(
  groups: ImportMappingFormGroup[],
  choices: Record<string, string>,
): ImportDraftMappingInput[] {
  return groups.flatMap((group) => {
    const choice = choices[group.mappingKey] ?? group.initialValue;
    if (!choice || choice === group.initialValue) return [];

    return [{
      mappingKey: group.mappingKey,
      categoryId: choice === IGNORE_IMPORT_MAPPING_VALUE ? null : choice,
    }];
  });
}

export function getImportMappingRecommendationTargets(
  groups: ImportMappingFormGroup[],
  choices: Record<string, string>,
): string[] {
  return groups.filter((group) => !group.initialValue && !choices[group.mappingKey])
    .map((group) => group.mappingKey);
}

export function mergeImportMappingSuggestions(
  groups: ImportMappingFormGroup[],
  choices: Record<string, string>,
  suggestions: ImportDraftMappingInput[],
  requestedVersions: Record<string, number>,
  currentVersions: Record<string, number>,
): Record<string, string> {
  const eligible = new Set(getImportMappingRecommendationTargets(groups, choices));
  const nextChoices = { ...choices };

  for (const suggestion of suggestions) {
    const { mappingKey, categoryId } = suggestion;
    if (!eligible.has(mappingKey) || !Object.hasOwn(requestedVersions, mappingKey)) continue;
    if ((currentVersions[mappingKey] ?? 0) !== requestedVersions[mappingKey]) continue;

    nextChoices[mappingKey] = categoryId === null ? IGNORE_IMPORT_MAPPING_VALUE : categoryId;
  }

  return nextChoices;
}
