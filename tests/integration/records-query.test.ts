import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile?.(".env");
}

if (existsSync(".env.example")) {
  process.loadEnvFile?.(".env.example");
}

import { CategoryType, HouseholdRole, TransactionType, type Prisma } from "@prisma/client";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

type SessionUser = {
  householdId: string;
  memberId: string;
};

type HouseholdFixture = {
  householdId: string;
  ledgerId: string;
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
const createdCategoryIds: string[] = [];

function softDeleteAfterTransactionPrecheck(transactionId: string) {
  const runTransaction = db.$transaction.bind(db);
  return vi.spyOn(db, "$transaction").mockImplementation(((callback: (tx: Prisma.TransactionClient) => Promise<unknown>, options?: { maxWait?: number; timeout?: number }) =>
    runTransaction(async (tx) => {
      const findFirst = tx.transaction.findFirst.bind(tx.transaction);
      tx.transaction.findFirst = (async (args) => {
          const record = await findFirst(args);
          if (record && args?.where?.id === transactionId) {
            const { physicalDb } = await import("@/lib/db");
            // Inject a separately committed storage change after the business precheck.
            await physicalDb.transaction.update({ where: { id: transactionId }, data: { deletedAt: new Date("2026-04-26T04:00:00.000Z") } });
          }
          return record;
      }) as typeof tx.transaction.findFirst;
      return callback(tx);
    }, options)) as typeof db.$transaction);
}

let uniqueCounter = 0;
const april2026RangeBounds = {
  from: new Date("2026-03-31T16:00:00.000Z"),
  to: new Date("2026-04-30T15:59:59.999Z"),
};

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
  ({ listRecords } = await import("@/lib/records/list-records"));
  ({ updateTransaction } = await import("@/lib/transactions/update-transaction"));
  ({ deleteTransaction } = await import("@/lib/transactions/delete-transaction"));
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
  if (createdCategoryIds.length > 0) {
    await db.category.deleteMany({ where: { id: { in: createdCategoryIds.splice(0) } } });
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
      ledgers: { create: { name: "Default", isDefault: true } },
    },
  });
  createdHouseholdIds.push(household.id);
  const ledger = await db.ledger.findFirstOrThrow({ where: { householdId: household.id, isDefault: true } });

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
    ledgerId: ledger.id,
    ownerMember,
    spouseMember,
  };
}

describe("records helpers", () => {
  it("filters records and both reports by original member id after same-name rejoining", async () => {
    const { expenseCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();
    const foreign = await createHouseholdFixture();
    const session = { householdId: household.householdId, memberId: household.ownerMember.id };
    const original = household.spouseMember;
    const first = await createTransaction({ type: "expense", amount: "18.60", categoryId: expenseCategory.id, actorMemberId: original.id, occurredAt: "2026-04-23T08:15" }, session);
    createdTransactionIds.push(first.id);
    const former = await db.householdMember.update({ where: { id: original.id }, data: { leftAt: new Date() } });
    const rejoined = await db.householdMember.create({ data: { householdId: household.householdId, userId: former.userId, memberName: former.memberName, role: "MEMBER" } });
    createdMemberIds.push(rejoined.id);
    const second = await createTransaction({ type: "expense", amount: "2.40", categoryId: expenseCategory.id, actorMemberId: rejoined.id, occurredAt: "2026-04-24T08:15", note: original.memberName }, session);
    createdTransactionIds.push(second.id);
    const recordInput = { householdId: household.householdId, currentMemberId: session.memberId, rangeBounds: april2026RangeBounds };
    expect((await listRecords({ ...recordInput, actorMemberId: former.id })).map(({ id }) => id)).toEqual([first.id]);
    expect((await listRecords({ ...recordInput, actorMemberId: rejoined.id })).map(({ id }) => id)).toEqual([second.id]);
    const { queryHomeReport } = await import("@/lib/reports/query-home-report");
    const { queryReportAnalytics } = await import("@/lib/reports/query-report-analytics");
    const reportInput = { householdId: household.householdId, currentMemberId: session.memberId, now: new Date("2026-04-30T04:00:00.000Z"), range: { mode: "month" as const, month: "2026-04", year: "2026" } };
    expect((await queryHomeReport({ ...reportInput, actorMemberId: former.id })).summary.expenseFen).toBe(1860);
    expect((await queryReportAnalytics({ ...reportInput, actorMemberId: rejoined.id, range: { ...reportInput.range, ...april2026RangeBounds } })).summary.expenseFen).toBe(240);
    await expect(listRecords({ ...recordInput, actorMemberId: foreign.spouseMember.id })).rejects.toThrow("Unauthorized");
    await expect(queryHomeReport({ ...reportInput, actorMemberId: foreign.spouseMember.id })).rejects.toThrow("Unauthorized");
    await expect(queryReportAnalytics({ ...reportInput, actorMemberId: foreign.spouseMember.id, range: { ...reportInput.range, ...april2026RangeBounds } })).rejects.toThrow("Unauthorized");
  });
  it.each(["missing", "malformed"])("requires a strict original ledger context before deleting a record: %s", async (kind) => {
    const { expenseCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();
    const session = { householdId: household.householdId, memberId: household.ownerMember.id };
    const context = { ...session, ledgerId: household.ledgerId };
    const transaction = await db.transaction.create({ data: { householdId: household.householdId, ledgerId: household.ledgerId,
      actorMemberId: household.ownerMember.id, createdByMemberId: household.ownerMember.id, categoryId: expenseCategory.id,
      type: "EXPENSE", amountFen: 1200, occurredAt: new Date("2026-10-21T01:00:00.000Z") } });
    createdTransactionIds.push(transaction.id);
    const remove = (await import("@/lib/transactions/delete-transaction")).deleteTransaction;
    const originalContext = kind === "missing" ? undefined : { ...context, unexpected: true };

    await expect(remove(transaction.id, session, originalContext)).rejects.toThrow(kind === "missing"
      ? "Entry context is required; refresh and select a ledger" : "Unauthorized");
    expect(await db.transaction.findUniqueOrThrow({ where: { id: transaction.id } })).toMatchObject({ deletedAt: null, ledgerId: household.ledgerId });
    expect(await db.ledgerAuditLog.count({ where: { targetId: transaction.id } })).toBe(0);
  });

  it("atomically audits shared record edits with their operator and target and skips rejected writes", async () => {
    const { expenseCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();
    const outside = await createHouseholdFixture();
    const input = { type: "expense", amount: "18.60", categoryId: expenseCategory.id, actorMemberId: household.spouseMember.id, occurredAt: "2026-04-23T08:15", note: "Private audit fixture note" };
    const saved = await createTransaction(input, { householdId: household.householdId, memberId: household.spouseMember.id });
    createdTransactionIds.push(saved.id);
    const operator = { householdId: household.householdId, memberId: household.ownerMember.id };
    await updateTransaction(saved.id, { context: await fixtureEntryContext(operator), ...input, note: "Updated private note" }, operator);
    const beforeFailure = await db.ledgerAuditLog.findMany({ where: { targetId: saved.id }, orderBy: { createdAt: "asc" } });
    expect(beforeFailure).toHaveLength(2);
    expect(beforeFailure).toEqual(expect.arrayContaining([
      expect.objectContaining({ householdId: household.householdId, memberId: household.spouseMember.id, ledgerId: household.ledgerId, action: "TRANSACTION_CREATED", targetId: saved.id }),
      expect.objectContaining({ householdId: household.householdId, memberId: household.ownerMember.id, ledgerId: household.ledgerId, action: "TRANSACTION_UPDATED", targetId: saved.id }),
    ]));
    await expect(updateTransaction(saved.id, { ...input, context: await fixtureEntryContext({ householdId: outside.householdId, memberId: outside.ownerMember.id }) }, { householdId: outside.householdId, memberId: outside.ownerMember.id })).rejects.toThrow("Transaction not found");
    expect(await db.ledgerAuditLog.findMany({ where: { targetId: saved.id }, orderBy: { createdAt: "asc" } })).toEqual(beforeFailure);
    expect(JSON.stringify(beforeFailure)).not.toContain(input.note);
    await deleteTransaction(saved.id, operator, await fixtureEntryContext(operator));
    expect(await db.ledgerAuditLog.findMany({ where: { targetId: saved.id, action: "TRANSACTION_DELETED" } })).toEqual([
      expect.objectContaining({ memberId: operator.memberId, targetId: saved.id, ledgerId: household.ledgerId }),
    ]);
  });

  it("preserves historical actors and household totals after a member leaves and rejoins", async () => {
    const { expenseCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();
    const input = { type: "expense", amount: "18.60", categoryId: expenseCategory.id, actorMemberId: household.spouseMember.id, occurredAt: "2026-04-23T08:15", note: "Historical actor" };
    const session = { householdId: household.householdId, memberId: household.ownerMember.id };
    const saved = await createTransaction(input, session);
    createdTransactionIds.push(saved.id);
    const { queryHomeReport } = await import("@/lib/reports/query-home-report");
    const { queryReportAnalytics } = await import("@/lib/reports/query-report-analytics");
    const reportInput = { householdId: household.householdId, currentMemberId: household.ownerMember.id, now: new Date("2026-04-30T04:00:00.000Z"), range: { mode: "month" as const, month: "2026-04", year: "2026" } };
    const before = await queryHomeReport(reportInput);
    const former = await db.householdMember.update({ where: { id: household.spouseMember.id }, data: { leftAt: new Date() } });
    const records = await listRecords({ householdId: household.householdId, currentMemberId: household.ownerMember.id, rangeBounds: april2026RangeBounds, search: household.spouseMember.memberName });
    expect(records).toHaveLength(1);
    expect(records[0]).toMatchObject({ id: saved.id, actorMemberId: former.id, actorMemberInactive: true });
    await updateTransaction(saved.id, { context: await fixtureEntryContext(session), ...input, note: "Keep original actor" }, session);
    expect((await db.transaction.findUniqueOrThrow({ where: { id: saved.id } })).actorMemberId).toBe(former.id);
    await expect(createTransaction(input, session)).rejects.toThrow("Actor member must belong to the current household");
    await expect(listRecords({ householdId: household.householdId, currentMemberId: former.id, rangeBounds: april2026RangeBounds })).rejects.toThrow("Unauthorized");
    const rejoined = await db.householdMember.create({ data: { householdId: household.householdId, userId: former.userId, memberName: former.memberName, role: HouseholdRole.MEMBER } });
    createdMemberIds.push(rejoined.id);
    const after = await queryHomeReport({ ...reportInput, currentMemberId: rejoined.id });
    expect(after.summary).toEqual(before.summary);
    expect(after.categories).toEqual(before.categories);
    const analysis = await queryReportAnalytics({ householdId: household.householdId, currentMemberId: rejoined.id, now: reportInput.now, range: { ...reportInput.range, ...april2026RangeBounds } });
    expect(analysis.summary).toMatchObject({ expenseFen: 1860, expenseCount: 1, transactionCount: 1 });
    expect((await listRecords({ householdId: household.householdId, currentMemberId: rejoined.id, rangeBounds: april2026RangeBounds }))[0].actorMemberId).toBe(former.id);
  });

  it("binds a manual UUID to its first ledger and rejects stale identity snapshots", async () => {
    const { expenseCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();
    const outside = await createHouseholdFixture();
    const save = (await import("@/lib/transactions/create-transaction")).createTransaction;
    const session = { householdId: household.householdId, memberId: household.ownerMember.id };
    const context = { ...session, ledgerId: household.ledgerId };
    const input = { type: "expense", amount: "18.60", categoryId: expenseCategory.id, actorMemberId: household.spouseMember.id, occurredAt: "2026-04-23T08:15", clientRequestId: randomUUID(), context };
    const first = await save(input, session);
    createdTransactionIds.push(first.id);
    expect(await db.transaction.findUniqueOrThrow({ where: { id: first.id } })).toMatchObject({ ledgerId: household.ledgerId });
    const alternate = await db.ledger.create({ data: { householdId: household.householdId, name: "Alternate fixture" } });
    expect(await save({ ...input, context: { ...context, ledgerId: alternate.id } }, session)).toMatchObject({ id: first.id, wasCreated: false });
    await expect(save({ ...input, clientRequestId: randomUUID(), context: { ...context, ledgerId: outside.ledgerId } }, session)).rejects.toThrow("Ledger is unavailable");
    await expect(save({ ...input, context: { ...context, memberId: household.spouseMember.id } }, session)).rejects.toThrow("Unauthorized");
    await db.householdMember.update({ where: { id: household.spouseMember.id }, data: { leftAt: new Date() } });
    expect(await save(input, session)).toMatchObject({ id: first.id, wasCreated: false });
    expect(await db.transaction.count({ where: { createdByMemberId: session.memberId, clientRequestId: input.clientRequestId } })).toBe(1);
  });

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
      rangeBounds: april2026RangeBounds,
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

  it.each(["me", "spouse"] as const)("ignores legacy %s perspective while applying type and category filters", async (perspective) => {
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

    const legacyInput = {
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      rangeBounds: april2026RangeBounds,
      perspective,
    };
    const expenseRecords = await listRecords({
      ...legacyInput,
      type: "expense",
      categoryId: expenseCategory.id,
    });

    expect(expenseRecords.map((record) => record.id)).toEqual([spouseExpense.id, myExpense.id]);

    const householdRecords = await listRecords(legacyInput);
    const spouseSessionRecords = await listRecords({
      ...legacyInput,
      currentMemberId: household.spouseMember.id,
    });

    expect(householdRecords.map((record) => record.id)).toEqual([
      spouseExpense.id,
      myExpense.id,
      spouseIncome.id,
    ]);
    expect(spouseSessionRecords).toEqual(householdRecords);
  });

  it("searches notes, actor members, and enabled categories without widening record scope", async () => {
    const { expenseCategory, incomeCategory } = await getSeedCategories();
    const inactiveCategory = await db.category.create({
      data: { name: `Inactive search fixture ${randomUUID()}`, type: CategoryType.EXPENSE, isActive: false, sortOrder: 999 },
      select: { id: true },
    });
    createdCategoryIds.push(inactiveCategory.id);
    const household = await createHouseholdFixture();
    const otherHousehold = await createHouseholdFixture();

    const noteMatch = await createTransaction(
      {
        type: "income",
        amount: "12.00",
        categoryId: incomeCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-25T09:00",
        note: "Dining reimbursement",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const categoryMatch = await createTransaction(
      {
        type: "expense",
        amount: "18.00",
        categoryId: expenseCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-24T09:00",
        note: "No keyword in note",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const actorMatch = await createTransaction(
      {
        type: "income",
        amount: "20.00",
        categoryId: incomeCategory.id,
        actorMemberId: household.spouseMember.id,
        occurredAt: "2026-04-23T09:00",
        note: "Actor-only record",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const outsideRange = await createTransaction(
      {
        type: "expense",
        amount: "21.00",
        categoryId: expenseCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-03-25T09:00",
        note: "Dining outside range",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const deletedRecord = await createTransaction(
      {
        type: "expense",
        amount: "22.00",
        categoryId: expenseCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-22T09:00",
        note: "Dining deleted",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const otherHouseholdRecord = await createTransaction(
      {
        type: "expense",
        amount: "23.00",
        categoryId: expenseCategory.id,
        actorMemberId: otherHousehold.ownerMember.id,
        occurredAt: "2026-04-21T09:00",
        note: "Dining other household",
      },
      {
        householdId: otherHousehold.householdId,
        memberId: otherHousehold.ownerMember.id,
      },
    );
    const inactiveRecord = await db.transaction.create({
      data: {
        ledgerId: household.ledgerId,
        amountFen: 2400,
        actorMemberId: household.ownerMember.id,
        categoryId: inactiveCategory.id,
        createdByMemberId: household.ownerMember.id,
        householdId: household.householdId,
        occurredAt: new Date("2026-04-20T01:00:00.000Z"),
        type: TransactionType.EXPENSE,
      },
      select: { id: true },
    });
    createdTransactionIds.push(
      noteMatch.id,
      categoryMatch.id,
      actorMatch.id,
      outsideRange.id,
      deletedRecord.id,
      otherHouseholdRecord.id,
      inactiveRecord.id,
    );

    await db.transaction.update({
      where: { id: deletedRecord.id },
      data: { deletedAt: new Date("2026-04-23T12:00:00.000Z") },
    });

    const noteRecords = await listRecords({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      rangeBounds: april2026RangeBounds,
      search: "  DINING  ",
    });
    const categoryRecords = await listRecords({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      rangeBounds: april2026RangeBounds,
      search: "category term",
      searchCategoryIds: [expenseCategory.id],
    });
    const unionRecords = await listRecords({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      rangeBounds: april2026RangeBounds,
      search: "Dining",
      searchCategoryIds: [expenseCategory.id],
    });
    const actorRecords = await listRecords({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      rangeBounds: april2026RangeBounds,
      search: household.spouseMember.memberName.toUpperCase(),
    });

    expect(noteRecords.map((record) => record.id)).toEqual([noteMatch.id]);
    expect(categoryRecords.map((record) => record.id)).toEqual([categoryMatch.id]);
    expect(unionRecords.map((record) => record.id)).toEqual([noteMatch.id, categoryMatch.id]);
    expect(actorRecords.map((record) => record.id)).toEqual([actorMatch.id]);
    expect(
      noteRecords.some((record) =>
        [outsideRange.id, deletedRecord.id, otherHouseholdRecord.id, inactiveRecord.id].includes(
          record.id,
        ),
      ),
    ).toBe(false);
  });

  it("rejects a current member outside the requested household", async () => {
    const household = await createHouseholdFixture();
    const otherHousehold = await createHouseholdFixture();

    await expect(
      listRecords({
        currentMemberId: otherHousehold.ownerMember.id,
        householdId: household.householdId,
        rangeBounds: april2026RangeBounds,
      }),
    ).rejects.toThrow("Unauthorized");
  });

  it("sorts filtered records by amount with newest records first for equal amounts", async () => {
    const { expenseCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();

    const smallNewest = await createTransaction(
      {
        type: "expense",
        amount: "10.00",
        categoryId: expenseCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-27T09:00",
        note: "Small newest",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const largeOldest = await createTransaction(
      {
        type: "expense",
        amount: "100.00",
        categoryId: expenseCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-21T09:00",
        note: "Large oldest",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const tieOlder = await createTransaction(
      {
        type: "expense",
        amount: "50.00",
        categoryId: expenseCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-22T09:00",
        note: "Tie older",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const tieNewer = await createTransaction(
      {
        type: "expense",
        amount: "50.00",
        categoryId: expenseCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-25T09:00",
        note: "Tie newer",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    createdTransactionIds.push(smallNewest.id, largeOldest.id, tieOlder.id, tieNewer.id);

    const amountDescRecords = await listRecords({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      rangeBounds: april2026RangeBounds,
      sort: "amount-desc",
    });
    const amountAscRecords = await listRecords({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      rangeBounds: april2026RangeBounds,
      sort: "amount-asc",
    });

    expect(amountDescRecords.map((record) => record.id)).toEqual([
      largeOldest.id,
      tieNewer.id,
      tieOlder.id,
      smallNewest.id,
    ]);
    expect(amountAscRecords.map((record) => record.id)).toEqual([
      smallNewest.id,
      tieNewer.id,
      tieOlder.id,
      largeOldest.id,
    ]);
  });

  it("supports bounded result windows for records pagination", async () => {
    const { expenseCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();
    const first = await createTransaction(
      {
        type: "expense",
        amount: "10.00",
        categoryId: expenseCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-25T09:00",
        note: "First page",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    const second = await createTransaction(
      {
        type: "expense",
        amount: "11.00",
        categoryId: expenseCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-24T09:00",
        note: "Second page",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    createdTransactionIds.push(first.id, second.id);

    const secondPageRecords = await listRecords({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      rangeBounds: april2026RangeBounds,
      limit: 1,
      offset: 1,
    } as Parameters<typeof listRecords>[0] & { limit: number; offset: number });

    expect(secondPageRecords.map((record) => record.id)).toEqual([second.id]);
  });

  it("filters exact amounts and inclusive one-sided or two-sided amount ranges", async () => {
    const { expenseCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();
    const sessionUser = {
      householdId: household.householdId,
      memberId: household.ownerMember.id,
    };
    const recordsByAmount = new Map<string, string>();

    for (const amount of ["199.99", "200.00", "300.00", "300.01"]) {
      const record = await createTransaction(
        {
          type: "expense",
          amount,
          categoryId: expenseCategory.id,
          actorMemberId: household.ownerMember.id,
          occurredAt: "2026-04-25T09:00",
          note: `Amount boundary ${amount}`,
        },
        sessionUser,
      );
      createdTransactionIds.push(record.id);
      recordsByAmount.set(amount, record.id);
    }

    const baseInput = {
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      rangeBounds: april2026RangeBounds,
      sort: "amount-asc" as const,
    };
    const exact = await listRecords({
      ...baseInput,
      amountFilter: { mode: "exact", valueFen: 20000 },
    });
    const inclusiveRange = await listRecords({
      ...baseInput,
      amountFilter: { mode: "range", minFen: 20000, maxFen: 30000 },
    });
    const lowerBoundOnly = await listRecords({
      ...baseInput,
      amountFilter: { mode: "range", minFen: 30000 },
    });
    const upperBoundOnly = await listRecords({
      ...baseInput,
      amountFilter: { mode: "range", maxFen: 20000 },
    });

    expect(exact.map((record) => record.id)).toEqual([recordsByAmount.get("200.00")]);
    expect(inclusiveRange.map((record) => record.id)).toEqual([
      recordsByAmount.get("200.00"),
      recordsByAmount.get("300.00"),
    ]);
    expect(lowerBoundOnly.map((record) => record.id)).toEqual([
      recordsByAmount.get("300.00"),
      recordsByAmount.get("300.01"),
    ]);
    expect(upperBoundOnly.map((record) => record.id)).toEqual([
      recordsByAmount.get("199.99"),
      recordsByAmount.get("200.00"),
    ]);
  });

  it("combines amount filtering with existing filters without exposing deleted or other household records", async () => {
    const { expenseCategory, incomeCategory } = await getSeedCategories();
    const transportCategory = await db.category.findUniqueOrThrow({
      where: { type_name: { type: CategoryType.EXPENSE, name: "Transport" } },
    });
    const household = await createHouseholdFixture();
    const otherHousehold = await createHouseholdFixture();
    const baseRecord = {
      ledgerId: household.ledgerId,
      amountFen: 25000,
      actorMemberId: household.ownerMember.id,
      categoryId: expenseCategory.id,
      createdByMemberId: household.ownerMember.id,
      householdId: household.householdId,
      occurredAt: new Date("2026-04-25T01:00:00.000Z"),
      type: TransactionType.EXPENSE,
      note: "Refund purchase",
    };
    const matchingId = randomUUID();
    const spouseMatchingId = randomUUID();
    const otherCategoryId = randomUUID();
    const fixtures = [
      { ...baseRecord, id: matchingId },
      { ...baseRecord, id: randomUUID(), amountFen: 30001 },
      { ...baseRecord, id: randomUUID(), occurredAt: new Date("2026-03-25T01:00:00.000Z") },
      { ...baseRecord, id: spouseMatchingId, actorMemberId: household.spouseMember.id },
      {
        ...baseRecord,
        id: randomUUID(),
        type: TransactionType.INCOME,
        categoryId: incomeCategory.id,
      },
      { ...baseRecord, id: otherCategoryId, categoryId: transportCategory.id },
      { ...baseRecord, id: randomUUID(), note: "Unrelated purchase" },
      { ...baseRecord, id: randomUUID(), deletedAt: new Date("2026-04-26T01:00:00.000Z") },
      {
        ...baseRecord,
        id: randomUUID(),
        householdId: otherHousehold.householdId,
        ledgerId: otherHousehold.ledgerId,
        actorMemberId: otherHousehold.ownerMember.id,
        createdByMemberId: otherHousehold.ownerMember.id,
      },
    ];
    await db.transaction.createMany({ data: fixtures });
    createdTransactionIds.push(...fixtures.map((record) => record.id));

    const baseInput = {
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      rangeBounds: april2026RangeBounds,
      type: "expense" as const,
      search: "  REFUND  ",
      amountFilter: { mode: "range" as const, minFen: 20000, maxFen: 30000 },
    };
    const records = await listRecords({ ...baseInput, categoryId: expenseCategory.id });
    const allExpenseCategories = await listRecords(baseInput);

    expect(records.map((record) => record.id).sort()).toEqual([matchingId, spouseMatchingId].sort());
    expect(allExpenseCategories.map((record) => record.id).sort()).toEqual(
      [matchingId, spouseMatchingId, otherCategoryId].sort(),
    );
  });

  it("applies amount filtering before pagination offset and limit", async () => {
    const { expenseCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();
    const fixtures = [
      { id: randomUUID(), amountFen: 40000, occurredAt: new Date("2026-04-28T01:00:00.000Z") },
      { id: randomUUID(), amountFen: 30000, occurredAt: new Date("2026-04-27T01:00:00.000Z") },
      { id: randomUUID(), amountFen: 10000, occurredAt: new Date("2026-04-26T01:00:00.000Z") },
      { id: randomUUID(), amountFen: 20000, occurredAt: new Date("2026-04-25T01:00:00.000Z") },
    ];
    await db.transaction.createMany({
      data: fixtures.map((record) => ({
        ...record,
        ledgerId: household.ledgerId,
        actorMemberId: household.ownerMember.id,
        categoryId: expenseCategory.id,
        createdByMemberId: household.ownerMember.id,
        householdId: household.householdId,
        type: TransactionType.EXPENSE,
      })),
    });
    createdTransactionIds.push(...fixtures.map((record) => record.id));

    const baseInput = {
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      rangeBounds: april2026RangeBounds,
      amountFilter: { mode: "range" as const, minFen: 20000, maxFen: 30000 },
    };
    const firstPage = await listRecords({ ...baseInput, limit: 2, offset: 0 });
    const secondPage = await listRecords({ ...baseInput, limit: 1, offset: 1 });

    expect(firstPage.map((record) => record.id)).toEqual([fixtures[1].id, fixtures[3].id]);
    expect(secondPage.map((record) => record.id)).toEqual([fixtures[3].id]);
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
      { context: await fixtureEntryContext({
        householdId: household.householdId,
        memberId: household.spouseMember.id,
      }),
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

  it("clears an existing note when a record update submits an empty note", async () => {
    const { expenseCategory } = await getSeedCategories();
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
      { context: await fixtureEntryContext({
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      }),
        type: "expense",
        amount: "18.60",
        categoryId: expenseCategory.id,
        actorMemberId: household.spouseMember.id,
        occurredAt: "2026-04-23T08:15",
        note: "",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );

    const updated = await db.transaction.findUniqueOrThrow({
      where: { id: original.id },
    });

    expect(updated.note).toBeNull();
  });

  it("rejects an update when the transaction is soft deleted after the precheck", async () => {
    const { expenseCategory, incomeCategory } = await getSeedCategories();
    const household = await createHouseholdFixture();
    const original = await createTransaction(
      {
        type: "expense",
        amount: "18.60",
        categoryId: expenseCategory.id,
        actorMemberId: household.ownerMember.id,
        occurredAt: "2026-04-23T08:15",
        note: "Hot pot",
      },
      {
        householdId: household.householdId,
        memberId: household.ownerMember.id,
      },
    );
    createdTransactionIds.push(original.id);

    const findFirstSpy = softDeleteAfterTransactionPrecheck(original.id);

    try {
      await expect(
        updateTransaction(
          original.id,
          { context: await fixtureEntryContext({
            householdId: household.householdId,
            memberId: household.spouseMember.id,
          }),
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
        ),
      ).rejects.toThrow("Transaction not found");
    } finally {
      findFirstSpy.mockRestore();
    }

    const unchangedDeleted = await db.transaction.findUniqueOrThrow({
      where: { id: original.id },
    });

    expect(unchangedDeleted.type).toBe(TransactionType.EXPENSE);
    expect(unchangedDeleted.amountFen).toBe(1860);
    expect(unchangedDeleted.deletedAt).toBeInstanceOf(Date);
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
    }, await fixtureEntryContext({
      householdId: household.householdId,
      memberId: household.spouseMember.id,
    }));

    const deleted = await db.transaction.findUniqueOrThrow({
      where: { id: transaction.id },
    });
    const records = await listRecords({
      householdId: household.householdId,
      currentMemberId: household.ownerMember.id,
      rangeBounds: april2026RangeBounds,
    });

    expect(deleted.deletedAt).toBeInstanceOf(Date);
    expect(records).toEqual([]);
  });

  it("rejects a delete when the transaction is soft deleted after the precheck", async () => {
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

    const findFirstSpy = softDeleteAfterTransactionPrecheck(transaction.id);

    try {
      await expect(
        deleteTransaction(transaction.id, {
          householdId: household.householdId,
          memberId: household.spouseMember.id,
        }, await fixtureEntryContext({
          householdId: household.householdId,
          memberId: household.spouseMember.id,
        })),
      ).rejects.toThrow("Transaction not found");
    } finally {
      findFirstSpy.mockRestore();
    }

    const deleted = await db.transaction.findUniqueOrThrow({
      where: { id: transaction.id },
    });

    expect(deleted.deletedAt).toBeInstanceOf(Date);
  });
});
