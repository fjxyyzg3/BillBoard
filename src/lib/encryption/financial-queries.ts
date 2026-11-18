import { Prisma, TransactionType } from "@prisma/client";
import { Buffer } from "node:buffer";
import { EXPENSE_BUCKETS } from "@/lib/reports/analytics";
import { WECHAT_PAY_SOURCE } from "@/lib/imports/types";
import { EncryptionRequestError } from "./types";
import type {
  AnalyticsCategoryAggregate,
  AnalyticsCategoryMonthAggregate,
  AnalyticsDayAggregate,
  AnalyticsDistributionAggregate,
  AnalyticsPeriod,
} from "@/lib/reports/analytics-types";

const financialTransactionSelect = {
  id: true,
  amountFen: true,
  actorMemberId: true,
  createdByMemberId: true,
  categoryId: true,
  category: { select: { name: true } },
  occurredAt: true,
  type: true,
} satisfies Prisma.TransactionSelect;

export type FinancialTransaction = Prisma.TransactionGetPayload<{ select: typeof financialTransactionSelect }>;
export type FinancialQueryPeriod = { period: AnalyticsPeriod; from: Date; to: Date };
export const MAX_FINANCIAL_SCAN_BYTES = 512 * 1024 * 1024;

export const financialSnapshotOptions = {
  isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
  maxWait: 10_000,
  timeout: 120_000,
} as const;

export async function readFinancialTransactions(
  client: Pick<Prisma.TransactionClient, "transaction">,
  input: { householdId: string; ledgerId?: string; actorMemberIds?: string[] },
): Promise<FinancialTransaction[]> {
  const rows: FinancialTransaction[] = [];
  let afterId: string | undefined;
  let byteCount = 0;

  while (true) {
    const chunk = await client.transaction.findMany({
      where: {
        householdId: input.householdId,
        deletedAt: null,
        ...(input.ledgerId ? { ledgerId: input.ledgerId } : {}),
        ...(input.actorMemberIds ? { actorMemberId: { in: input.actorMemberIds } } : {}),
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: financialTransactionSelect,
      orderBy: { id: "asc" },
      take: 500,
    });
    byteCount += Buffer.byteLength(JSON.stringify(chunk), "utf8");
    if (byteCount > MAX_FINANCIAL_SCAN_BYTES) throw new EncryptionRequestError("ENCRYPTION_BUDGET");
    rows.push(...chunk);
    if (chunk.length < 500) return rows;
    afterId = chunk[chunk.length - 1].id;
  }
}

export async function collectImportSourceAmounts(
  client: Pick<Prisma.TransactionClient, "transaction">,
  input: { householdId: string; source: string; fingerprints: string[] },
): Promise<Map<string, number[]>> {
  const fingerprints = new Set(input.fingerprints);
  const amounts = new Map<string, number[]>();
  if (fingerprints.size === 0) return amounts;
  for await (const row of scanImportTransactions(client, { householdId: input.householdId })) {
    if (row.source !== input.source || !row.sourceFingerprint || !fingerprints.has(row.sourceFingerprint)) continue;
    const matching = amounts.get(row.sourceFingerprint) ?? [];
    matching.push(row.amountFen);
    amounts.set(row.sourceFingerprint, matching);
  }
  return amounts;
}

export async function* scanImportTransactions(
  client: Pick<Prisma.TransactionClient, "transaction">,
  input: { householdId: string; excludeDeleted?: boolean },
) {
  let afterId: string | undefined;
  let byteCount = 0;
  while (true) {
    const chunk = await client.transaction.findMany({
      where: {
        householdId: input.householdId,
        ...(input.excludeDeleted ? { deletedAt: null } : {}),
        ...(afterId ? { id: { gt: afterId } } : {}),
      },
      select: { id: true, amountFen: true, source: true, sourceFingerprint: true, occurredAt: true, categoryId: true, type: true },
      orderBy: { id: "asc" },
      take: 500,
    });
    byteCount += Buffer.byteLength(JSON.stringify(chunk), "utf8");
    if (byteCount > MAX_FINANCIAL_SCAN_BYTES) throw new EncryptionRequestError("ENCRYPTION_BUDGET");
    yield* chunk;
    if (chunk.length < 500) return;
    afterId = chunk[chunk.length - 1].id;
  }
}

export async function collectWechatLegacyAmounts(
  client: Pick<Prisma.TransactionClient, "transaction">,
  input: { householdId: string; occurredAt: Date[] },
): Promise<Map<string, number[]>> {
  const timestamps = new Set(input.occurredAt.map((date) => date.toISOString()));
  const amounts = new Map<string, number[]>();
  if (timestamps.size === 0) return amounts;
  for await (const row of scanImportTransactions(client, { householdId: input.householdId })) {
    if (row.source !== WECHAT_PAY_SOURCE || row.type !== TransactionType.EXPENSE) continue;
    const key = row.occurredAt.toISOString();
    if (!timestamps.has(key)) continue;
    const matching = amounts.get(key) ?? [];
    matching.push(row.amountFen);
    amounts.set(key, matching);
  }
  return amounts;
}

export function shanghaiFinancialDate(date: Date): string {
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().slice(0, 10);
}

function addInteger(left: number, right: number): number {
  const result = left + right;
  if (!Number.isSafeInteger(result)) throw new Error("Report aggregate exceeds the supported amount range");
  return result;
}

export function aggregateFinancialAnalytics(rows: FinancialTransaction[], periods: FinancialQueryPeriod[]) {
  const categories = new Map<string, AnalyticsCategoryAggregate>();
  const days = new Map<string, AnalyticsDayAggregate>();
  const categoryMonths = new Map<string, AnalyticsCategoryMonthAggregate>();
  const amounts: number[] = [];
  const buckets = new Map<string, { key: string; amountFen: number; transactionCount: number }>();

  for (const row of rows) {
    const type = row.type === TransactionType.INCOME ? "income" : "expense";
    const date = shanghaiFinancialDate(row.occurredAt);
    for (const period of periods) {
      if (row.occurredAt < period.from || row.occurredAt > period.to) continue;
      const categoryKey = JSON.stringify([period.period, row.type, row.categoryId]);
      const category = categories.get(categoryKey) ?? {
        period: period.period, type, categoryId: row.categoryId, categoryName: row.category.name,
        amountFen: 0, transactionCount: 0,
      };
      category.amountFen = addInteger(category.amountFen, row.amountFen);
      category.transactionCount += 1;
      categories.set(categoryKey, category);

      if (type === "expense" && period.period !== "yearAgo") {
        const dayKey = `${period.period}:${date}`;
        const day = days.get(dayKey) ?? { period: period.period, date, expenseFen: 0, expenseCount: 0 };
        day.expenseFen = addInteger(day.expenseFen, row.amountFen);
        day.expenseCount += 1;
        days.set(dayKey, day);
      }
      if (period.period !== "current") continue;
      const month = date.slice(0, 7);
      const monthKey = JSON.stringify([row.type, row.categoryId, month]);
      const categoryMonth = categoryMonths.get(monthKey) ?? {
        type, categoryId: row.categoryId, categoryName: row.category.name, month,
        amountFen: 0, transactionCount: 0,
      };
      categoryMonth.amountFen = addInteger(categoryMonth.amountFen, row.amountFen);
      categoryMonth.transactionCount += 1;
      categoryMonths.set(monthKey, categoryMonth);
      if (type !== "expense") continue;
      amounts.push(row.amountFen);
      const bucket = EXPENSE_BUCKETS.find((candidate) => candidate.maxFen === null || row.amountFen <= candidate.maxFen)!;
      const total = buckets.get(bucket.key) ?? { key: bucket.key, amountFen: 0, transactionCount: 0 };
      total.amountFen = addInteger(total.amountFen, row.amountFen);
      total.transactionCount += 1;
      buckets.set(bucket.key, total);
    }
  }
  amounts.sort((left, right) => left - right);
  const middle = Math.floor(amounts.length / 2);
  const distribution: AnalyticsDistributionAggregate = {
    expenseCount: amounts.length,
    totalFen: amounts.reduce(addInteger, 0),
    medianFen: amounts.length === 0 ? null : amounts.length % 2 ? amounts[middle] : (amounts[middle - 1] + amounts[middle]) / 2,
    maxFen: amounts.at(-1) ?? null,
    topFiveAmountFen: amounts.slice(-5).reduce(addInteger, 0),
    buckets: [...buckets.values()],
  };
  return { categories: [...categories.values()], days: [...days.values()], categoryMonths: [...categoryMonths.values()], distribution };
}
