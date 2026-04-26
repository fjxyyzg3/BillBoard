import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile?.(".env");
}

if (existsSync(".env.example")) {
  process.loadEnvFile?.(".env.example");
}

import { CategoryType, HouseholdRole } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

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
let queryDashboard: typeof import("@/lib/reports/query-dashboard").queryDashboard;

const createdHouseholdIds: string[] = [];
const createdMemberIds: string[] = [];
const createdTransactionIds: string[] = [];
const createdUserIds: string[] = [];

let uniqueCounter = 0;

beforeAll(async () => {
  ({ db } = await import("@/lib/db"));
  ({ createTransaction } = await import("@/lib/transactions/create-transaction"));
  ({ queryDashboard } = await import("@/lib/reports/query-dashboard"));
});

afterEach(async () => {
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
  const [diningCategory, travelCategory, salaryCategory] = await Promise.all([
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

  return { diningCategory, travelCategory, salaryCategory };
}

async function createHouseholdFixture(): Promise<HouseholdFixture> {
  const suffix = nextSuffix();
  const household = await db.household.create({
    data: {
      name: `Dashboard Household ${suffix}`,
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

describe("queryDashboard", () => {
  it("summarizes non-deleted household transactions in range", async () => {
    const { diningCategory, travelCategory, salaryCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();
    const otherHousehold = await createHouseholdFixture();

    const salary = await createTransaction(
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
    const dining = await createTransaction(
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
    const travel = await createTransaction(
      {
        type: "expense",
        amount: "100.00",
        categoryId: travelCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-23T07:15",
        note: "Train",
      },
      {
        householdId: household.householdId,
        memberId: household.spouseMember.id,
      },
    );
    const deletedExpense = await createTransaction(
      {
        type: "expense",
        amount: "9.00",
        categoryId: diningCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-24T12:00",
        note: "Deleted",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const otherHouseholdExpense = await createTransaction(
      {
        type: "expense",
        amount: "88.00",
        categoryId: diningCategory.id,
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
      salary.id,
      dining.id,
      travel.id,
      deletedExpense.id,
      otherHouseholdExpense.id,
    );

    await db.transaction.update({
      where: { id: deletedExpense.id },
      data: { deletedAt: new Date("2026-04-24T08:00:00.000Z") },
    });

    const dashboard = await queryDashboard({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      perspective: "household",
      rangePreset: "last-30-days",
      now: new Date("2026-04-26T04:00:00.000Z"),
    });

    expect(dashboard.summary).toEqual({
      expenseFen: 12500,
      incomeFen: 500000,
      netFen: 487500,
      transactionCount: 3,
    });
    expect(dashboard.categories.items.map((item) => item.categoryName)).toEqual([
      "Travel",
      "Dining",
    ]);
    expect(dashboard.recentTransactions.map((transaction) => transaction.id)).toEqual([
      salary.id,
      dining.id,
      travel.id,
    ]);
    expect(dashboard.trend.points.find((point) => point.bucketKey === "2026-04-25")).toMatchObject({
      incomeFen: 500000,
      expenseFen: 0,
      transactionCount: 1,
    });
    expect(dashboard.trend.points.find((point) => point.bucketKey === "2026-04-24")).toMatchObject({
      incomeFen: 0,
      expenseFen: 2500,
      transactionCount: 1,
    });
  });

  it("applies perspective filters before aggregating", async () => {
    const { diningCategory, travelCategory, salaryCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();

    const myExpense = await createTransaction(
      {
        type: "expense",
        amount: "18.60",
        categoryId: diningCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-25T07:30",
        note: "Breakfast",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const spouseExpense = await createTransaction(
      {
        type: "expense",
        amount: "88.00",
        categoryId: travelCategory.id,
        actorMemberId: household.spouseMember.id,
        occurredAt: "2026-04-24T18:00",
        note: "Taxi",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const spouseIncome = await createTransaction(
      {
        type: "income",
        amount: "800.00",
        categoryId: salaryCategory.id,
        actorMemberId: household.spouseMember.id,
        occurredAt: "2026-04-23T09:00",
        note: "Freelance",
      },
      {
        householdId: household.householdId,
        memberId: household.spouseMember.id,
      },
    );
    createdTransactionIds.push(myExpense.id, spouseExpense.id, spouseIncome.id);

    const mine = await queryDashboard({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      perspective: "me",
      rangePreset: "last-30-days",
      now: new Date("2026-04-26T04:00:00.000Z"),
    });
    const spouse = await queryDashboard({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      perspective: "spouse",
      rangePreset: "last-30-days",
      now: new Date("2026-04-26T04:00:00.000Z"),
    });

    expect(mine.summary).toEqual({
      expenseFen: 1860,
      incomeFen: 0,
      netFen: -1860,
      transactionCount: 1,
    });
    expect(mine.categories.items).toHaveLength(1);
    expect(mine.categories.items[0]).toMatchObject({
      categoryId: diningCategory.id,
      amountFen: 1860,
    });

    expect(spouse.summary).toEqual({
      expenseFen: 8800,
      incomeFen: 80000,
      netFen: 71200,
      transactionCount: 2,
    });
    expect(spouse.recentTransactions.map((transaction) => transaction.id)).toEqual([
      spouseExpense.id,
      spouseIncome.id,
    ]);
  });
});
