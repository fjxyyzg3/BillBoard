import type { Prisma, PrismaClient } from "@prisma/client";
import { getMemberDisplayName, getMessages, type Locale } from "@/lib/i18n";

export type MemberFilterOption = { id: string; label: string };

export function parseMemberFilter(value: string | string[] | null | undefined): string | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value !== "string" || value.length > 128 || !/^[A-Za-z0-9_-]+$/.test(value)) throw new Error("Unauthorized");
  return value;
}

export function selectMemberIds(members: Array<{ id: string }>, actorMemberId?: string): string[] {
  const selected = parseMemberFilter(actorMemberId);
  if (selected && !members.some(({ id }) => id === selected)) throw new Error("Unauthorized");
  return selected ? [selected] : members.map(({ id }) => id);
}

export async function authorizeMemberReadScope(client: PrismaClient | Prisma.TransactionClient, householdId: string, actorMemberId?: string) {
  const selected = parseMemberFilter(actorMemberId);
  if (selected && !await client.householdMember.findFirst({ where: { id: selected, householdId }, select: { id: true } })) {
    throw new Error("Unauthorized");
  }
}

export function buildMemberFilterOptions(members: Array<{ id: string; memberName: string; leftAt: Date | null; user: { status: string } }>, locale: Locale): MemberFilterOption[] {
  const labels = getMessages(locale).memberFilter;
  const names = new Map<string, number>();
  for (const member of members) names.set(member.memberName, (names.get(member.memberName) ?? 0) + 1);
  const historical = new Map<string, number>();
  return members.map((member) => {
    const inactive = member.leftAt !== null || member.user.status !== "ACTIVE";
    let label = getMemberDisplayName(member.memberName, inactive, locale);
    if (inactive && names.get(member.memberName)! > 1) {
      const ordinal = (historical.get(member.memberName) ?? 0) + 1;
      historical.set(member.memberName, ordinal);
      label = labels.historicalIdentity(member.memberName, ordinal);
    }
    return { id: member.id, label };
  });
}
