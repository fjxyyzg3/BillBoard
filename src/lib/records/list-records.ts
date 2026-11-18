import { Prisma, TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { authorizeLedgerReadScope } from "@/lib/ledgers/server";
import type { RecordSort } from "@/lib/records/sort";
import type { RecordAmountFilter } from "@/lib/records/amount-filter";
import { selectMemberIds } from "@/lib/records/member-filter";

export type RecordTypeFilter = "income" | "expense";

export type RecordListItem = {
  id: string;
  ledgerId: string;
  ledgerName: string;
  ledgerArchivedAt: Date | null;
  amountFen: number;
  actorMemberId: string;
  actorMemberName: string;
  actorMemberInactive: boolean;
  categoryId: string;
  categoryName: string;
  createdByMemberId: string;
  createdByMemberName: string;
  createdByMemberInactive: boolean;
  note: string | null;
  occurredAt: Date;
  type: RecordTypeFilter;
};

export const RECORDS_PAGE_SIZE = 100;

type ListRecordsInput = {
  householdId: string;
  currentMemberId: string;
  ledgerId?: string;
  actorMemberId?: string;
  categoryId?: string;
  rangeBounds: {
    from: Date;
    to: Date;
  };
  limit?: number;
  offset?: number;
  recordId?: string;
  search?: string;
  searchCategoryIds?: string[];
  amountFilter?: RecordAmountFilter;
  type?: RecordTypeFilter;
  sort?: RecordSort;
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

function getRecordOrderBy(sort: RecordSort | undefined) {
  if (sort === "amount-desc") {
    return [
      { amountFen: "desc" as const },
      { occurredAt: "desc" as const },
      { createdAt: "desc" as const },
    ];
  }

  if (sort === "amount-asc") {
    return [
      { amountFen: "asc" as const },
      { occurredAt: "desc" as const },
      { createdAt: "desc" as const },
    ];
  }

  return [{ occurredAt: "desc" as const }, { createdAt: "desc" as const }];
}

export async function listRecords({
  householdId,
  currentMemberId,
  ledgerId,
  actorMemberId,
  rangeBounds,
  type,
  categoryId,
  sort,
  limit,
  offset,
  recordId,
  search,
  searchCategoryIds,
  amountFilter,
}: ListRecordsInput): Promise<RecordListItem[]> {
  await authorizeLedgerReadScope(db, { householdId, memberId: currentMemberId }, ledgerId);
  const householdMembers = await db.householdMember.findMany({
    where: { householdId },
    select: { id: true },
  });
  if (!householdMembers.some((member) => member.id === currentMemberId)) {
    throw new Error("Unauthorized");
  }
  const memberIds = selectMemberIds(householdMembers, actorMemberId);

  const normalizedSearch = search?.trim() || undefined;
  const searchWhere = normalizedSearch
    ? {
        OR: [
          { note: { contains: normalizedSearch, mode: "insensitive" as const } },
          {
            actorMember: {
              memberName: { contains: normalizedSearch, mode: "insensitive" as const },
            },
          },
          ...(searchCategoryIds && searchCategoryIds.length > 0
            ? [{ categoryId: { in: searchCategoryIds } }]
            : []),
        ],
      }
    : {};

  const transactionWhere = {
    householdId,
    ...(ledgerId ? { ledgerId } : {}),
    deletedAt: null,
    occurredAt: { gte: rangeBounds.from, lte: rangeBounds.to },
    actorMemberId: { in: memberIds },
    ...(recordId ? { id: recordId } : {}),
    ...(type ? { type: transactionTypeMap[type] } : {}),
    ...(categoryId ? { categoryId } : {}),
    ...(amountFilter ? {
      amountFen: amountFilter.mode === "exact"
        ? amountFilter.valueFen
        : {
            ...(amountFilter.minFen !== undefined ? { gte: amountFilter.minFen } : {}),
            ...(amountFilter.maxFen !== undefined ? { lte: amountFilter.maxFen } : {}),
          },
    } : {}),
    ...searchWhere,
  } satisfies Prisma.TransactionWhereInput;

  const transactions = await db.transaction.findMany({
    where: transactionWhere,
    orderBy: getRecordOrderBy(sort),
    ...(typeof offset === "number" ? { skip: offset } : {}),
    ...(typeof limit === "number" ? { take: limit } : {}),
    select: {
      id: true,
      ledgerId: true,
      ledger: { select: { name: true, archivedAt: true } },
      amountFen: true,
      occurredAt: true,
      note: true,
      type: true,
      category: { select: { id: true, name: true } },
      actorMember: { select: { id: true, memberName: true, leftAt: true, user: { select: { status: true } } } },
      createdByMember: { select: { id: true, memberName: true, leftAt: true, user: { select: { status: true } } } },
    },
  });

  return transactions.map((transaction) => ({
    id: transaction.id,
    ledgerId: transaction.ledgerId,
    ledgerName: transaction.ledger.name,
    ledgerArchivedAt: transaction.ledger.archivedAt,
    amountFen: transaction.amountFen,
    actorMemberId: transaction.actorMember.id,
    actorMemberName: transaction.actorMember.memberName,
    actorMemberInactive: transaction.actorMember.leftAt !== null || transaction.actorMember.user.status !== "ACTIVE",
    categoryId: transaction.category.id,
    categoryName: transaction.category.name,
    createdByMemberId: transaction.createdByMember.id,
    createdByMemberName: transaction.createdByMember.memberName,
    createdByMemberInactive: transaction.createdByMember.leftAt !== null || transaction.createdByMember.user.status !== "ACTIVE",
    note: transaction.note,
    occurredAt: transaction.occurredAt,
    type: toRecordType(transaction.type),
  }));
}
