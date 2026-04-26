import { TransactionType } from "@prisma/client";
import type { Perspective } from "@/lib/perspective";
import { resolvePerspective } from "@/lib/perspective";
import { db } from "@/lib/db";
import type { RangePreset } from "@/lib/time-range";
import { getRangeBounds } from "@/lib/time-range";

export type RecordTypeFilter = "income" | "expense";

export type RecordListItem = {
  id: string;
  amountFen: number;
  actorMemberId: string;
  actorMemberName: string;
  categoryId: string;
  categoryName: string;
  createdByMemberId: string;
  createdByMemberName: string;
  note: string | null;
  occurredAt: Date;
  type: RecordTypeFilter;
};

type ListRecordsInput = {
  householdId: string;
  currentMemberId: string;
  timezone: string;
  rangePreset: RangePreset;
  perspective: Perspective;
  type?: RecordTypeFilter;
  categoryId?: string;
  now?: Date;
};

const transactionTypeMap = {
  income: TransactionType.INCOME,
  expense: TransactionType.EXPENSE,
} as const;

export function parseRecordType(value: string | null | undefined): RecordTypeFilter | undefined {
  if (value === "income" || value === "expense") {
    return value;
  }

  return undefined;
}

function toRecordType(type: TransactionType): RecordTypeFilter {
  return type === TransactionType.INCOME ? "income" : "expense";
}

export async function listRecords({
  householdId,
  currentMemberId,
  timezone,
  rangePreset,
  perspective,
  type,
  categoryId,
  now = new Date(),
}: ListRecordsInput): Promise<RecordListItem[]> {
  const householdMembers = await db.householdMember.findMany({
    where: { householdId },
    select: { id: true },
  });
  const memberIds = householdMembers.map((member) => member.id);

  if (!memberIds.includes(currentMemberId)) {
    throw new Error("Unauthorized");
  }

  const actorMemberIds = resolvePerspective(perspective, currentMemberId, memberIds);

  if (actorMemberIds.length === 0) {
    return [];
  }

  const { from, to } = getRangeBounds(rangePreset, now, timezone);
  const transactions = await db.transaction.findMany({
    where: {
      householdId,
      deletedAt: null,
      occurredAt: { gte: from, lte: to },
      actorMemberId: { in: actorMemberIds },
      ...(type ? { type: transactionTypeMap[type] } : {}),
      ...(categoryId ? { categoryId } : {}),
    },
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    select: {
      id: true,
      amountFen: true,
      occurredAt: true,
      note: true,
      type: true,
      category: { select: { id: true, name: true } },
      actorMember: { select: { id: true, memberName: true } },
      createdByMember: { select: { id: true, memberName: true } },
    },
  });

  return transactions.map((transaction) => ({
    id: transaction.id,
    amountFen: transaction.amountFen,
    actorMemberId: transaction.actorMember.id,
    actorMemberName: transaction.actorMember.memberName,
    categoryId: transaction.category.id,
    categoryName: transaction.category.name,
    createdByMemberId: transaction.createdByMember.id,
    createdByMemberName: transaction.createdByMember.memberName,
    note: transaction.note,
    occurredAt: transaction.occurredAt,
    type: toRecordType(transaction.type),
  }));
}
