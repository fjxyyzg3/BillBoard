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
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { CategoryPicker } from "@/components/category-picker";
import { TransactionForm } from "@/components/transaction-form";
import { getMessages } from "@/lib/i18n";

vi.mock("@/app/(app)/add/actions", () => ({
  submitTransaction: vi.fn(),
}));

type SessionUser = {
  householdId: string;
  memberId: string;
};

let db: typeof import("@/lib/db").db;
let createTransaction: (input: {
  context?: { householdId: string; memberId: string; ledgerId: string };
  type: string;
  amount: string;
  categoryId: string;
  actorMemberId: string;
  occurredAt: string;
  note?: string;
  clientRequestId?: string;
}, sessionUser: SessionUser) => Promise<{
  clientRequestId: string;
  id: string;
  wasCreated: boolean;
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
  await db.ledgerAuditLog.deleteMany({ where: { OR: [{ householdId: { in: createdHouseholdIds } }, { targetId: { in: createdTransactionIds } }] } });
  await db.transaction.deleteMany({ where: { householdId: { in: createdHouseholdIds } } });
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

async function createTransactionWithContext(input: Parameters<typeof createTransaction>[0], session: SessionUser) {
  const ledger = await db.ledger.findFirstOrThrow({ where: { householdId: session.householdId, isDefault: true } });
  return createTransaction({ ...input, context: { ...session, ledgerId: ledger.id } }, session);
}

describe("createTransaction", () => {
  it("requires explicit context for a new UUID but confirms it after moving and archiving", async () => {
    const member = await createOutsideMember();
    const { expenseCategory } = await getSeedFixture();
    const ledger = await db.ledger.findFirstOrThrow({ where: { householdId: member.householdId, isDefault: true } });
    const sessionUser = { householdId: member.householdId, memberId: member.id };
    const input = { type: "expense", amount: "12.00", categoryId: expenseCategory.id, actorMemberId: member.id,
      occurredAt: "2026-10-21T09:00", clientRequestId: crypto.randomUUID() };
    await expect(createTransaction(input, sessionUser)).rejects.toThrow("Entry context is required; refresh and select a ledger");
    expect(await db.transaction.count({ where: { householdId: member.householdId } })).toBe(0);

    const context = { ...sessionUser, ledgerId: ledger.id };
    const created = await createTransaction({ ...input, context }, sessionUser);
    createdTransactionIds.push(created.id);
    const alternate = await db.ledger.create({ data: { householdId: member.householdId, name: "Destination" } });
    await db.transaction.update({ where: { id: created.id }, data: { ledgerId: alternate.id } });
    await db.ledger.update({ where: { id: ledger.id }, data: { isDefault: false } });
    await db.ledger.update({ where: { id: alternate.id }, data: { isDefault: true } });
    await db.ledger.update({ where: { id: ledger.id }, data: { archivedAt: new Date() } });

    expect(await createTransaction(input, sessionUser)).toMatchObject({ id: created.id, wasCreated: false });
    expect(await createTransaction({ ...input, context }, sessionUser)).toMatchObject({ id: created.id, wasCreated: false });
    expect(await db.transaction.count({ where: { householdId: member.householdId } })).toBe(1);
    await expect(createTransaction({ ...input, context, amount: "13.00" }, sessionUser)).rejects.toThrow("conflicts");
  });

  it("returns the existing transaction when the same request is retried", async () => {
    const { ownerMember, actorMember, expenseCategory } = await getSeedFixture();
    const clientRequestId = crypto.randomUUID();
    const input = {
      type: "expense",
      amount: "18.60",
      categoryId: expenseCategory.id,
      actorMemberId: actorMember.id,
      occurredAt: "2026-04-26T08:30",
      note: "Hot pot",
      clientRequestId,
    };
    const sessionUser = {
      householdId: ownerMember.householdId,
      memberId: ownerMember.id,
    };

    const first = await createTransactionWithContext(input, sessionUser);
    const retried = await createTransactionWithContext(input, sessionUser);
    createdTransactionIds.push(first.id);

    expect(first.wasCreated).toBe(true);
    expect(retried).toMatchObject({ id: first.id, wasCreated: false });
    await expect(
      db.transaction.count({
        where: { createdByMemberId: ownerMember.id, clientRequestId },
      }),
    ).resolves.toBe(1);
  });

  it("deduplicates concurrent retries of the same request", async () => {
    const { ownerMember, actorMember, expenseCategory } = await getSeedFixture();
    const clientRequestId = crypto.randomUUID();
    const input = {
      type: "expense",
      amount: "26.80",
      categoryId: expenseCategory.id,
      actorMemberId: actorMember.id,
      occurredAt: "2026-04-26T08:45",
      clientRequestId,
    };
    const sessionUser = {
      householdId: ownerMember.householdId,
      memberId: ownerMember.id,
    };

    const results = await Promise.all([
      createTransactionWithContext(input, sessionUser),
      createTransactionWithContext(input, sessionUser),
    ]);
    createdTransactionIds.push(results[0].id);

    expect(new Set(results.map((result) => result.id))).toHaveLength(1);
    expect(results.filter((result) => result.wasCreated)).toHaveLength(1);
    await expect(
      db.transaction.count({
        where: { createdByMemberId: ownerMember.id, clientRequestId },
      }),
    ).resolves.toBe(1);
  });

  it("rejects a reused request ID when the normalized payload differs", async () => {
    const { ownerMember, actorMember, expenseCategory } = await getSeedFixture();
    const input = {
      type: "expense",
      amount: "18.60",
      categoryId: expenseCategory.id,
      actorMemberId: actorMember.id,
      occurredAt: "2026-04-26T08:30",
      clientRequestId: crypto.randomUUID(),
    };
    const sessionUser = {
      householdId: ownerMember.householdId,
      memberId: ownerMember.id,
    };
    const created = await createTransactionWithContext(input, sessionUser);
    createdTransactionIds.push(created.id);

    await expect(
      createTransactionWithContext({ ...input, amount: "19.60" }, sessionUser),
    ).rejects.toThrow("Transaction request conflicts with an existing transaction");
  });

  it("isolates the same request ID between different creators", async () => {
    const { ownerMember, actorMember, expenseCategory } = await getSeedFixture();
    const clientRequestId = crypto.randomUUID();
    const input = {
      type: "expense",
      amount: "38.00",
      categoryId: expenseCategory.id,
      actorMemberId: actorMember.id,
      occurredAt: "2026-04-26T09:10",
      clientRequestId,
    };

    const [ownerResult, actorResult] = await Promise.all([
      createTransactionWithContext(input, {
        householdId: ownerMember.householdId,
        memberId: ownerMember.id,
      }),
      createTransactionWithContext(input, {
        householdId: actorMember.householdId,
        memberId: actorMember.id,
      }),
    ]);
    createdTransactionIds.push(ownerResult.id, actorResult.id);

    expect(ownerResult.id).not.toBe(actorResult.id);
    expect(ownerResult.wasCreated).toBe(true);
    expect(actorResult.wasCreated).toBe(true);
  });

  it("rejects an invalid client request ID", async () => {
    const { ownerMember, actorMember, expenseCategory } = await getSeedFixture();

    await expect(
      createTransactionWithContext(
        {
          type: "expense",
          amount: "18.60",
          categoryId: expenseCategory.id,
          actorMemberId: actorMember.id,
          occurredAt: "2026-04-26T08:30",
          clientRequestId: "not-a-uuid",
        },
        {
          householdId: ownerMember.householdId,
          memberId: ownerMember.id,
        },
      ),
    ).rejects.toThrow("Invalid transaction request ID");
  });

  it("creates an expense transaction for the current household", async () => {
    const { ownerMember, actorMember, expenseCategory } = await getSeedFixture();

    const result = await createTransactionWithContext(
      {
        type: "expense",
        amount: "18.60",
        categoryId: expenseCategory.id,
        actorMemberId: actorMember.id,
        clientRequestId: crypto.randomUUID(),
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
    expect(created.clientRequestId).toBe(result.clientRequestId);
    expect(created.source).toBeNull();
    expect(created.sourceFingerprint).toBeNull();
    expect(created.sourceImportedAt).toBeNull();
    expect(result.wasCreated).toBe(true);
  });

  it("rejects a category whose type does not match the selected transaction type", async () => {
    const { ownerMember, actorMember, incomeCategory } = await getSeedFixture();

    await expect(
      createTransactionWithContext(
        {
          type: "expense",
          amount: "88.00",
          categoryId: incomeCategory.id,
          actorMemberId: actorMember.id,
          clientRequestId: crypto.randomUUID(),
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
      createTransactionWithContext(
        {
          type: "expense",
          amount: "45.00",
          categoryId: expenseCategory.id,
          actorMemberId: outsideMember.id,
          clientRequestId: crypto.randomUUID(),
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
  it("uses the preferred default category for the initial transaction type", () => {
    const markup = renderToStaticMarkup(
      createElement(TransactionForm, {
        categories: [
          { id: "expense-1", name: "Dining", type: "expense" },
          { id: "expense-2", name: "Shopping", type: "expense" },
          { id: "income-1", name: "Salary", type: "income" },
        ],
        currentMemberId: "member-1",
        defaultCategoryIds: {
          expense: "expense-2",
          income: "income-1",
        },
        householdMembers: [{ id: "member-1", memberName: "Me" }],
        labels: {
          add: getMessages("en-US").add,
          common: getMessages("en-US").common,
        },
        locale: "en-US",
      }),
    );

    expect(markup).toMatch(/<input[^>]*name="categoryId"[^>]*checked=""[^>]*value="expense-2"/);
  });

  it("renders categories as quick-tap icon radios instead of a select", () => {
    const markup = renderToStaticMarkup(
      createElement(CategoryPicker, {
        categories: [
          { id: "expense-1", name: "Dining", type: "expense" },
          { id: "expense-2", name: "Shopping", type: "expense" },
          { id: "expense-3", name: "Transport", type: "expense" },
          { id: "expense-4", name: "Groceries", type: "expense" },
          { id: "expense-5", name: "Utilities", type: "expense" },
          { id: "expense-6", name: "Healthcare", type: "expense" },
          { id: "expense-7", name: "Entertainment", type: "expense" },
          { id: "expense-8", name: "Travel", type: "expense" },
          { id: "income-1", name: "Salary", type: "income" },
        ],
        label: "Category",
        labels: {
          collapse: "Collapse",
          more: "More",
        },
        locale: "en-US",
        onSelect: () => {},
        selectedCategoryId: "expense-1",
        selectedType: "expense",
      }),
    );

    expect(markup).not.toContain("<select");
    expect(markup.match(/type="radio"/g)).toHaveLength(7);
    expect(markup).toContain('type="button"');
    expect(markup).toContain(">More</span>");
    expect(markup).toContain(">Entertainment</span>");
    expect(markup).not.toContain(">Travel</span>");
    expect(markup).toContain("lucide-utensils");
    expect(markup).toContain("category-picker__chip");
    expect(markup).not.toContain("min-h-12");
  });

  it("does not autofocus the amount field on mobile-first entry", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/components/transaction-form.tsx"),
      "utf8",
    );

    expect(source).not.toContain("autoFocus");
  });

  it("uses a lightweight toast without follow-up action links after a successful save", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/components/transaction-form.tsx"),
      "utf8",
    );

    expect(source).toContain("function SuccessToast");
    expect(source).toContain("window.setTimeout");
    expect(source).toContain("2500");
    expect(source).not.toContain("labels.common.addAnother");
    expect(source).not.toContain("href={nextAddHref}");
    expect(source).not.toContain("labels.common.returnHome");
    expect(source).not.toContain("href={homeHref}");
  });

  it("uses the shared datetime control and compact note field", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/components/transaction-form.tsx"),
      "utf8",
    );

    expect(source).toContain("IosDateTimeInput");
    expect(source).toContain('type="text"');
    expect(source).not.toContain("min-h-24");
    expect(source).not.toContain("<textarea");
  });
});
