import { existsSync } from "node:fs";

if (existsSync(".env")) {
  process.loadEnvFile?.(".env");
}

if (existsSync(".env.example")) {
  process.loadEnvFile?.(".env.example");
}

import {
  CategoryType,
  HouseholdRole,
  ImportDraftRowStatus,
  ImportDraftStatus,
  ImportRowDecision,
  TransactionType,
} from "@prisma/client";
import ExcelJS from "exceljs";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";

type SessionUser = {
  householdId: string;
  memberId: string;
};

type DraftServices = typeof import("@/lib/imports/drafts");

let db: typeof import("@/lib/db").db;
let services: DraftServices;

const createdHouseholdIds: string[] = [];
const createdCategoryIds: string[] = [];
const createdUserIds: string[] = [];

const headers = [
  "交易类型",
  "日期",
  "一级分类",
  "二级分类",
  "账户1",
  "账户币种",
  "金额",
  "成员",
  "商家",
  "记账人",
  "备注",
];

beforeAll(async () => {
  assertSafeTestDatabase();
  ({ db } = await import("@/lib/db"));
  services = await import("@/lib/imports/drafts");
});

afterEach(async () => {
  await uninstallImportDraftTestTrigger();

  for (const householdId of createdHouseholdIds.splice(0, createdHouseholdIds.length)) {
    await db.importCategoryMapping.deleteMany({ where: { householdId } });
    await db.household.deleteMany({ where: { id: householdId } });
  }

  if (createdCategoryIds.length > 0) {
    await db.category.deleteMany({
      where: { id: { in: createdCategoryIds.splice(0, createdCategoryIds.length) } },
    });
  }

  if (createdUserIds.length > 0) {
    await db.user.deleteMany({
      where: { id: { in: createdUserIds.splice(0, createdUserIds.length) } },
    });
  }
});

afterAll(async () => {
  await db.$disconnect();
});

function assertSafeTestDatabase() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Import draft integration tests must not run with NODE_ENV=production");
  }

  const databaseUrl = process.env.DATABASE_URL;

  if (!databaseUrl) {
    throw new Error("DATABASE_URL is required for import draft integration tests");
  }

  const parsedUrl = new URL(databaseUrl);
  const databaseName = parsedUrl.pathname.replace(/^\//, "");
  const hostIsLocal = parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost";
  const databaseIsDevOrTest = /(?:dev|test)/i.test(databaseName);

  if (!hostIsLocal || !databaseIsDevOrTest) {
    throw new Error("Refusing to run import draft integration tests against a non-dev/test database");
  }
}

async function buildWorkbookBuffer(sheets: Record<string, unknown[][]>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  for (const [sheetName, rows] of Object.entries(sheets)) {
    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRows(rows);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

function expenseRow(overrides: Partial<Record<string, string>> = {}) {
  return [
    overrides.rawTransactionType ?? "支出",
    overrides.rawDate ?? "2026-05-06 13:23:02",
    overrides.rawPrimaryCategory ?? "餐饮",
    overrides.rawSecondaryCategory ?? "三餐",
    overrides.rawAccount ?? "现金",
    overrides.rawCurrency ?? "CNY",
    overrides.rawAmount ?? "176",
    overrides.rawMember ?? "晶晶",
    overrides.rawMerchant ?? "小店",
    overrides.rawCreatedBy ?? "晶晶",
    overrides.rawNote ?? "午饭",
  ];
}

function incomeRow(overrides: Partial<Record<string, string>> = {}) {
  return [
    overrides.rawTransactionType ?? "收入",
    overrides.rawDate ?? "2026-04-30 12:30:49",
    overrides.rawPrimaryCategory ?? "职业收入",
    overrides.rawSecondaryCategory ?? "工资",
    overrides.rawAccount ?? "银行卡",
    overrides.rawCurrency ?? "CNY",
    overrides.rawAmount ?? "56276.72",
    overrides.rawMember ?? "",
    overrides.rawMerchant ?? "",
    overrides.rawCreatedBy ?? "李环宇",
    overrides.rawNote ?? "",
  ];
}

function buildExpenseIncomeWorkbook() {
  return buildWorkbookBuffer({
    支出: [headers, expenseRow()],
    收入: [headers, incomeRow()],
  });
}

function buildExpenseWorkbook(overrides: Partial<Record<string, string>> = {}) {
  return buildWorkbookBuffer({
    支出: [headers, expenseRow(overrides)],
  });
}

async function getSeededCategories() {
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

async function createHouseholdFixture() {
  const suffix = `${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;
  const household = await db.household.create({
    data: {
      name: `Import Draft ${suffix}`,
    },
  });
  createdHouseholdIds.push(household.id);

  const [husbandUser, wifeUser] = await Promise.all([
    db.user.create({
      data: {
        email: `import-husband-${suffix}@example.com`,
        displayName: "老公",
        passwordHash: "not-used",
      },
    }),
    db.user.create({
      data: {
        email: `import-wife-${suffix}@example.com`,
        displayName: "老婆",
        passwordHash: "not-used",
      },
    }),
  ]);
  createdUserIds.push(husbandUser.id, wifeUser.id);

  const [husbandMember, wifeMember] = await Promise.all([
    db.householdMember.create({
      data: {
        householdId: household.id,
        userId: husbandUser.id,
        memberName: "老公",
        role: HouseholdRole.OWNER,
      },
    }),
    db.householdMember.create({
      data: {
        householdId: household.id,
        userId: wifeUser.id,
        memberName: "老婆",
        role: HouseholdRole.MEMBER,
      },
    }),
  ]);

  return {
    household,
    husbandMember,
    wifeMember,
    sessionUser: {
      householdId: household.id,
      memberId: husbandMember.id,
    } satisfies SessionUser,
  };
}

async function createOutsideSessionUser() {
  const fixture = await createHouseholdFixture();

  return {
    householdId: fixture.household.id,
    memberId: fixture.husbandMember.id,
  } satisfies SessionUser;
}

async function saveDefaultMappings(draftId: string, sessionUser: SessionUser) {
  const { expenseCategory, incomeCategory } = await getSeededCategories();

  await services.saveImportDraftMappings(
    draftId,
    [
      {
        categoryId: expenseCategory.id,
        mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐",
      },
      {
        categoryId: incomeCategory.id,
        mappingKey: "sui_shou_ji|INCOME|职业收入|工资",
      },
    ],
    sessionUser,
  );

  return { expenseCategory, incomeCategory };
}

async function installImportDraftTestTrigger() {
  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION import_draft_test_before_insert()
    RETURNS trigger AS $$
    BEGIN
      IF NEW.source = 'sui_shou_ji'
        AND NEW.note LIKE '%concurrent-confirm-marker%'
      THEN
        PERFORM pg_sleep(0.5);
      END IF;

      IF pg_trigger_depth() = 1
        AND NEW.source = 'sui_shou_ji'
        AND NEW.note LIKE '%unique-conflict-marker%'
      THEN
        INSERT INTO "Transaction" (
          "id",
          "household_id",
          "type",
          "actor_member_id",
          "created_by_member_id",
          "category_id",
          "amount_fen",
          "occurred_at",
          "note",
          "source",
          "source_fingerprint",
          "source_imported_at",
          "created_at",
          "updated_at"
        )
        VALUES (
          'conflict_' || replace(substr(md5(random()::text), 1, 20), '-', '_'),
          NEW."household_id",
          NEW."type",
          NEW."actor_member_id",
          NEW."created_by_member_id",
          NEW."category_id",
          NEW."amount_fen",
          NEW."occurred_at",
          'inserted by conflict trigger',
          NEW."source",
          NEW."source_fingerprint",
          NEW."source_imported_at",
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        );
      END IF;

      RETURN NEW;
    END;
    $$ LANGUAGE plpgsql;
  `);
  await db.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS import_draft_test_before_insert_trigger ON "Transaction";
  `);
  await db.$executeRawUnsafe(`
    CREATE TRIGGER import_draft_test_before_insert_trigger
    BEFORE INSERT ON "Transaction"
    FOR EACH ROW
    EXECUTE FUNCTION import_draft_test_before_insert();
  `);
}

async function uninstallImportDraftTestTrigger() {
  await db.$executeRawUnsafe(`
    DROP TRIGGER IF EXISTS import_draft_test_before_insert_trigger ON "Transaction";
  `);
  await db.$executeRawUnsafe(`
    DROP FUNCTION IF EXISTS import_draft_test_before_insert();
  `);
}

describe("Sui Shou Ji import draft services", () => {
  it("creates a draft, saves missing mappings, and confirms mapped transactions", async () => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const buffer = await buildExpenseIncomeWorkbook();

    const draft = await services.createSuiShouJiImportDraft({
      buffer,
      fileName: "sui-shou-ji.xlsx",
      sessionUser,
    });

    const initialSummary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(initialSummary.status).toBe(ImportDraftStatus.PENDING);
    expect(initialSummary.counts.needsMapping).toBe(2);
    expect(initialSummary.missingMappings.map((mapping) => mapping.mappingKey).sort()).toEqual([
      "sui_shou_ji|EXPENSE|餐饮|三餐",
      "sui_shou_ji|INCOME|职业收入|工资",
    ]);

    const { expenseCategory, incomeCategory } = await saveDefaultMappings(draft.id, sessionUser);
    const mappedSummary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(mappedSummary.counts.importable).toBe(2);
    expect(mappedSummary.counts.needsMapping).toBe(0);

    const expenseDraftRow = mappedSummary.rows.find(
      (row) => row.mappingKey === "sui_shou_ji|EXPENSE|餐饮|三餐",
    );
    expect(expenseDraftRow).toMatchObject({
      actorMemberId: wifeMember.id,
      createdByMemberId: wifeMember.id,
      status: ImportDraftRowStatus.READY,
    });

    const result = await services.confirmImportDraft(draft.id, sessionUser);

    expect(result).toMatchObject({
      createdCount: 2,
      sourceDuplicateCount: 0,
      userSkippedCount: 0,
    });

    const transactions = await db.transaction.findMany({
      where: {
        householdId: sessionUser.householdId,
        source: "sui_shou_ji",
      },
      orderBy: { amountFen: "asc" },
    });

    expect(transactions).toHaveLength(2);
    expect(transactions[0]).toMatchObject({
      householdId: sessionUser.householdId,
      actorMemberId: wifeMember.id,
      createdByMemberId: wifeMember.id,
      categoryId: expenseCategory.id,
      amountFen: 17600,
      source: "sui_shou_ji",
    });
    expect(transactions[0]?.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(transactions[0]?.sourceImportedAt).toBeInstanceOf(Date);
    expect(transactions[0]?.note).toBe(
      "午饭\n随手记：餐饮 / 三餐；成员：晶晶；记账人：晶晶；账户：现金；商家：小店",
    );
    expect(transactions[1]).toMatchObject({
      householdId: sessionUser.householdId,
      actorMemberId: sessionUser.memberId,
      createdByMemberId: sessionUser.memberId,
      categoryId: incomeCategory.id,
      amountFen: 5627672,
      source: "sui_shou_ji",
    });

    const secondResult = await services.confirmImportDraft(draft.id, sessionUser);
    const transactionCount = await db.transaction.count({
      where: {
        householdId: sessionUser.householdId,
        source: "sui_shou_ji",
      },
    });

    expect(secondResult.createdCount).toBe(2);
    expect(transactionCount).toBe(2);
  });

  it("marks same-source duplicate rows even when the existing transaction is soft deleted", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const buffer = await buildExpenseWorkbook();
    const firstDraft = await services.createSuiShouJiImportDraft({
      buffer,
      fileName: "first.xlsx",
      sessionUser,
    });
    await saveDefaultMappings(firstDraft.id, sessionUser);
    await services.confirmImportDraft(firstDraft.id, sessionUser);

    await db.transaction.updateMany({
      where: {
        householdId: sessionUser.householdId,
        source: "sui_shou_ji",
      },
      data: { deletedAt: new Date() },
    });

    const secondDraft = await services.createSuiShouJiImportDraft({
      buffer,
      fileName: "second.xlsx",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(secondDraft.id, sessionUser);

    expect(summary.counts.sourceDuplicate).toBe(1);
    expect(summary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
      userDecision: ImportRowDecision.SKIP,
    });
  });

  it("does not mark same-date same-amount imports as source duplicates when account or merchant differs", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const firstDraft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook({ rawAccount: "现金", rawMerchant: "小店" }),
      fileName: "cash.xlsx",
      sessionUser,
    });
    await saveDefaultMappings(firstDraft.id, sessionUser);
    await services.confirmImportDraft(firstDraft.id, sessionUser);

    const secondDraft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook({ rawAccount: "银行卡", rawMerchant: "小店" }),
      fileName: "card.xlsx",
      sessionUser,
    });
    const thirdDraft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook({ rawAccount: "现金", rawMerchant: "另一家店" }),
      fileName: "merchant.xlsx",
      sessionUser,
    });

    const [secondSummary, thirdSummary] = await Promise.all([
      services.getImportDraftSummary(secondDraft.id, sessionUser),
      services.getImportDraftSummary(thirdDraft.id, sessionUser),
    ]);

    expect(secondSummary.counts.sourceDuplicate).toBe(0);
    expect(thirdSummary.counts.sourceDuplicate).toBe(0);
    expect(secondSummary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.READY,
      userDecision: ImportRowDecision.KEEP,
    });
    expect(thirdSummary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.READY,
      userDecision: ImportRowDecision.KEEP,
    });

    const secondResult = await services.confirmImportDraft(secondDraft.id, sessionUser);
    const importedCount = await db.transaction.count({
      where: {
        householdId: sessionUser.householdId,
        source: "sui_shou_ji",
      },
    });

    expect(secondResult).toMatchObject({
      createdCount: 1,
      sourceDuplicateCount: 0,
    });
    expect(importedCount).toBe(2);
  });

  it("defaults manual same-day same-amount possible duplicates to keep and honors skip on confirm", async () => {
    const { sessionUser, husbandMember } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    await db.transaction.create({
      data: {
        householdId: sessionUser.householdId,
        type: TransactionType.EXPENSE,
        actorMemberId: husbandMember.id,
        createdByMemberId: husbandMember.id,
        categoryId: expenseCategory.id,
        amountFen: 17600,
        occurredAt: new Date("2026-05-06T15:30:00.000Z"),
        note: "Manual dinner",
      },
    });

    const draft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook(),
      fileName: "possible.xlsx",
      sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
      userDecision: ImportRowDecision.KEEP,
    });
    expect(summary.rows[0]?.duplicateCandidates).toHaveLength(1);

    await services.setImportDraftRowDecision(
      draft.id,
      summary.rows[0]!.id,
      ImportRowDecision.SKIP,
      sessionUser,
    );
    const result = await services.confirmImportDraft(draft.id, sessionUser);

    expect(result).toMatchObject({
      createdCount: 0,
      userSkippedCount: 1,
    });

    const importedCount = await db.transaction.count({
      where: {
        householdId: sessionUser.householdId,
        source: "sui_shou_ji",
      },
    });

    expect(importedCount).toBe(0);
  });

  it("treats non-empty cross-source same-day same-amount transactions as possible duplicates", async () => {
    const { sessionUser, husbandMember } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    await db.transaction.create({
      data: {
        householdId: sessionUser.householdId,
        type: TransactionType.EXPENSE,
        actorMemberId: husbandMember.id,
        createdByMemberId: husbandMember.id,
        categoryId: expenseCategory.id,
        amountFen: 17600,
        occurredAt: new Date("2026-05-06T02:30:00.000Z"),
        note: "Other import lunch",
        source: "other_source",
        sourceFingerprint: "other-source-fingerprint",
        sourceImportedAt: new Date(),
      },
    });

    const draft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook(),
      fileName: "cross-source-possible.xlsx",
      sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
      userDecision: ImportRowDecision.KEEP,
    });
    expect(summary.rows[0]?.duplicateCandidates).toHaveLength(1);
    expect(summary.rows[0]?.duplicateCandidates[0]).toMatchObject({
      source: "other_source",
    });

    await services.setImportDraftRowDecision(
      draft.id,
      summary.rows[0]!.id,
      ImportRowDecision.SKIP,
      sessionUser,
    );
    const result = await services.confirmImportDraft(draft.id, sessionUser);

    expect(result).toMatchObject({
      createdCount: 0,
      userSkippedCount: 1,
    });

    const importedCount = await db.transaction.count({
      where: {
        householdId: sessionUser.householdId,
        source: "sui_shou_ji",
      },
    });

    expect(importedCount).toBe(0);
  });

  it("safely skips a source fingerprint unique conflict during confirmation", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook({ rawNote: "unique-conflict-marker" }),
      fileName: "unique-conflict.xlsx",
      sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);
    await installImportDraftTestTrigger();

    const result = await services.confirmImportDraft(draft.id, sessionUser);

    expect(result).toMatchObject({
      createdCount: 0,
      sourceDuplicateCount: 1,
    });

    const transactions = await db.transaction.findMany({
      where: {
        householdId: sessionUser.householdId,
        source: "sui_shou_ji",
      },
    });
    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(transactions).toHaveLength(1);
    expect(transactions[0]?.note).toBe("inserted by conflict trigger");
    expect(summary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
      userDecision: ImportRowDecision.SKIP,
    });
  });

  it("does not allow row decisions after a draft is completed", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook(),
      fileName: "completed-decision.xlsx",
      sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);
    const beforeConfirm = await services.getImportDraftSummary(draft.id, sessionUser);

    await services.confirmImportDraft(draft.id, sessionUser);

    await expect(
      services.setImportDraftRowDecision(
        draft.id,
        beforeConfirm.rows[0]!.id,
        ImportRowDecision.SKIP,
        sessionUser,
      ),
    ).rejects.toThrow("Import draft is already completed");

    const afterDecisionAttempt = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(afterDecisionAttempt.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.READY,
      userDecision: ImportRowDecision.KEEP,
    });
  });

  it("keeps imported rows ready after concurrent confirmations of the same draft", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook({ rawNote: "concurrent-confirm-marker" }),
      fileName: "concurrent-confirm.xlsx",
      sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);
    await installImportDraftTestTrigger();

    const [firstResult, secondResult] = await Promise.all([
      services.confirmImportDraft(draft.id, sessionUser),
      services.confirmImportDraft(draft.id, sessionUser),
    ]);
    const summary = await services.getImportDraftSummary(draft.id, sessionUser);
    const importedCount = await db.transaction.count({
      where: {
        householdId: sessionUser.householdId,
        source: "sui_shou_ji",
      },
    });

    expect([firstResult.createdCount, secondResult.createdCount].sort()).toEqual([1, 1]);
    expect(firstResult.sourceDuplicateCount + secondResult.sourceDuplicateCount).toBe(0);
    expect(importedCount).toBe(1);
    expect(summary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.READY,
      userDecision: ImportRowDecision.KEEP,
    });
  });

  it("restores keep after skip and imports the possible duplicate row", async () => {
    const { sessionUser, husbandMember } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    await db.transaction.create({
      data: {
        householdId: sessionUser.householdId,
        type: TransactionType.EXPENSE,
        actorMemberId: husbandMember.id,
        createdByMemberId: husbandMember.id,
        categoryId: expenseCategory.id,
        amountFen: 17600,
        occurredAt: new Date("2026-05-06T01:30:00.000Z"),
        note: "Manual lunch",
      },
    });

    const draft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook(),
      fileName: "restore-keep.xlsx",
      sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);
    const skippedSummary = await services.getImportDraftSummary(draft.id, sessionUser);

    await services.setImportDraftRowDecision(
      draft.id,
      skippedSummary.rows[0]!.id,
      ImportRowDecision.SKIP,
      sessionUser,
    );
    await services.setImportDraftRowDecision(
      draft.id,
      skippedSummary.rows[0]!.id,
      ImportRowDecision.KEEP,
      sessionUser,
    );

    const restoredSummary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(restoredSummary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
      userDecision: ImportRowDecision.KEEP,
    });

    const result = await services.confirmImportDraft(draft.id, sessionUser);

    expect(result.createdCount).toBe(1);
    await expect(
      db.transaction.findFirstOrThrow({
        where: {
          householdId: sessionUser.householdId,
          source: "sui_shou_ji",
        },
      }),
    ).resolves.toMatchObject({
      amountFen: 17600,
      source: "sui_shou_ji",
    });
  });

  it("rejects mappings whose category type does not match the imported transaction type", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { incomeCategory } = await getSeededCategories();
    const draft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook(),
      fileName: "bad-mapping.xlsx",
      sessionUser,
    });

    await expect(
      services.saveImportDraftMappings(
        draft.id,
        [
          {
            categoryId: incomeCategory.id,
            mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐",
          },
        ],
        sessionUser,
      ),
    ).rejects.toThrow("Category does not match transaction type");
  });

  it("rejects mappings to inactive categories", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const inactiveCategory = await db.category.create({
      data: {
        isActive: false,
        name: `Inactive Import Dining ${Date.now()}`,
        sortOrder: 999,
        type: CategoryType.EXPENSE,
      },
    });
    createdCategoryIds.push(inactiveCategory.id);
    const draft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook(),
      fileName: "inactive-mapping.xlsx",
      sessionUser,
    });

    await expect(
      services.saveImportDraftMappings(
        draft.id,
        [
          {
            categoryId: inactiveCategory.id,
            mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐",
          },
        ],
        sessionUser,
      ),
    ).rejects.toThrow("Category not found");
  });

  it("does not allow a row decision through a different draft id in the same household", async () => {
    const { sessionUser, husbandMember } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    await db.transaction.create({
      data: {
        householdId: sessionUser.householdId,
        type: TransactionType.EXPENSE,
        actorMemberId: husbandMember.id,
        createdByMemberId: husbandMember.id,
        categoryId: expenseCategory.id,
        amountFen: 17600,
        occurredAt: new Date("2026-05-06T01:30:00.000Z"),
        note: "Manual lunch",
      },
    });
    const firstDraft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook(),
      fileName: "first-decision.xlsx",
      sessionUser,
    });
    const secondDraft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook({ rawNote: "second draft" }),
      fileName: "second-decision.xlsx",
      sessionUser,
    });
    await saveDefaultMappings(firstDraft.id, sessionUser);
    await saveDefaultMappings(secondDraft.id, sessionUser);
    const firstSummary = await services.getImportDraftSummary(firstDraft.id, sessionUser);
    const firstRowId = firstSummary.rows[0]!.id;

    await expect(
      services.setImportDraftRowDecision(
        secondDraft.id,
        firstRowId,
        ImportRowDecision.SKIP,
        sessionUser,
      ),
    ).rejects.toThrow("Import draft row not found");

    const afterAttempt = await services.getImportDraftSummary(firstDraft.id, sessionUser);

    expect(afterAttempt.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
      userDecision: ImportRowDecision.KEEP,
    });
  });

  it("rejects summary and confirmation access from outside the draft household", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const outsideSessionUser = await createOutsideSessionUser();
    const draft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook(),
      fileName: "private.xlsx",
      sessionUser,
    });

    await expect(services.getImportDraftSummary(draft.id, outsideSessionUser)).rejects.toThrow(
      /Unauthorized|Import draft not found/,
    );
    await expect(services.confirmImportDraft(draft.id, outsideSessionUser)).rejects.toThrow(
      /Unauthorized|Import draft not found/,
    );
  });
});
