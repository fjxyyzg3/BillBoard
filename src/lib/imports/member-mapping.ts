import type { HouseholdMemberOption } from "./types";

const memberAliases = new Map([
  ["李环宇", "老公"],
  ["老公", "老公"],
  ["晶晶", "老婆"],
  ["老婆", "老婆"],
]);

export function resolveImportedMember(
  rawName: string | null | undefined,
  householdMembers: HouseholdMemberOption[],
  currentMemberId: string,
): { fallbackApplied: boolean; memberId: string } {
  const memberName = memberAliases.get(String(rawName ?? "").trim());
  const matchedMember = memberName
    ? householdMembers.find((member) => member.memberName === memberName)
    : null;

  if (!matchedMember) {
    return { memberId: currentMemberId, fallbackApplied: true };
  }

  return { memberId: matchedMember.id, fallbackApplied: false };
}
