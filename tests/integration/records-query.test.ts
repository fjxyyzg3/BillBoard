import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile?.(".env");
}

if (existsSync(".env.example")) {
  process.loadEnvFile?.(".env.example");
}

import { CategoryType, HouseholdRole, TransactionType } from "@prisma/client";
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
let listRecords: typeof import("@/lib/records/list-records").listRecords;
let updateTransaction: typeof import("@/lib/transactions/update-transaction").updateTransaction;
let deleteTransaction: typeof import("@/lib/transactions/delete-transaction").deleteTransaction;

const createdHouseholdIds: string[] = [];
const createdMemberIds: string[] = [];
const createdTransactionIds: string[] = [];
const createdUserIds: string[] = [];

let uniqueCounter = 0;

beforeAll(async () => {
  ({ db } = await import("@/lib/db"));
  ({ createTransaction } = await import("@/lib/transactions/create-transaction"));
  ({ listRecords } = await import("@/lib/records/list-records"));
  ({ updateTransaction } = await import("@/lib/transactions/update-transaction"));
  ({ deleteTransaction } = await import("@/lib/transactions/delete-transaction"));
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
  const [expenseCategory, incomeCategory] = await Promise.all([
    db.category.findUniqueOrThrow({
      where: { type_name: { type: CategoryType.EXPENSE, name: "Dining" } },
    }),
    db.category.findUniqueOrThrow({
      where: { type_name: { type: CategoryType.INCOME, name: "Salary" } },
    }),
  ]);

  return { expenseCategory, incomeCategory };
}

async function createHouseholdFixture(): Promise<HouseholdFixture> {
  const suffix = nextSuffix();
  const household = await db.household.create({
    data: {
      name: `Household ${suffix}`,
    },
  });
  createdHouseholdIds.push(household.id);

  const ownerUser = await db.user.create({
    data: {
      email: `owner-${suffix}@example.com`,
      displayName: `Owner ${suffix}`,
      passwordHash: "not-used",
    },
  });
  const spouseUser = await db.user.create({
    data: {
      email: `spouse-${suffix}@example.com`,
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

describe("records helpers", () => {
  it("lists the newest in-range records for the household and hides soft deletes", async () => {
    const { expenseCategory, incomeCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();
    const otherHousehold = await createHouseholdFixture();

    const olderRecord = await createTransaction(
      {
        type: "expense",
        amount: "31.50",
        categoryId: expenseCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-03-10T09:00",
        note: "Outside the visible range",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const visibleExpense = await createTransaction(
      {
        type: "expense",
        amount: "18.60",
        categoryId: expenseCategory.id,
        actorMemberId: household.spouseMember.id,
        occurredAt: "2026-04-23T08:15",
        note: "Hot pot dinner after work",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const visibleIncome = await createTransaction(
      {
        type: "income",
        amount: "5000.00",
        categoryId: incomeCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-25T09:45",
        note: "Monthly salary transfer",
      },
      {
        householdId: household.householdId,
        memberId: household.spouseMember.id,
      },
    );
    const deletedRecord = await createTransaction(
      {
        type: "expense",
        amount: "9.90",
        categoryId: expenseCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-24T18:00",
        note: "Should be hidden after delete",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const otherHouseholdRecord = await createTransaction(
      {
        type: "expense",
        amount: "77.00",
        categoryId: expenseCategory.id,
        actorMemberId: otherHousehold.ownerMember.id,
        occurredAt: "2026-04-25T11:00",
        note: "Other household",
      },
      {
        householdId: otherHousehold.householdId,
        memberId: otherHousehold.ownerMember.id,
      },
    );
    createdTransactionIds.push(
      olderRecord.id,
      visibleExpense.id,
      visibleIncome.id,
      deletedRecord.id,
      otherHouseholdRecord.id,
    );

    await db.transaction.update({
      where: { id: deletedRecord.id },
      data: { deletedAt: new Date("2026-04-25T12:00:00.000Z") },
    });

    const records = await listRecords({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      timezone: "Asia/Shanghai",
      rangePreset: "last-30-days",
      perspective: "household",
      now: new Date("2026-04-26T04:00:00.000Z"),
    });

    expect(records.map((record) => record.id)).toEqual([visibleIncome.id, visibleExpense.id]);
    expect(records[0]).toMatchObject({
      id: visibleIncome.id,
      type: "income",
      categoryId: incomeCategory.id,
      categoryName: "Salary",
      amountFen: 500000,
      actorMemberId: household.ownerMember.id,
      actorMemberName: household.ownerMember.memberName,
      createdByMemberId: household.spouseMember.id,
      createdByMemberName: household.spouseMember.memberName,
      note: "Monthly salary transfer",
    });
    expect(records[1]).toMatchObject({
      id: visibleExpense.id,
      type: "expense",
      categoryId: expenseCategory.id,
      categoryName: "Dining",
      amountFen: 1860,
      actorMemberId: household.spouseMember.id,
      actorMemberName: household.spouseMember.memberName,
      createdByMemberId: household.ownerMember.id,
      createdByMemberName: household.ownerMember.memberName,
      note: "Hot pot dinner after work",
    });
  });

  it("applies perspective, type, and category filters together", async () => {
    const { expenseCategory, incomeCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();

    const myExpense = await createTransaction(
      {
        type: "expense",
        amount: "26.00",
        categoryId: expenseCategory.id,
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
        amount: "42.00",
        categoryId: expenseCategory.id,
        actorMemberId: household.spouseMember.id,
        occurredAt: "2026-04-25T12:00",
        note: "Lunch",
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
        categoryId: incomeCategory.id,
        actorMemberId: household.spouseMember.id,
        occurredAt: "2026-04-24T08:00",
        note: "Freelance",
      },
      {
        householdId: household.householdId,
        memberId: household.spouseMember.id,
      },
    );
    createdTransactionIds.push(myExpense.id, spouseExpense.id, spouseIncome.id);

    const myExpenseRecords = await listRecords({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      timezone: "Asia/Shanghai",
      rangePreset: "last-30-days",
      perspective: "me",
      type: "expense",
      categoryId: expenseCategory.id,
      now: new Date("2026-04-26T04:00:00.000Z"),
    });

    expect(myExpenseRecords.map((record) => record.id)).toEqual([myExpense.id]);

    const spouseRecords = await listRecords({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      timezone: "Asia/Shanghai",
      rangePreset: "last-30-days",
      perspective: "spouse",
      now: new Date("2026-04-26T04:00:00.000Z"),
    });

    expect(spouseRecords.map((record) => record.id)).toEqual([spouseExpense.id, spouseIncome.id]);
  });

  it("updates mutable transaction fields for any household member", async () => {
    const { expenseCategory, incomeCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();

    const original = await createTransaction(
      {
        type: "expense",
        amount: "18.60",
        categoryId: expenseCategory.id,
        actorMemberId: household.spouseMember.id,
        occurredAt: "2026-04-23T08:15",
        note: "Hot pot",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    createdTransactionIds.push(original.id);

    await updateTransaction(
      original.id,
      {
        type: "income",
        amount: "99.90",
        categoryId: incomeCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-26T10:45",
        note: "Corrected reimbursement",
      },
      {
        householdId: household.householdId,
        memberId: household.spouseMember.id,
      },
    );

    const updated = await db.transaction.findUniqueOrThrow({
      where: { id: original.id },
    });

    expect(updated.type).toBe(TransactionType.INCOME);
    expect(updated.categoryId).toBe(incomeCategory.id);
    expect(updated.actorMemberId).toBe(household.ownerMember.id);
    expect(updated.createdByMemberId).toBe(household.ownerMember.id);
    expect(updated.amountFen).toBe(9990);
    expect(updated.occurredAt.toISOString()).toBe("2026-04-26T02:45:00.000Z");
    expect(updated.note).toBe("Corrected reimbursement");
  });

  it("soft deletes household transactions and removes them from listings", async () => {
    const { expenseCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();

    const transaction = await createTransaction(
      {
        type: "expense",
        amount: "12.00",
        categoryId: expenseCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-25T08:00",
        note: "Coffee beans",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    createdTransactionIds.push(transaction.id);

    await deleteTransaction(transaction.id, {
      householdId: household.householdId,
      memberId: household.spouseMember.id,
    });

    const deleted = await db.transaction.findUniqueOrThrow({
      where: { id: transaction.id },
    });
    const records = await listRecords({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      timezone: "Asia/Shanghai",
      rangePreset: "last-30-days",
      perspective: "household",
      now: new Date("2026-04-26T04:00:00.000Z"),
    });

    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(records).toEqual([]);
  });
});
