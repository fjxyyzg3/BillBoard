import { Prisma, TransactionType, type PrismaClient } from "@prisma/client";
import { db } from "@/lib/db";
import { aggregateFinancialAnalytics, financialSnapshotOptions, readFinancialTransactions } from "@/lib/encryption/financial-queries";
import { isEncryptedRequest } from "@/lib/encryption/request-context";
import { authorizeLedgerReadScope } from "@/lib/ledgers/server";
import { selectMemberIds } from "@/lib/records/member-filter";
import { buildReportAnalytics, EXPENSE_BUCKETS } from "./analytics";
import type {
  AnalyticsCategoryAggregate,
  AnalyticsCategoryMonthAggregate,
  AnalyticsDateRange,
  AnalyticsDayAggregate,
  AnalyticsDistributionAggregate,
  AnalyticsPeriod,
  ReportAnalytics,
} from "./analytics-types";
import { getReportComparisonBounds, type ReportRange } from "./report-range";

export type QueryReportAnalyticsInput = {
  householdId: string;
  currentMemberId: string;
  ledgerId?: string;
  actorMemberId?: string;
  range: ReportRange;
  now?: Date;
};

type DatabaseNumber = bigint | number;
type QueryPeriod = { period: AnalyticsPeriod; from: Date; to: Date };
type CategoryRow = Omit<AnalyticsCategoryAggregate, "type" | "amountFen" | "transactionCount"> & {
  type: TransactionType;
  amountFen: DatabaseNumber;
  transactionCount: DatabaseNumber;
};
type DayRow = Omit<AnalyticsDayAggregate, "expenseFen" | "expenseCount"> & {
  expenseFen: DatabaseNumber;
  expenseCount: DatabaseNumber;
};
type CategoryMonthRow = Omit<AnalyticsCategoryMonthAggregate, "type" | "amountFen" | "transactionCount"> & {
  type: TransactionType;
  amountFen: DatabaseNumber;
  transactionCount: DatabaseNumber;
};
type DistributionRow = {
  key: string | null;
  amountFen: DatabaseNumber | null;
  transactionCount: DatabaseNumber | null;
  expenseCount: DatabaseNumber;
  totalFen: DatabaseNumber;
  medianFen: number | null;
  maxFen: number | null;
  topFiveAmountFen: DatabaseNumber;
};

function integer(value: DatabaseNumber | null): number {
  const result = Number(value ?? 0);
  if (!Number.isSafeInteger(result)) throw new Error("Report aggregate exceeds the supported amount range");
  return result;
}

function shanghaiDate(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function serializeRange(range: Pick<ReportRange, "from" | "to">): AnalyticsDateRange {
  return { from: shanghaiDate(range.from), to: shanghaiDate(range.to) };
}

function periodValues(periods: QueryPeriod[]) {
  return Prisma.join(periods.map(({ period, from, to }) => Prisma.sql`(${period}::text, ${from}::timestamp, ${to}::timestamp)`));
}

async function resolveAnalyticsQuery(
  client: PrismaClient | Prisma.TransactionClient,
  { householdId, currentMemberId, ledgerId, actorMemberId, range, now = new Date() }: QueryReportAnalyticsInput,
) {
  await authorizeLedgerReadScope(client, { householdId, memberId: currentMemberId }, ledgerId);
  const household = await client.household.findFirst({
    where: { id: householdId, members: { some: { id: currentMemberId } } },
    select: { timezone: true, members: { select: { id: true } } },
  });
  if (!household) throw new Error("Unauthorized");
  if (household.timezone !== "Asia/Shanghai") throw new Error("v1 supports Asia/Shanghai report math only");

  const todayEnd = new Date(`${shanghaiDate(now)}T23:59:59.999+08:00`);
  const currentRange = { ...range, to: new Date(Math.min(range.to.getTime(), todayEnd.getTime())) };
  if (!Number.isFinite(currentRange.from.getTime()) || !Number.isFinite(currentRange.to.getTime()) || currentRange.from > currentRange.to) {
    throw new Error("Invalid report range");
  }
  const previousRange = getReportComparisonBounds(currentRange, "previous", now);
  const yearAgoRange = getReportComparisonBounds(currentRange, "yearAgo", now);
  const periods: QueryPeriod[] = [{ period: "current", from: currentRange.from, to: currentRange.to }];
  if (previousRange) periods.push({ period: "previous", ...previousRange });
  if (yearAgoRange) periods.push({ period: "yearAgo", ...yearAgoRange });
  const memberIds = selectMemberIds(household.members, actorMemberId);
  return { todayEnd, currentRange, previousRange, yearAgoRange, periods, memberIds };
}

export async function queryReportAnalytics(input: QueryReportAnalyticsInput): Promise<ReportAnalytics> {
  const { householdId, ledgerId } = input;
  if (isEncryptedRequest()) {
    return db.$transaction(async (tx) => {
      const { todayEnd, currentRange, previousRange, yearAgoRange, periods, memberIds } = await resolveAnalyticsQuery(tx, input);
      const rows = await readFinancialTransactions(tx, { householdId, ledgerId, actorMemberIds: memberIds });
      const firstOccurredAt = rows.reduce<Date | null>((first, row) => row.occurredAt <= todayEnd && (!first || row.occurredAt < first) ? row.occurredAt : first, null);
      return buildReportAnalytics({
        range: serializeRange(currentRange),
        previousRange: previousRange ? serializeRange(previousRange) : null,
        yearAgoRange: yearAgoRange ? serializeRange(yearAgoRange) : null,
        firstRecordedDate: firstOccurredAt ? shanghaiDate(firstOccurredAt) : null,
        ...aggregateFinancialAnalytics(rows, periods),
      });
    }, financialSnapshotOptions);
  }
  const { todayEnd, currentRange, previousRange, yearAgoRange, periods, memberIds } = await resolveAnalyticsQuery(db, input);
  const validTransactions = Prisma.sql`
    t."household_id" = ${householdId}
    ${ledgerId ? Prisma.sql`AND t."ledger_id" = ${ledgerId}` : Prisma.empty}
    AND t."deleted_at" IS NULL
    AND t."actor_member_id" IN (${Prisma.join(memberIds)})
  `;
  const selectedTransactions = Prisma.sql`
    ${validTransactions}
    AND t."occurred_at" >= ${currentRange.from}
    AND t."occurred_at" <= ${currentRange.to}
  `;
  const bucketConditions = EXPENSE_BUCKETS.filter((bucket) => bucket.maxFen !== null)
    .map((bucket) => Prisma.sql`WHEN "amount_fen" <= ${bucket.maxFen} THEN ${bucket.key}`);

  const [firstTransaction, categories, days, categoryMonths, distributionRows] = await db.$transaction(async (tx) => Promise.all([
    tx.transaction.findFirst({
      where: { householdId, ...(ledgerId ? { ledgerId } : {}), actorMemberId: { in: memberIds }, deletedAt: null, occurredAt: { lte: todayEnd } },
      orderBy: { occurredAt: "asc" }, select: { occurredAt: true },
    }),
    tx.$queryRaw<CategoryRow[]>(Prisma.sql`
      WITH periods (period, starts_at, ends_at) AS (VALUES ${periodValues(periods)})
      SELECT p.period, t."type", t."category_id" AS "categoryId", c."name" AS "categoryName",
        SUM(t."amount_fen")::bigint AS "amountFen", COUNT(*)::bigint AS "transactionCount"
      FROM periods p
      JOIN "Transaction" t ON t."occurred_at" >= p.starts_at AND t."occurred_at" <= p.ends_at
      JOIN "Category" c ON c."id" = t."category_id"
      WHERE ${validTransactions}
      GROUP BY p.period, t."type", t."category_id", c."name"
    `),
    tx.$queryRaw<DayRow[]>(Prisma.sql`
      WITH periods (period, starts_at, ends_at) AS (VALUES ${periodValues(periods.filter(({ period }) => period !== "yearAgo"))})
      SELECT p.period, to_char(t."occurred_at" + interval '8 hours', 'YYYY-MM-DD') AS "date",
        SUM(t."amount_fen")::bigint AS "expenseFen", COUNT(*)::bigint AS "expenseCount"
      FROM periods p
      JOIN "Transaction" t ON t."occurred_at" >= p.starts_at AND t."occurred_at" <= p.ends_at
      WHERE ${validTransactions} AND t."type" = 'EXPENSE'
      GROUP BY p.period, to_char(t."occurred_at" + interval '8 hours', 'YYYY-MM-DD')
    `),
    tx.$queryRaw<CategoryMonthRow[]>(Prisma.sql`
      SELECT t."type", t."category_id" AS "categoryId", c."name" AS "categoryName",
        to_char(t."occurred_at" + interval '8 hours', 'YYYY-MM') AS "month",
        SUM(t."amount_fen")::bigint AS "amountFen", COUNT(*)::bigint AS "transactionCount"
      FROM "Transaction" t JOIN "Category" c ON c."id" = t."category_id"
      WHERE ${selectedTransactions}
      GROUP BY t."type", t."category_id", c."name", to_char(t."occurred_at" + interval '8 hours', 'YYYY-MM')
    `),
    tx.$queryRaw<DistributionRow[]>(Prisma.sql`
      WITH expenses AS (
        SELECT t."amount_fen" FROM "Transaction" t WHERE ${selectedTransactions} AND t."type" = 'EXPENSE'
      ), ranked AS (
        SELECT "amount_fen", ROW_NUMBER() OVER (ORDER BY "amount_fen" DESC) AS spending_rank FROM expenses
      ), statistics AS (
        SELECT COUNT(*)::bigint AS "expenseCount", COALESCE(SUM("amount_fen"), 0)::bigint AS "totalFen",
          percentile_cont(0.5) WITHIN GROUP (ORDER BY "amount_fen") AS "medianFen",
          MAX("amount_fen") AS "maxFen",
          COALESCE(SUM("amount_fen") FILTER (WHERE spending_rank <= 5), 0)::bigint AS "topFiveAmountFen"
        FROM ranked
      ), buckets AS (
        SELECT CASE ${Prisma.join(bucketConditions, " ")} ELSE ${EXPENSE_BUCKETS[5].key} END AS "key",
          SUM("amount_fen")::bigint AS "amountFen", COUNT(*)::bigint AS "transactionCount"
        FROM expenses GROUP BY "key"
      )
      SELECT statistics.*, buckets."key", buckets."amountFen", buckets."transactionCount"
      FROM statistics LEFT JOIN buckets ON true
    `),
  ]), { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });

  const distributionStats = distributionRows[0];
  const distribution: AnalyticsDistributionAggregate = {
    expenseCount: integer(distributionStats.expenseCount),
    totalFen: integer(distributionStats.totalFen),
    medianFen: distributionStats.medianFen,
    maxFen: distributionStats.maxFen,
    topFiveAmountFen: integer(distributionStats.topFiveAmountFen),
    buckets: distributionRows.flatMap((row) => row.key === null ? [] : [{
      key: row.key, amountFen: integer(row.amountFen), transactionCount: integer(row.transactionCount),
    }]),
  };
  return buildReportAnalytics({
    range: serializeRange(currentRange),
    previousRange: previousRange ? serializeRange(previousRange) : null,
    yearAgoRange: yearAgoRange ? serializeRange(yearAgoRange) : null,
    firstRecordedDate: firstTransaction ? shanghaiDate(firstTransaction.occurredAt) : null,
    categories: categories.map((row) => ({ ...row, type: row.type === TransactionType.INCOME ? "income" : "expense", amountFen: integer(row.amountFen), transactionCount: integer(row.transactionCount) })),
    days: days.map((row) => ({ ...row, expenseFen: integer(row.expenseFen), expenseCount: integer(row.expenseCount) })),
    categoryMonths: categoryMonths.map((row) => ({ ...row, type: row.type === TransactionType.INCOME ? "income" : "expense", amountFen: integer(row.amountFen), transactionCount: integer(row.transactionCount) })),
    distribution,
  });
}
