import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { CategoryType, HouseholdRole, type Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import type { ReportRange } from "@/lib/reports/report-range";

if (existsSync(".env.example")) {
  process.loadEnvFile?.(".env.example");
}

let db: typeof import("@/lib/db").db;
let queryReportAnalytics: typeof import("@/lib/reports/query-report-analytics").queryReportAnalytics;
const householdIds: string[] = [];
const userIds: string[] = [];
const categoryIds: string[] = [];
const now = new Date("2026-04-03T04:00:00.000Z");

beforeAll(async () => {
  if (!process.env.DATABASE_URL || process.env.NODE_ENV === "production") {
    throw new Error("A development database is required for report analytics tests");
  }
  const url = new URL(process.env.DATABASE_URL);
  if (!["127.0.0.1", "localhost"].includes(url.hostname) || !/(?:dev|test)/i.test(url.pathname)) {
    throw new Error("Refusing a non-local or non-development report analytics database");
  }
  ({ db } = await import("@/lib/db"));
  ({ queryReportAnalytics } = await import("@/lib/reports/query-report-analytics"));
});

afterEach(async () => {
  if (!db) return;
  await db.transaction.deleteMany({ where: { householdId: { in: householdIds } } });
  await db.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  await db.category.deleteMany({ where: { id: { in: categoryIds.splice(0) } } });
});

afterAll(async () => { await db?.$disconnect(); });

function range(to = "2026-04-03T15:59:59.999Z"): ReportRange {
  return { mode: "month", month: "2026-04", year: "2026", from: new Date("2026-03-31T16:00:00.000Z"), to: new Date(to) };
}

async function fixture() {
  const suffix = randomUUID();
  const household = await db.household.create({ data: { name: `Report analytics ${suffix}`, ledgers: { create: { name: "Default", isDefault: true } } } });
  const ledger = await db.ledger.findFirstOrThrow({ where: { householdId: household.id, isDefault: true } });
  householdIds.push(household.id);
  const members = [];
  for (const role of [HouseholdRole.OWNER, HouseholdRole.MEMBER]) {
    const user = await db.user.create({ data: { email: `report-${role}-${suffix}@example.com`, displayName: role, passwordHash: "not-used" } });
    userIds.push(user.id);
    members.push(await db.householdMember.create({ data: { householdId: household.id, userId: user.id, memberName: role, role } }));
  }
  const categories = await Promise.all([CategoryType.EXPENSE, CategoryType.INCOME].map((type) =>
    db.category.create({ data: { name: `Report ${type} ${suffix}`, type, isActive: true, sortOrder: 0 } }),
  ));
  categoryIds.push(...categories.map(({ id }) => id));
  return { householdId: household.id, ledgerId: ledger.id, owner: members[0], spouse: members[1], expense: categories[0], income: categories[1] };
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

function record(context: Fixture, overrides: Partial<Prisma.TransactionUncheckedCreateInput> = {}): Prisma.TransactionUncheckedCreateInput {
  return {
    householdId: context.householdId, actorMemberId: context.owner.id, createdByMemberId: context.owner.id,
    ledgerId: context.ledgerId,
    type: "EXPENSE", categoryId: context.expense.id, amountFen: 1000,
    occurredAt: new Date("2026-04-01T04:00:00.000Z"), note: "Private reporting fixture note",
    ...overrides,
  };
}

async function query(context: Fixture, reportRange = range(), memberId = context.owner.id) {
  return queryReportAnalytics({ householdId: context.householdId, currentMemberId: memberId, now, range: reportRange });
}

describe("queryReportAnalytics", () => {
  it("aggregates exact bucket boundaries and percentiles without exposing other households, deleted rows, or future dates", async () => {
    const context = await fixture();
    const other = await fixture();
    const amounts = [1, 4999, 5000, 19999, 20000, 49999, 50000, 99999, 100000, 499999, 500000, 500001];
    await db.transaction.createMany({ data: [
      ...amounts.map((amountFen, index) => record(context, {
        amountFen, actorMemberId: index % 2 ? context.spouse.id : context.owner.id,
        occurredAt: new Date(index % 2 ? "2026-04-02T15:59:59.999Z" : "2026-03-31T16:00:00.000Z"),
      })),
      record(context, { type: "INCOME", categoryId: context.income.id, amountFen: 3000000 }),
      record(context, { amountFen: 1, occurredAt: new Date("2025-01-01T00:00:00.000Z") }),
      record(context, { amountFen: 1000, occurredAt: new Date("2026-03-01T00:00:00.000Z") }),
      record(context, { type: "INCOME", categoryId: context.income.id, amountFen: 3000, occurredAt: new Date("2026-03-02T00:00:00.000Z") }),
      record(context, { amountFen: 2000, occurredAt: new Date("2025-04-02T00:00:00.000Z") }),
      record(context, { amountFen: 800000, deletedAt: now }),
      record(context, { amountFen: 900000, occurredAt: new Date("2026-04-03T16:00:00.000Z") }),
      record(other, { amountFen: 700000 }),
    ] });
    await expect(db.transaction.create({ data: record(context, { amountFen: 600000, actorMemberId: other.owner.id }) })).rejects.toThrow();

    const report = await query(context, range("2026-04-30T15:59:59.999Z"));
    const totalFen = amounts.reduce((total, amount) => total + amount, 0);
    expect(report.range).toEqual({ from: "2026-04-01", to: "2026-04-03" });
    expect(report.summary).toEqual({ expenseFen: totalFen, incomeFen: 3000000, netFen: 3000000 - totalFen, expenseCount: 12, incomeCount: 1, transactionCount: 13 });
    expect(report.distribution).toMatchObject({ expenseCount: 12, totalFen, medianFen: 49999.5, maxFen: 500001, topFiveAmountFen: amounts.slice(-5).reduce((total, amount) => total + amount, 0) });
    expect(report.distribution.buckets.map(({ transactionCount }) => transactionCount)).toEqual([2, 2, 2, 2, 2, 2]);
    expect(report.distribution.buckets.map(({ amountFen }) => amountFen)).toEqual([5000, 24999, 69999, 149999, 599999, 1000001]);
    expect(report.comparisons.previous).toMatchObject({ availability: "available", summary: { expenseFen: 1000, incomeFen: 3000 }, expense: { deltaFen: totalFen - 1000 } });
    expect(report.comparisons.yearAgo.summary?.expenseFen).toBe(2000);
    expect(report.daily.map(({ expenseCount }) => expenseCount)).toEqual([6, 6, 0]);
    expect(report.cumulative.at(-1)).toMatchObject({ currentFen: totalFen, previousFen: 1000 });
    expect(report.categoryMonths.expense[0]).toMatchObject({ categoryId: context.expense.id, totalFen });
    expect(report.categoryChanges.expense[0]).toMatchObject({ current: { amountFen: totalFen, transactionCount: 12, averageFen: totalFen / 12 }, previous: { amountFen: 1000, transactionCount: 1 } });
    const matchingRecords = await db.transaction.aggregate({
      where: { householdId: context.householdId, actorMemberId: { in: [context.owner.id, context.spouse.id] }, deletedAt: null, type: "EXPENSE", occurredAt: { gte: range().from, lte: range().to } },
      _sum: { amountFen: true }, _count: { _all: true },
    });
    expect(report.distribution.totalFen).toBe(matchingRecords._sum.amountFen);
    expect(report.distribution.expenseCount).toBe(matchingRecords._count._all);
    expect(JSON.stringify(report)).not.toContain("Private reporting fixture note");
  });

  it("reports only-income ranges without manufacturing spending or baseline percentages", async () => {
    const context = await fixture();
    await db.transaction.create({ data: record(context, { type: "INCOME", categoryId: context.income.id, amountFen: 12345 }) });
    const report = await query(context);
    expect(report.summary).toMatchObject({ incomeFen: 12345, expenseFen: 0, expenseCount: 0 });
    expect(report.distribution).toMatchObject({ medianFen: null, maxFen: null, topFiveShare: null, expenseCount: 0 });
    expect(report.comparisons.previous).toMatchObject({ availability: "missing", income: { deltaFen: null, ratio: null } });
    expect(report.daily.every(({ expenseFen }) => expenseFen === 0)).toBe(true);
    expect(report.categoryMonths.expense).toEqual([]);
    expect(report.categoryMonths.income[0].totalFen).toBe(12345);
  });

  it("uses every expense when fewer than five exist and retains an even median half-fen", async () => {
    const context = await fixture();
    await db.transaction.createMany({ data: [record(context, { amountFen: 100 }), record(context, { amountFen: 101 })] });
    const report = await query(context);
    expect(report.distribution).toMatchObject({ expenseCount: 2, medianFen: 100.5, maxFen: 101, topFiveAmountFen: 201, topFiveShare: 1 });
  });

  it("rejects a member from another household and a forged household identity", async () => {
    const context = await fixture();
    const other = await fixture();
    await expect(query(context, range(), other.owner.id)).rejects.toThrow("Unauthorized");
    await expect(query({ ...context, householdId: "' OR 1=1 --" })).rejects.toThrow("Unauthorized");
  });

  it("keeps future-only and deleted-only households empty", async () => {
    const context = await fixture();
    await db.transaction.createMany({ data: [
      record(context, { occurredAt: new Date("2026-04-04T00:00:00.000Z") }),
      record(context, { deletedAt: now }),
    ] });
    const report = await query(context);
    expect(report.firstRecordedDate).toBeNull();
    expect(report.summary.transactionCount).toBe(0);
    expect(report.distribution.buckets.every(({ transactionCount }) => transactionCount === 0)).toBe(true);
  });

  it("limits old custom chart spans while retaining the complete query window", async () => {
    const context = await fixture();
    await db.transaction.create({ data: record(context) });
    const report = await query(context, {
      ...range(), mode: "custom", start: "0001-01-01", end: "2026-04-03", from: new Date("0001-01-01T00:00:00.000+08:00"),
    });
    expect(report.range.from).toBe("0001-01-01");
    expect(report.summary.expenseFen).toBe(1000);
    expect(report.comparisons.previous.availability).toBe("not-applicable");
    expect(report.daily).toHaveLength(3);
    expect(report.categoryMonths.months).toEqual(["2026-04"]);
  });
});
