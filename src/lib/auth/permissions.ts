export function assertHouseholdAccess(sessionHouseholdId: string, targetHouseholdId: string) {
  if (sessionHouseholdId !== targetHouseholdId) {
    throw new Error("Forbidden");
  }
}

export function resolvePerspectiveMemberId(
  perspective: "household" | "me" | "spouse",
  currentMemberId: string,
  members: Array<{ id: string }>,
) {
  if (perspective === "household") {
    return null;
  }

  if (perspective === "me") {
    return currentMemberId;
  }

  return members.find((member) => member.id !== currentMemberId)?.id ?? null;
}
