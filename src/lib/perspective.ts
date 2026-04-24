export type Perspective = "household" | "me" | "spouse";

export function parsePerspective(value: string | null | undefined): Perspective {
  if (value === "me" || value === "spouse") {
    return value;
  }

  return "household";
}

export function resolvePerspective(
  perspective: Perspective,
  currentMemberId: string,
  memberIds: string[],
) {
  if (perspective === "household") {
    return memberIds;
  }

  if (perspective === "me") {
    return [currentMemberId];
  }

  return memberIds.filter((memberId) => memberId !== currentMemberId);
}
