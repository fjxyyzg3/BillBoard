import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile?.(".env");
}

if (existsSync(".env.example")) {
  process.loadEnvFile?.(".env.example");
}

import { CategoryType, HouseholdRole, TransactionType } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

vi.mock("server-only", () => ({}));

type Db = typeof import("@/lib/db").db;
type QueryRecentCategoryUsage = (input: {
  householdId: string;
  memberId: string;
  now?: Date;
}) => Promise<
  {
    categoryId: string;
    count: number;
    lastOccurredAt: Date;
    type: "expense" | "income";
  }[]
>;

let db: Db;
let queryRecentCategoryUsage: QueryRecentCategoryUsage;

const createdTransactionIds: string[] = [];
const createdHouseholdIds: string[] = [];
const createdMemberIds: string[] = [];
const createdUserIds: string[] = [];

beforeAll(async () => {
  ({ db } = await import("@/lib/db"));
  ({ queryRecentCategoryUsage } = await import("@/lib/transactions/query-category-preferences"));
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
  const ownerEmail = process.env.SEED_USER_A_EMAIL ?? "user-a@example.com";
  const spouseEmail = process.env.SEED_USER_B_EMAIL ?? "user-b@example.com";

  const [ownerMember, spouseMember, diningCategory, shoppingCategory] = await Promise.all([
    db.householdMember.findFirstOrThrow({
      where: { user: { email: ownerEmail } },
    }),
    db.householdMember.findFirstOrThrow({
      where: { user: { email: spouseEmail } },
    }),
    db.category.findUniqueOrThrow({
      where: { type_name: { type: CategoryType.EXPENSE, name: "Dining" } },
    }),
    db.category.findUniqueOrThrow({
      where: { type_name: { type: CategoryType.EXPENSE, name: "Shopping" } },
    }),
  ]);

  return { ownerMember, spouseMember, diningCategory, shoppingCategory };
}

async function createOutsideMember() {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const household = await db.household.create({
    data: {
      name: `Other ${suffix}`,
      ledgers: { create: { name: "Default", isDefault: true } },
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

async function createTransaction(input: {
  householdId: string;
  actorMemberId: string;
  createdByMemberId?: string;
  categoryId: string;
  occurredAt: Date;
  deletedAt?: Date | null;
}) {
  const ledger = await db.ledger.findFirstOrThrow({ where: { householdId: input.householdId, isDefault: true } });
  const transaction = await db.transaction.create({
    data: {
      householdId: input.householdId,
      ledgerId: ledger.id,
      type: TransactionType.EXPENSE,
      actorMemberId: input.actorMemberId,
      createdByMemberId: input.createdByMemberId ?? input.actorMemberId,
      categoryId: input.categoryId,
      amountFen: 100,
      occurredAt: input.occurredAt,
      deletedAt: input.deletedAt,
    },
  });
  createdTransactionIds.push(transaction.id);

  return transaction;
}

describe("queryRecentCategoryUsage", () => {
  it("counts only active transactions for the current household and login member", async () => {
    const now = new Date("2026-05-22T15:30:00.000Z");
    const { ownerMember, spouseMember, diningCategory, shoppingCategory } = await getSeedFixture();
    const outsideMember = await createOutsideMember();

    await createTransaction({
      householdId: ownerMember.householdId,
      actorMemberId: ownerMember.id,
      categoryId: shoppingCategory.id,
      occurredAt: new Date("2026-05-20T02:00:00.000Z"),
    });
    await createTransaction({
      householdId: ownerMember.householdId,
      actorMemberId: ownerMember.id,
      categoryId: shoppingCategory.id,
      occurredAt: new Date("2026-05-21T02:00:00.000Z"),
    });
    await createTransaction({
      householdId: ownerMember.householdId,
      actorMemberId: ownerMember.id,
      categoryId: diningCategory.id,
      occurredAt: new Date("2026-04-22T16:00:00.000Z"),
    });
    await createTransaction({
      householdId: ownerMember.householdId,
      actorMemberId: ownerMember.id,
      categoryId: diningCategory.id,
      occurredAt: new Date("2026-05-21T03:00:00.000Z"),
      deletedAt: new Date("2026-05-21T04:00:00.000Z"),
    });
    await createTransaction({
      householdId: spouseMember.householdId,
      actorMemberId: spouseMember.id,
      createdByMemberId: ownerMember.id,
      categoryId: diningCategory.id,
      occurredAt: new Date("2026-05-21T05:00:00.000Z"),
    });
    await createTransaction({
      householdId: outsideMember.householdId,
      actorMemberId: outsideMember.id,
      categoryId: shoppingCategory.id,
      occurredAt: new Date("2026-05-21T06:00:00.000Z"),
    });

    await expect(
      queryRecentCategoryUsage({
        householdId: ownerMember.householdId,
        memberId: ownerMember.id,
        now,
      }),
    ).resolves.toEqual([
      {
        categoryId: shoppingCategory.id,
        count: 2,
        lastOccurredAt: new Date("2026-05-21T02:00:00.000Z"),
        type: "expense",
      },
      {
        categoryId: diningCategory.id,
        count: 1,
        lastOccurredAt: new Date("2026-04-22T16:00:00.000Z"),
        type: "expense",
      },
    ]);
  });
});
