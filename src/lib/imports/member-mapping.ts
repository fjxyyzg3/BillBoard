import type { HouseholdMemberOption } from "./types";

export type ImportedMemberResolution = {
  externalName: string | null;
  fallbackApplied: boolean;
  memberId: string;
};

export function normalizeImportedMemberName(value: string | null | undefined): string | null {
  const normalized = String(value ?? "").trim();

  return normalized ? normalized : null;
}

export function resolveImportedMember(
  rawName: string | null | undefined,
  mappingByExternalName: Map<string, string> | HouseholdMemberOption[],
  currentMemberId: string,
): ImportedMemberResolution {
  const externalName = normalizeImportedMemberName(rawName);

  if (!externalName) {
    return { externalName: null, fallbackApplied: false, memberId: currentMemberId };
  }

  const mappedMemberId = Array.isArray(mappingByExternalName)
    ? mappingByExternalName.find((member) => member.memberName === externalName)?.id
    : mappingByExternalName.get(externalName);

  if (!mappedMemberId) {
    return { externalName, fallbackApplied: true, memberId: currentMemberId };
  }

  return { externalName, fallbackApplied: false, memberId: mappedMemberId };
}
