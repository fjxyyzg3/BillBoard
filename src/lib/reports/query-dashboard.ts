import { TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { type Perspective, resolvePerspective } from "@/lib/perspective";
import { aggregateReport, type DashboardReport } from "@/lib/reports/aggregate";
import { getRangeBounds, type RangePreset } from "@/lib/time-range";

type QueryDashboardInput = {
  currentMemberId: string;
  householdId: string;
  now?: Date;
  perspective: Perspective;
  rangePreset: RangePreset;
};

export async function queryDashboard({
  currentMemberId,
  householdId,
  now = new Date(),
  perspective,
  rangePreset,
}: QueryDashboardInput): Promise<DashboardReport> {
  const [household, householdMembers] = await Promise.all([
    db.household.findUniqueOrThrow({
      where: { id: householdId },
      select: { timezone: true },
    }),
    db.householdMember.findMany({
      where: { householdId },
      select: { id: true },
    }),
  ]);
  const memberIds = householdMembers.map((member) => member.id);

  if (!memberIds.includes(currentMemberId)) {
    throw new Error("Unauthorized");
  }

  const rangeBounds = getRangeBounds(rangePreset, now, household.timezone);
  const actorMemberIds = resolvePerspective(perspective, currentMemberId, memberIds);

  if (actorMemberIds.length === 0) {
    return aggregateReport({
      rangeBounds,
      rangePreset,
      timezone: household.timezone,
      transactions: [],
    });
  }

  const transactions = await db.transaction.findMany({
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    select: {
      actorMember: { select: { id: true, memberName: true } },
      amountFen: true,
      category: { select: { id: true, name: true } },
      createdByMember: { select: { id: true, memberName: true } },
      id: true,
      note: true,
      occurredAt: true,
      type: true,
    },
    where: {
      actorMemberId: { in: actorMemberIds },
      deletedAt: null,
      householdId,
      occurredAt: { gte: rangeBounds.from, lte: rangeBounds.to },
    },
  });

  return aggregateReport({
    rangeBounds,
    rangePreset,
    timezone: household.timezone,
    transactions: transactions.map((transaction) => ({
      actorMemberId: transaction.actorMember.id,
      actorMemberName: transaction.actorMember.memberName,
      amountFen: transaction.amountFen,
      categoryId: transaction.category.id,
      categoryName: transaction.category.name,
      createdByMemberId: transaction.createdByMember.id,
      createdByMemberName: transaction.createdByMember.memberName,
      id: transaction.id,
      note: transaction.note,
      occurredAt: transaction.occurredAt,
      type: transaction.type === TransactionType.INCOME ? "income" : "expense",
    })),
  });
}
