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
let listRecords: typeof import("@/lib/records/list-records").listRecords;

const createdHouseholdIds: string[] = [];
const createdMemberIds: string[] = [];
const createdTransactionIds: string[] = [];
const createdUserIds: string[] = [];

let uniqueCounter = 0;

beforeAll(async () => {
  ({ db } = await import("@/lib/db"));
  ({ createTransaction } = await import("@/lib/transactions/create-transaction"));
  ({ listRecords } = await import("@/lib/records/list-records"));
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
  return db.category.findUniqueOrThrow({
    where: { type_name: { type: CategoryType.EXPENSE, name: "Dining" } },
  });
}

async function createHouseholdFixture(): Promise<HouseholdFixture> {
  const suffix = nextSuffix();
  const household = await db.household.create({
    data: {
      name: `Records Drilldown Household ${suffix}`,
    },
  });
  createdHouseholdIds.push(household.id);

  const ownerUser = await db.user.create({
    data: {
      email: `records-window-owner-${suffix}@example.com`,
      displayName: `Owner ${suffix}`,
      passwordHash: "not-used",
    },
  });
  const spouseUser = await db.user.create({
    data: {
      email: `records-window-spouse-${suffix}@example.com`,
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

describe("listRecords drill-down window", () => {
  it("prefers an explicit bucket window over the broader preset range", async () => {
    const diningCategory = await getSeedCategories();
    const household = await createHouseholdFixture();

    const outsideBucket = await createTransaction(
      {
        type: "expense",
        amount: "12.00",
        categoryId: diningCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-24T08:00",
        note: "Outside bucket",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const insideBucket = await createTransaction(
      {
        type: "expense",
        amount: "25.00",
        categoryId: diningCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-25T08:00",
        note: "Inside bucket",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    createdTransactionIds.push(outsideBucket.id, insideBucket.id);

    const records = await listRecords({
      currentMemberId: household.ownerMember.id,
      from: new Date("2026-04-24T16:00:00.000Z"),
      householdId: household.householdId,
      perspective: "household",
      rangePreset: "last-7-days",
      to: new Date("2026-04-25T15:59:59.999Z"),
      timezone: "Asia/Shanghai",
    });

    expect(records.map((record) => record.id)).toEqual([insideBucket.id]);
  });
});
