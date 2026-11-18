import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile?.(".env");
}

if (existsSync(".env.example")) {
  process.loadEnvFile?.(".env.example");
}

import { CategoryType, HouseholdRole } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type SessionUser = {
  householdId: string;
  memberId: string;
};

type HouseholdFixture = {
  householdId: string;
  ownerMember: {
    id: string;
    householdId: string;
    memberName: string;
  };
  spouseMember: {
    id: string;
    householdId: string;
    memberName: string;
  };
};

let db: typeof import("@/lib/db").db;
let createTransaction: (input: {
  type: string;
  amount: string;
  categoryId: string;
  actorMemberId: string;
  occurredAt: string;
  note?: string;
}, sessionUser: SessionUser) => Promise<{
  id: string;
}>;
let queryHomeReport: typeof import("@/lib/reports/query-home-report").queryHomeReport;

const createdHouseholdIds: string[] = [];
const createdMemberIds: string[] = [];
const createdTransactionIds: string[] = [];
const createdUserIds: string[] = [];

let uniqueCounter = 0;

async function fixtureEntryContext(session: SessionUser) {
  const ledger = await db.ledger.findFirstOrThrow({ where: { householdId: session.householdId, isDefault: true } });
  return { householdId: session.householdId, memberId: session.memberId, ledgerId: ledger.id };
}

beforeAll(async () => {
  ({ db } = await import("@/lib/db"));
  const transactionModule = await import("@/lib/transactions/create-transaction");
  createTransaction = async (input, sessionUser) =>
    transactionModule.createTransaction(
      { ...input, context: await fixtureEntryContext(sessionUser), clientRequestId: randomUUID() },
      sessionUser,
    );
  ({ queryHomeReport } = await import("@/lib/reports/query-home-report"));
});

afterEach(async () => {
  await db.ledgerAuditLog.deleteMany({ where: { OR: [{ householdId: { in: createdHouseholdIds } }, { targetId: { in: createdTransactionIds } }] } });
  if (createdTransactionIds.length > 0) {
    await db.transaction.deleteMany({
      where: { id: { in: createdTransactionIds.splice(0, createdTransactionIds.length) } },
    });
  }

  if (createdMemberIds.length > 0) {
    await db.householdMember.deleteMany({
      where: { id: { in: createdMemberIds.splice(0, createdMemberIds.length) } },
    });
  }

  if (createdUserIds.length > 0) {
    await db.user.deleteMany({
      where: { id: { in: createdUserIds.splice(0, createdUserIds.length) } },
    });
  }

  if (createdHouseholdIds.length > 0) {
    await db.household.deleteMany({
      where: { id: { in: createdHouseholdIds.splice(0, createdHouseholdIds.length) } },
    });
  }
});

afterAll(async () => {
  await db?.$disconnect();
});

function nextSuffix() {
  uniqueCounter += 1;
  return `${Date.now().toString(36)}-${uniqueCounter}`;
}

async function getSeedCategories() {
  const [bonusCategory, diningCategory, travelCategory, salaryCategory] = await Promise.all([
    db.category.findUniqueOrThrow({
      where: { type_name: { type: CategoryType.INCOME, name: "Bonus" } },
    }),
    db.category.findUniqueOrThrow({
      where: { type_name: { type: CategoryType.EXPENSE, name: "Dining" } },
    }),
    db.category.findUniqueOrThrow({
      where: { type_name: { type: CategoryType.EXPENSE, name: "Travel" } },
    }),
    db.category.findUniqueOrThrow({
      where: { type_name: { type: CategoryType.INCOME, name: "Salary" } },
    }),
  ]);

  return { bonusCategory, diningCategory, travelCategory, salaryCategory };
}

async function createHouseholdFixture(): Promise<HouseholdFixture> {
  const suffix = nextSuffix();
  const household = await db.household.create({
    data: {
      name: `Dashboard Household ${suffix}`,
      ledgers: { create: { name: "Default", isDefault: true } },
    },
  });
  createdHouseholdIds.push(household.id);

  const ownerUser = await db.user.create({
    data: {
      email: `dashboard-owner-${suffix}@example.com`,
      displayName: `Owner ${suffix}`,
      passwordHash: "not-used",
    },
  });
  const spouseUser = await db.user.create({
    data: {
      email: `dashboard-spouse-${suffix}@example.com`,
      displayName: `Spouse ${suffix}`,
      passwordHash: "not-used",
    },
  });
  createdUserIds.push(ownerUser.id, spouseUser.id);

  const ownerMember = await db.householdMember.create({
    data: {
      householdId: household.id,
      userId: ownerUser.id,
      memberName: `Owner ${suffix}`,
      role: HouseholdRole.OWNER,
    },
    select: { id: true, householdId: true, memberName: true },
  });
  const spouseMember = await db.householdMember.create({
    data: {
      householdId: household.id,
      userId: spouseUser.id,
      memberName: `Spouse ${suffix}`,
      role: HouseholdRole.MEMBER,
    },
    select: { id: true, householdId: true, memberName: true },
  });
  createdMemberIds.push(ownerMember.id, spouseMember.id);

  return {
    householdId: household.id,
    ownerMember,
    spouseMember,
  };
}

describe("queryHomeReport", () => {
  it("preserves a wide custom range and totals while starting its chart at the first recorded month", async () => {
    const { diningCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();

    for (const occurredAt of ["2026-03-20T12:00", "2026-04-25T12:00"]) {
      const transaction = await createTransaction(
        { type: "expense", amount: "25.00", categoryId: diningCategory.id, actorMemberId: household.ownerMember.id, occurredAt },
        { householdId: household.householdId, memberId: household.ownerMember.id },
      );
      createdTransactionIds.push(transaction.id);
    }

    const report = await queryHomeReport({
      currentMemberId: household.ownerMember.id,
      householdId: household.householdId,
      now: new Date("2026-04-26T04:00:00.000Z"),
      range: { mode: "custom", month: "2026-04", year: "2026", start: "0001-01-01", end: "2026-04-26" },
    });

    expect(report.range).toMatchObject({
      mode: "custom",
      start: "0001-01-01",
      end: "2026-04-26",
      from: new Date("0001-01-01T00:00:00.000+08:00"),
      to: new Date("2026-04-26T15:59:59.999Z"),
    });
    expect(report.summary).toEqual({ incomeFen: 0, expenseFen: 5000, netFen: -5000, transactionCount: 2 });
    expect(report.trend.points.map((point) => point.bucketKey)).toEqual(["2026-03", "2026-04"]);
    expect(report.trend.points.map((point) => point.expenseFen)).toEqual([2500, 2500]);
    expect(report.trend.points[0]?.bucketStart).toEqual(new Date("2026-02-28T16:00:00.000Z"));
    expect(report.balanceTrend.points.map((point) => point.bucketKey)).toEqual(["2026-03", "2026-04"]);
    expect(report.balanceTrend.points.map((point) => point.netFen)).toEqual([-2500, -2500]);
    expect(report.balanceTrend.points.map((point) => point.cumulativeNetFen)).toEqual([-2500, -5000]);
    expect(report.balanceTrend.points.at(-1)?.cumulativeNetFen).toBe(report.summary.netFen);
  });

  it("shows only the last selected month for an empty custom report without changing its range", async () => {
    const household = await createHouseholdFixture();
    const report = await queryHomeReport({
      currentMemberId: household.ownerMember.id,
      householdId: household.householdId,
      now: new Date("2026-04-26T04:00:00.000Z"),
      range: { mode: "custom", month: "2026-04", year: "2026", start: "0001-01-01", end: "2026-03-17" },
    });

    expect(report.range).toMatchObject({ start: "0001-01-01", end: "2026-03-17" });
    expect(report.summary.transactionCount).toBe(0);
    expect(report.trend.points).toHaveLength(1);
    expect(report.trend.points[0]).toMatchObject({
      bucketKey: "2026-03",
      bucketStart: new Date("2026-02-28T16:00:00.000Z"),
      bucketEnd: new Date("2026-03-17T15:59:59.999Z"),
      expenseFen: 0,
      incomeFen: 0,
    });
    expect(report.balanceTrend.points).toHaveLength(1);
    expect(report.balanceTrend.points[0]).toMatchObject({
      bucketKey: "2026-03", netFen: 0, cumulativeNetFen: 0,
      bucketStart: new Date("2026-02-28T16:00:00.000Z"),
      bucketEnd: new Date("2026-03-17T15:59:59.999Z"),
    });
  });

  it("derives monthly and cumulative balances only from a partial custom range", async () => {
    const { salaryCategory, diningCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();
    const entries = [
      { type: "income", amount: "9999.00", occurredAt: "2026-05-09T12:00" },
      { type: "income", amount: "30.00", occurredAt: "2026-05-10T00:00" },
      { type: "expense", amount: "10.00", occurredAt: "2026-05-31T23:59" },
      { type: "income", amount: "20.00", occurredAt: "2026-06-01T00:00" },
      { type: "expense", amount: "5.00", occurredAt: "2026-06-06T23:59" },
      { type: "income", amount: "8888.00", occurredAt: "2026-06-07T00:00" },
    ];
    for (const entry of entries) {
      const created = await createTransaction({
        ...entry,
        actorMemberId: household.ownerMember.id,
        categoryId: entry.type === "income" ? salaryCategory.id : diningCategory.id,
      }, { householdId: household.householdId, memberId: household.ownerMember.id });
      createdTransactionIds.push(created.id);
    }

    const report = await queryHomeReport({
      currentMemberId: household.ownerMember.id,
      householdId: household.householdId,
      now: new Date("2026-06-20T04:00:00.000Z"),
      range: { mode: "custom", month: "2026-06", year: "2026", start: "2026-05-10", end: "2026-06-06" },
    });

    expect(report.balanceTrend.points.map(({ bucketKey, netFen, cumulativeNetFen }) => ({ bucketKey, netFen, cumulativeNetFen }))).toEqual([
      { bucketKey: "2026-05", netFen: 2000, cumulativeNetFen: 2000 },
      { bucketKey: "2026-06", netFen: 1500, cumulativeNetFen: 3500 },
    ]);
    expect(report.balanceTrend.points[0].bucketStart).toEqual(new Date("2026-05-09T16:00:00.000Z"));
    expect(report.balanceTrend.points[1].bucketEnd).toEqual(new Date("2026-06-06T15:59:59.999Z"));
    expect(report.balanceTrend.points.at(-1)?.cumulativeNetFen).toBe(report.summary.netFen);
    expect(report.summary.transactionCount).toBe(4);
  });

  it.each(["me", "spouse"] as const)("summarizes the household while ignoring legacy %s perspective", async (perspective) => {
    const { bonusCategory, diningCategory, travelCategory, salaryCategory } =
      await getSeedCategories();
    const household = await createHouseholdFixture();
    const otherHousehold = await createHouseholdFixture();

    const ownerSalary = await createTransaction(
      {
        type: "income",
        amount: "5000.00",
        categoryId: salaryCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-25T08:30",
        note: "Payroll",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const spouseBonus = await createTransaction(
      {
        type: "income",
        amount: "300.00",
        categoryId: bonusCategory.id,
        actorMemberId: household.spouseMember.id,
        occurredAt: "2026-03-20T09:00",
        note: "Bonus",
      },
      {
        householdId: household.householdId,
        memberId: household.spouseMember.id,
      },
    );
    const spouseDining = await createTransaction(
      {
        type: "expense",
        amount: "25.00",
        categoryId: diningCategory.id,
        actorMemberId: household.spouseMember.id,
        occurredAt: "2026-04-24T19:00",
        note: "Dinner",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const ownerTravel = await createTransaction(
      {
        type: "expense",
        amount: "100.00",
        categoryId: travelCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-01-15T07:15",
        note: "Train",
      },
      {
        householdId: household.householdId,
        memberId: household.spouseMember.id,
      },
    );
    const deletedSpouseExpense = await createTransaction(
      {
        type: "expense",
        amount: "9.00",
        categoryId: diningCategory.id,
        actorMemberId: household.spouseMember.id,
        occurredAt: "2026-04-24T12:00",
        note: "Deleted",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const otherHouseholdIncome = await createTransaction(
      {
        type: "income",
        amount: "888.00",
        categoryId: salaryCategory.id,
        actorMemberId: otherHousehold.ownerMember.id,
        occurredAt: "2026-04-25T08:00",
        note: "Other household",
      },
      {
        householdId: otherHousehold.householdId,
        memberId: otherHousehold.ownerMember.id,
      },
    );
    createdTransactionIds.push(
      ownerSalary.id,
      spouseBonus.id,
      spouseDining.id,
      ownerTravel.id,
      deletedSpouseExpense.id,
      otherHouseholdIncome.id,
    );

    await db.transaction.update({
      where: { id: deletedSpouseExpense.id },
      data: { deletedAt: new Date("2026-04-24T08:00:00.000Z") },
    });

    const transactionFindManySpy = vi.spyOn(db.transaction, "findMany");

    try {
      const legacyInput = {
        currentMemberId: household.ownerMember.id,
        householdId: household.householdId,
        now: new Date("2026-04-26T04:00:00.000Z"),
        perspective,
        range: { mode: "all" as const, month: "2026-04", year: "2026" },
      };
      const report = await queryHomeReport(legacyInput);

      expect(report.summary).toEqual({
        expenseFen: 12500,
        incomeFen: 530000,
        netFen: 517500,
        transactionCount: 4,
      });
      expect(report.categories.expense.items).toHaveLength(2);
      expect(report.categories.expense.items[0]).toMatchObject({
        amountFen: 10000,
        categoryId: travelCategory.id,
        transactionCount: 1,
      });
      expect(report.categories.expense.items[1]).toMatchObject({
        amountFen: 2500,
        categoryId: diningCategory.id,
        transactionCount: 1,
      });
      expect(report.categories.income.items).toHaveLength(2);
      expect(report.categories.income.items[0]).toMatchObject({
        amountFen: 500000,
        categoryId: salaryCategory.id,
        transactionCount: 1,
      });
      expect(report.categories.income.items[1]).toMatchObject({
        amountFen: 30000,
        categoryId: bonusCategory.id,
        transactionCount: 1,
      });
      expect(report.range).toMatchObject({
        from: new Date("2026-01-14T16:00:00.000Z"),
        mode: "all",
        to: new Date("2026-04-26T15:59:59.999Z"),
      });
      expect(report.rangeOptions.months).toEqual(["2026-04", "2026-03", "2026-02", "2026-01"]);
      expect(report.rangeOptions.years).toEqual(["2026"]);
      expect(report.trend.granularity).toBe("month");
      expect(report.trend.points.find((point) => point.bucketKey === "2026-03")).toMatchObject({
        incomeFen: 30000,
        expenseFen: 0,
        transactionCount: 1,
      });
      expect(report.trend.points.find((point) => point.bucketKey === "2026-04")).toMatchObject({
        incomeFen: 500000,
        expenseFen: 2500,
        transactionCount: 2,
      });
      expect(report.balanceTrend.points.map((point) => point.netFen)).toEqual([-10000, 0, 30000, 497500]);
      expect(report.balanceTrend.points.map((point) => point.cumulativeNetFen)).toEqual([-10000, -10000, 20000, 517500]);
      expect(report.balanceTrend.points.at(-1)?.cumulativeNetFen).toBe(report.summary.netFen);
      const spouseReport = await queryHomeReport({
        ...legacyInput,
        currentMemberId: household.spouseMember.id,
      });
      expect(spouseReport).toEqual(report);
      const ownerAprilReport = await queryHomeReport({
        ...legacyInput,
        actorMemberId: household.ownerMember.id,
        range: { mode: "month", month: "2026-04", year: "2026" },
      });
      expect(ownerAprilReport.balanceTrend.points).toHaveLength(1);
      expect(ownerAprilReport.balanceTrend.points[0]).toMatchObject({
        bucketKey: "2026-04", netFen: 500000, cumulativeNetFen: 500000, transactionCount: 1,
      });
      expect(transactionFindManySpy).not.toHaveBeenCalled();
    } finally {
      transactionFindManySpy.mockRestore();
    }
  });

  it("rejects a current member outside the requested household", async () => {
    const household = await createHouseholdFixture();
    const otherHousehold = await createHouseholdFixture();

    await expect(
      queryHomeReport({
        currentMemberId: otherHousehold.ownerMember.id,
        householdId: household.householdId,
        now: new Date("2026-04-26T04:00:00.000Z"),
        range: { mode: "month", month: "2026-04", year: "2026" },
      }),
    ).rejects.toThrow("Unauthorized");
  });
});
