import { Prisma, TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { financialSnapshotOptions, readFinancialTransactions } from "@/lib/encryption/financial-queries";
import { isEncryptedRequest } from "@/lib/encryption/request-context";
import { authorizeLedgerReadScope } from "@/lib/ledgers/server";
import { selectMemberIds } from "@/lib/records/member-filter";
import { buildMonthlyBalanceTrend } from "@/lib/reports/balance-trend";
import {
  aggregateHomeReport,
  type HomeReport,
  type ReportCategoryItem,
} from "@/lib/reports/aggregate";
import {
  buildReportRangeOptions,
  clampReportRangeSelection,
  getReportRangeBounds,
  parseReportRangeSearchParams,
  type ReportRangeSelection,
} from "@/lib/reports/report-range";

type QueryHomeReportInput = {
  currentMemberId: string;
  householdId: string;
  ledgerId?: string;
  actorMemberId?: string;
  now?: Date;
  range: ReportRangeSelection;
};

type RawTrendRow = {
  amountFen: bigint | number | null;
  bucketKey: string;
  transactionCount: bigint | number;
  type: TransactionType;
};

function toNumber(value: bigint | number | null | undefined) {
  if (typeof value === "bigint") {
    return Number(value);
  }

  return value ?? 0;
}

function buildCategoryItems(
  rows: Array<{
    amountFen: number;
    categoryId: string;
    categoryName: string;
    transactionCount: number;
  }>,
  totalFen: number,
): ReportCategoryItem[] {
  return rows
    .sort((left, right) => {
      if (right.amountFen !== left.amountFen) {
        return right.amountFen - left.amountFen;
      }

      return left.categoryName.localeCompare(right.categoryName);
    })
    .map((item) => ({
      ...item,
      share: totalFen === 0 ? 0 : item.amountFen / totalFen,
    }));
}

function applyTrendRows(report: HomeReport, rows: RawTrendRow[]): HomeReport["trend"] {
  const points = report.trend.points.map((point) => ({ ...point }));
  const trendByKey = new Map(points.map((point) => [point.bucketKey, point]));

  for (const row of rows) {
    const point = trendByKey.get(row.bucketKey);

    if (!point) {
      continue;
    }

    const amountFen = toNumber(row.amountFen);
    const transactionCount = toNumber(row.transactionCount);

    if (row.type === TransactionType.INCOME) {
      point.incomeFen += amountFen;
    } else {
      point.expenseFen += amountFen;
    }

    point.netFen = point.incomeFen - point.expenseFen;
    point.transactionCount += transactionCount;
  }

  return { ...report.trend, points };
}

async function queryTrendRows(
  input: {
    actorMemberIds: string[];
    from: Date;
    granularity: HomeReport["trend"]["granularity"];
    householdId: string;
    ledgerId?: string;
    to: Date;
  },
) {
  const bucketFormat = input.granularity === "day" ? "YYYY-MM-DD" : "YYYY-MM";

  return db.$queryRaw<RawTrendRow[]>(Prisma.sql`
    SELECT
      bucket_key AS "bucketKey",
      "type",
      COALESCE(SUM("amount_fen"), 0)::bigint AS "amountFen",
      COUNT(*)::bigint AS "transactionCount"
    FROM (
      SELECT
        to_char("occurred_at" + interval '8 hours', ${bucketFormat}) AS bucket_key,
        "type",
        "amount_fen"
      FROM "Transaction"
      WHERE "household_id" = ${input.householdId}
        ${input.ledgerId ? Prisma.sql`AND "ledger_id" = ${input.ledgerId}` : Prisma.empty}
        AND "deleted_at" IS NULL
        AND "occurred_at" >= ${input.from}
        AND "occurred_at" <= ${input.to}
        AND "actor_member_id" IN (${Prisma.join(input.actorMemberIds)})
    ) buckets
    GROUP BY bucket_key, "type"
  `);
}

async function queryEncryptedHomeReport({ currentMemberId, householdId, ledgerId, actorMemberId, now = new Date(), range }: QueryHomeReportInput): Promise<HomeReport> {
  return db.$transaction(async (tx) => {
    await authorizeLedgerReadScope(tx, { householdId, memberId: currentMemberId }, ledgerId);
    const [household, members] = await Promise.all([
      tx.household.findUniqueOrThrow({ where: { id: householdId }, select: { timezone: true } }),
      tx.householdMember.findMany({ where: { householdId }, select: { id: true } }),
    ]);
    if (!members.some((member) => member.id === currentMemberId)) throw new Error("Unauthorized");
    const memberIds = new Set(selectMemberIds(members, actorMemberId));
    const rows = await readFinancialTransactions(tx, { householdId, ledgerId });
    const firstOccurredAt = rows.reduce<Date | null>((first, row) => !first || row.occurredAt < first ? row.occurredAt : first, null);
    const rangeOptions = buildReportRangeOptions(firstOccurredAt, now, household.timezone);
    const resolvedRange = clampReportRangeSelection(range, rangeOptions);
    const bounds = getReportRangeBounds(resolvedRange, now, firstOccurredAt, household.timezone);
    const reportRange = { ...resolvedRange, ...bounds };
    let trendRange = reportRange;
    if (resolvedRange.mode === "custom") {
      const firstTrendDate = new Date(Math.min(firstOccurredAt?.getTime() ?? bounds.to.getTime(), bounds.to.getTime()));
      const firstMonth = parseReportRangeSearchParams({ mode: "month" }, firstTrendDate);
      const firstMonthStart = getReportRangeBounds(firstMonth, firstTrendDate, null, household.timezone).from;
      trendRange = { ...reportRange, from: new Date(Math.max(bounds.from.getTime(), firstMonthStart.getTime())) };
    }
    const report = aggregateHomeReport({
      range: trendRange,
      rangeOptions,
      timezone: household.timezone,
      transactions: rows
        .filter((row) => memberIds.has(row.actorMemberId) && row.occurredAt >= bounds.from && row.occurredAt <= bounds.to)
        .map((row) => ({
          id: row.id, amountFen: row.amountFen, actorMemberId: row.actorMemberId,
          actorMemberName: "", createdByMemberId: row.createdByMemberId, createdByMemberName: "",
          categoryId: row.categoryId, categoryName: row.category.name, note: null,
          occurredAt: row.occurredAt, type: row.type === TransactionType.INCOME ? "income" : "expense",
        })),
    });
    return { ...report, range: reportRange };
  }, financialSnapshotOptions);
}

export async function queryHomeReport({
  currentMemberId,
  householdId,
  ledgerId,
  actorMemberId,
  now = new Date(),
  range,
}: QueryHomeReportInput): Promise<HomeReport> {
  if (isEncryptedRequest()) return queryEncryptedHomeReport({ currentMemberId, householdId, ledgerId, actorMemberId, now, range });
  await authorizeLedgerReadScope(db, { householdId, memberId: currentMemberId }, ledgerId);
  const [household, householdMembers, firstTransaction] = await Promise.all([
    db.household.findUniqueOrThrow({
      where: { id: householdId },
      select: { timezone: true },
    }),
    db.householdMember.findMany({
      where: { householdId },
      select: { id: true },
    }),
    db.transaction.findFirst({
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
      where: {
        deletedAt: null,
        householdId,
        ...(ledgerId ? { ledgerId } : {}),
      },
    }),
  ]);
  if (!householdMembers.some((member) => member.id === currentMemberId)) {
    throw new Error("Unauthorized");
  }
  const memberIds = selectMemberIds(householdMembers, actorMemberId);

  const firstOccurredAt = firstTransaction?.occurredAt ?? null;
  const rangeOptions = buildReportRangeOptions(firstOccurredAt, now, household.timezone);
  const resolvedRange = clampReportRangeSelection(range, rangeOptions);
  const rangeBounds = getReportRangeBounds(
    resolvedRange,
    now,
    firstOccurredAt,
    household.timezone,
  );
  const reportRange = {
    ...resolvedRange,
    ...rangeBounds,
  };
  let trendRange = reportRange;

  if (resolvedRange.mode === "custom") {
    const firstTrendDate = new Date(Math.min(firstOccurredAt?.getTime() ?? rangeBounds.to.getTime(), rangeBounds.to.getTime()));
    const firstTrendMonth = parseReportRangeSearchParams({ mode: "month" }, firstTrendDate);
    const firstMonthStart = getReportRangeBounds(firstTrendMonth, firstTrendDate, null, household.timezone).from;
    trendRange = { ...reportRange, from: new Date(Math.max(rangeBounds.from.getTime(), firstMonthStart.getTime())) };
  }

  const baseReport = aggregateHomeReport({
    range: trendRange,
    rangeOptions,
    timezone: household.timezone,
    transactions: [],
  });
  const transactionWhere = {
    actorMemberId: { in: memberIds },
    deletedAt: null,
    householdId,
    ...(ledgerId ? { ledgerId } : {}),
    occurredAt: { gte: rangeBounds.from, lte: rangeBounds.to },
  } satisfies Prisma.TransactionWhereInput;
  const [summaryRows, categoryRows, trendRows] = await Promise.all([
    db.transaction.groupBy({
      by: ["type"],
      where: transactionWhere,
      _sum: { amountFen: true },
      _count: { _all: true },
    }),
    db.transaction.groupBy({
      by: ["type", "categoryId"],
      where: transactionWhere,
      _sum: { amountFen: true },
      _count: { _all: true },
    }),
    queryTrendRows({
      actorMemberIds: memberIds,
      from: rangeBounds.from,
      granularity: baseReport.trend.granularity,
      householdId,
      ledgerId,
      to: rangeBounds.to,
    }),
  ]);
  const categoryIds = Array.from(new Set(categoryRows.map((row) => row.categoryId)));
  const categoryNames =
    categoryIds.length === 0
      ? new Map<string, string>()
      : new Map(
          (
            await db.category.findMany({
              where: { id: { in: categoryIds } },
              select: { id: true, name: true },
            })
          ).map((category) => [category.id, category.name]),
        );
  const summaryByType = new Map(summaryRows.map((row) => [row.type, row]));
  const incomeFen = summaryByType.get(TransactionType.INCOME)?._sum.amountFen ?? 0;
  const expenseFen = summaryByType.get(TransactionType.EXPENSE)?._sum.amountFen ?? 0;
  const incomeCount = summaryByType.get(TransactionType.INCOME)?._count._all ?? 0;
  const expenseCount = summaryByType.get(TransactionType.EXPENSE)?._count._all ?? 0;
  const expenseRows = categoryRows
    .filter((row) => row.type === TransactionType.EXPENSE)
    .map((row) => ({
      amountFen: row._sum.amountFen ?? 0,
      categoryId: row.categoryId,
      categoryName: categoryNames.get(row.categoryId) ?? row.categoryId,
      transactionCount: row._count._all,
    }));
  const incomeRows = categoryRows
    .filter((row) => row.type === TransactionType.INCOME)
    .map((row) => ({
      amountFen: row._sum.amountFen ?? 0,
      categoryId: row.categoryId,
      categoryName: categoryNames.get(row.categoryId) ?? row.categoryId,
      transactionCount: row._count._all,
    }));
  const trend = applyTrendRows(baseReport, trendRows);

  return {
    ...baseReport,
    balanceTrend: buildMonthlyBalanceTrend({ trend, range: reportRange }),
    range: reportRange,
    categories: {
      expense: {
        items: buildCategoryItems(expenseRows, expenseFen),
        totalFen: expenseFen,
      },
      income: {
        items: buildCategoryItems(incomeRows, incomeFen),
        totalFen: incomeFen,
      },
    },
    summary: {
      expenseFen,
      incomeFen,
      netFen: incomeFen - expenseFen,
      transactionCount: incomeCount + expenseCount,
    },
    trend,
  };
}
