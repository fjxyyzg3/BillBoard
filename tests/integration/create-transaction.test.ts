import { existsSync } from "node:fs";
import path from "node:path";
import { readFileSync } from "node:fs";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

if (existsSync(".env")) {
  process.loadEnvFile?.(".env");
}

if (existsSync(".env.example")) {
  process.loadEnvFile?.(".env.example");
}

import { CategoryType, HouseholdRole, TransactionType } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import { CategoryPicker } from "@/components/category-picker";

type SessionUser = {
  householdId: string;
  memberId: string;
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

const createdTransactionIds: string[] = [];
const createdHouseholdIds: string[] = [];
const createdMemberIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  ({ db } = await import("@/lib/db"));
  ({ createTransaction } = await import("@/lib/transactions/create-transaction"));
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
  await db.$disconnect();
});

async function getSeedFixture() {
  const ownerEmail = process.env.SEED_USER_A_EMAIL ?? "me@example.com";
  const actorEmail = process.env.SEED_USER_B_EMAIL ?? ownerEmail;

  const [ownerMember, actorMember, expenseCategory, incomeCategory] = await Promise.all([
    db.householdMember.findFirstOrThrow({
      where: { user: { email: ownerEmail } },
      include: { household: true },
    }),
    db.householdMember.findFirstOrThrow({
      where: { user: { email: actorEmail } },
    }),
    db.category.findUniqueOrThrow({
      where: { type_name: { type: CategoryType.EXPENSE, name: "Dining" } },
    }),
    db.category.findUniqueOrThrow({
      where: { type_name: { type: CategoryType.INCOME, name: "Salary" } },
    }),
  ]);

  return { ownerMember, actorMember, expenseCategory, incomeCategory };
}

async function createOutsideMember() {
  const suffix = Date.now().toString(36);
  const household = await db.household.create({
    data: {
      name: `Other ${suffix}`,
    },
  });
  createdHouseholdIds.push(household.id);

  const user = await db.user.create({
    data: {
      email: `outside-${suffix}@example.com`,
      displayName: `Outside ${suffix}`,
      passwordHash: "not-used",
    },
  });
  createdUserIds.push(user.id);

  const member = await db.householdMember.create({
    data: {
      householdId: household.id,
      userId: user.id,
      memberName: `Outside ${suffix}`,
      role: HouseholdRole.MEMBER,
    },
  });
  createdMemberIds.push(member.id);

  return member;
}

describe("createTransaction", () => {
  it("creates an expense transaction for the current household", async () => {
    const { ownerMember, actorMember, expenseCategory } = await getSeedFixture();

    const result = await createTransaction(
      {
        type: "expense",
        amount: "18.60",
        categoryId: expenseCategory.id,
        actorMemberId: actorMember.id,
        occurredAt: "2026-04-26T08:30",
        note: "Hot pot",
      },
      {
        householdId: ownerMember.householdId,
        memberId: ownerMember.id,
      },
    );

    createdTransactionIds.push(result.id);

    const created = await db.transaction.findUniqueOrThrow({
      where: { id: result.id },
    });

    expect(created.householdId).toBe(ownerMember.householdId);
    expect(created.type).toBe(TransactionType.EXPENSE);
    expect(created.categoryId).toBe(expenseCategory.id);
    expect(created.actorMemberId).toBe(actorMember.id);
    expect(created.createdByMemberId).toBe(ownerMember.id);
    expect(created.amountFen).toBe(1860);
    expect(created.occurredAt.toISOString()).toBe("2026-04-26T00:30:00.000Z");
    expect(created.note).toBe("Hot pot");
  });

  it("rejects a category whose type does not match the selected transaction type", async () => {
    const { ownerMember, actorMember, incomeCategory } = await getSeedFixture();

    await expect(
      createTransaction(
        {
          type: "expense",
          amount: "88.00",
          categoryId: incomeCategory.id,
          actorMemberId: actorMember.id,
          occurredAt: "2026-04-26T09:00",
        },
        {
          householdId: ownerMember.householdId,
          memberId: ownerMember.id,
        },
      ),
    ).rejects.toThrow("Category does not match transaction type");
  });

  it("rejects an actor member outside the current household", async () => {
    const { ownerMember, expenseCategory } = await getSeedFixture();
    const outsideMember = await createOutsideMember();

    await expect(
      createTransaction(
        {
          type: "expense",
          amount: "45.00",
          categoryId: expenseCategory.id,
          actorMemberId: outsideMember.id,
          occurredAt: "2026-04-26T09:30",
        },
        {
          householdId: ownerMember.householdId,
          memberId: ownerMember.id,
        },
      ),
    ).rejects.toThrow("Actor member must belong to the current household");
  });
});

describe("transaction form follow-up UI requirements", () => {
  it("renders categories as quick-tap buttons instead of a select", () => {
    const markup = renderToStaticMarkup(
      createElement(CategoryPicker, {
        categories: [
          { id: "expense-1", name: "Dining", type: "expense" },
          { id: "expense-2", name: "Groceries", type: "expense" },
          { id: "income-1", name: "Salary", type: "income" },
        ],
        label: "Category",
        locale: "en-US",
        onSelect: () => {},
        selectedCategoryId: "expense-1",
        selectedType: "expense",
      }),
    );

    expect(markup).not.toContain("<select");
    expect(markup).toContain('type="button"');
  });

  it("autofocuses the amount field on page open", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/components/transaction-form.tsx"),
      "utf8",
    );

    expect(source).toContain("autoFocus");
  });

  it("offers add-another and return-home actions after a successful save", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/components/transaction-form.tsx"),
      "utf8",
    );

    expect(source).toContain("labels.common.addAnother");
    expect(source).toContain("href={nextAddHref}");
    expect(source).toContain("labels.common.returnHome");
    expect(source).toContain("href={homeHref}");
  });
});
