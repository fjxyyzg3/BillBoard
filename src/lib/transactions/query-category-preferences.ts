import "server-only";

import { TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { resolveHouseholdContext } from "@/lib/auth/household-context";
import { financialSnapshotOptions, readFinancialTransactions } from "@/lib/encryption/financial-queries";
import { isEncryptedRequest } from "@/lib/encryption/request-context";
import {
  getRecentShanghaiNaturalDayWindow,
  type CategoryUsageStat,
  type PreferenceCategoryType,
} from "@/lib/transactions/category-preferences";

type QueryRecentCategoryUsageInput = {
  householdId: string;
  memberId: string;
  ledgerId?: string;
  now?: Date;
};

const RECENT_USAGE_DAY_COUNT = 30;

function toPreferenceCategoryType(type: TransactionType): PreferenceCategoryType {
  return type === TransactionType.INCOME ? "income" : "expense";
}

function compareCategoryUsageStats(left: CategoryUsageStat, right: CategoryUsageStat) {
  if (left.type !== right.type) {
    return left.type === "expense" ? -1 : 1;
  }

  if (left.count !== right.count) {
    return right.count - left.count;
  }

  return right.lastOccurredAt.getTime() - left.lastOccurredAt.getTime();
}

export async function queryRecentCategoryUsage({
  householdId,
  memberId,
  ledgerId,
  now = new Date(),
}: QueryRecentCategoryUsageInput): Promise<CategoryUsageStat[]> {
  if (isEncryptedRequest()) {
    return db.$transaction(async (tx) => {
      const context = await resolveHouseholdContext(tx, { householdId, memberId }, { ledgerId });
      const window = getRecentShanghaiNaturalDayWindow(now, RECENT_USAGE_DAY_COUNT);
      const rows = await readFinancialTransactions(tx, { householdId, ledgerId: context.ledgerId, actorMemberIds: [memberId] });
      const usage = new Map<string, CategoryUsageStat>();
      for (const row of rows) {
        if (row.occurredAt < window.from || row.occurredAt > window.to) continue;
        const key = JSON.stringify([row.categoryId, row.type]);
        const stat = usage.get(key) ?? { categoryId: row.categoryId, type: toPreferenceCategoryType(row.type), count: 0, lastOccurredAt: row.occurredAt };
        stat.count += 1;
        if (row.occurredAt > stat.lastOccurredAt) stat.lastOccurredAt = row.occurredAt;
        usage.set(key, stat);
      }
      return [...usage.values()].sort(compareCategoryUsageStats);
    }, financialSnapshotOptions);
  }
  const context = await resolveHouseholdContext(db, { householdId, memberId }, { ledgerId });
  const window = getRecentShanghaiNaturalDayWindow(now, RECENT_USAGE_DAY_COUNT);
  const groupedUsage = await db.transaction.groupBy({
    by: ["categoryId", "type"],
    where: {
      householdId,
      ledgerId: context.ledgerId,
      actorMemberId: memberId,
      deletedAt: null,
      occurredAt: { gte: window.from, lte: window.to },
    },
    _count: { _all: true },
    _max: { occurredAt: true },
  });

  return groupedUsage
    .flatMap((usage): CategoryUsageStat[] => {
      if (!usage._max.occurredAt) {
        return [];
      }

      return [
        {
          categoryId: usage.categoryId,
          count: usage._count._all,
          lastOccurredAt: usage._max.occurredAt,
          type: toPreferenceCategoryType(usage.type),
        },
      ];
    })
    .sort(compareCategoryUsageStats);
}
