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
  Prisma,
  TransactionType,
} from "@prisma/client";
import ExcelJS from "exceljs";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";

import { WECHAT_PAY_SOURCE } from "@/lib/imports/types";

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

const wechatHeaders = [
  "交易时间",
  "交易类型",
  "交易对方",
  "商品",
  "收/支",
  "金额(元)",
  "支付方式",
  "当前状态",
  "交易单号",
  "商户单号",
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

async function buildWechatPayWorkbook(ownerName = "李环宇") {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRows([
    ["微信支付账单明细"],
    [`微信昵称：[${ownerName}]`],
    ["起始时间：[2026-04-30 00:00:00] 终止时间：[2026-05-07 20:26:54]"],
    [],
    ["----------------------微信支付账单明细列表--------------------"],
    wechatHeaders,
    [
      "2026-05-02 17:22:40",
      "扫二维码付款",
      "阿泉食杂店",
      "收款方备注:二维码收款",
      "支出",
      "30",
      "招商银行储蓄卡(1209)",
      "已转账",
      "53110001409141202605020932752192",
      "10001073012026050201637220123649",
      "/",
    ],
  ]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
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

describe("import draft services", () => {
  it("creates a WeChat Pay draft with owner inferred from the file header", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const draft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-pay.xlsx",
      sessionUser,
    });

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.source).toBe(WECHAT_PAY_SOURCE);
    expect(summary.missingMappings).toMatchObject([
      {
        mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
        primaryCategory: "扫二维码付款",
        secondaryCategory: "阿泉食杂店",
        transactionType: TransactionType.EXPENSE,
      },
    ]);
    expect(summary.rows[0]).toMatchObject({
      actorFallbackApplied: false,
      actorMemberId: husbandMember.id,
      createdByMemberId: husbandMember.id,
      creatorFallbackApplied: false,
      rawCreatedBy: "李环宇",
      rawMember: "李环宇",
      status: ImportDraftRowStatus.NEEDS_MAPPING,
    });
  });

  it("falls back to the current member when a WeChat Pay owner cannot be inferred", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const draft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("陌生昵称"),
      fileName: "wechat-pay-unknown.xlsx",
      sessionUser,
    });

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.rows[0]).toMatchObject({
      actorFallbackApplied: true,
      actorMemberId: sessionUser.memberId,
      createdByMemberId: sessionUser.memberId,
      creatorFallbackApplied: true,
    });
  });

  it("updates WeChat Pay draft owner member on importable rows before confirmation", async () => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const draft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-owner.xlsx",
      sessionUser,
    });

    await services.saveWechatPayDraftOwnerMember(draft.id, wifeMember.id, sessionUser);

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.rows[0]).toMatchObject({
      actorFallbackApplied: false,
      actorMemberId: wifeMember.id,
      createdByMemberId: wifeMember.id,
      creatorFallbackApplied: false,
    });
  });

  it("updates WeChat Pay draft owner member only on rows that are not invalid or source duplicates", async () => {
    const { husbandMember, sessionUser, wifeMember } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("陌生昵称"),
      fileName: "wechat-owner-statuses.xlsx",
      sessionUser,
    });
    const statuses = [
      ImportDraftRowStatus.READY,
      ImportDraftRowStatus.NEEDS_MAPPING,
      ImportDraftRowStatus.POSSIBLE_DUPLICATE,
      ImportDraftRowStatus.USER_SKIPPED,
      ImportDraftRowStatus.INVALID,
      ImportDraftRowStatus.SOURCE_DUPLICATE,
    ];

    await db.importDraftRow.deleteMany({ where: { draftId: draft.id } });
    await db.importDraftRow.createMany({
      data: statuses.map((status, index) => ({
        actorFallbackApplied: true,
        actorMemberId: husbandMember.id,
        amountFen: 3000 + index,
        categoryId:
          status === ImportDraftRowStatus.NEEDS_MAPPING ? null : expenseCategory.id,
        createdByMemberId: husbandMember.id,
        creatorFallbackApplied: true,
        draftId: draft.id,
        mappingKey: `wechat_pay|EXPENSE|扫二维码付款|owner-status-${index}`,
        occurredAt: new Date("2026-05-02T09:22:40.000Z"),
        occurredDate: "2026-05-02",
        primaryCategory: "扫二维码付款",
        rawCreatedBy: "陌生昵称",
        rawMember: "陌生昵称",
        rowNumber: index + 1,
        secondaryCategory: `owner-status-${index}`,
        skipReason:
          status === ImportDraftRowStatus.USER_SKIPPED ||
          status === ImportDraftRowStatus.SOURCE_DUPLICATE
            ? "Skipped"
            : null,
        sourceFingerprint: `wechat-owner-status-${index}`,
        status,
        transactionType: TransactionType.EXPENSE,
        userDecision:
          status === ImportDraftRowStatus.USER_SKIPPED ||
          status === ImportDraftRowStatus.SOURCE_DUPLICATE
            ? ImportRowDecision.SKIP
            : ImportRowDecision.KEEP,
      })),
    });

    await services.saveWechatPayDraftOwnerMember(draft.id, wifeMember.id, sessionUser);

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);
    const rowsByStatus = new Map(summary.rows.map((row) => [row.status, row]));
    const updatedStatuses = [
      ImportDraftRowStatus.READY,
      ImportDraftRowStatus.NEEDS_MAPPING,
      ImportDraftRowStatus.POSSIBLE_DUPLICATE,
      ImportDraftRowStatus.USER_SKIPPED,
    ];

    for (const status of updatedStatuses) {
      expect(rowsByStatus.get(status)).toMatchObject({
        actorFallbackApplied: false,
        actorMemberId: wifeMember.id,
        createdByMemberId: wifeMember.id,
        creatorFallbackApplied: false,
      });
    }

    for (const status of [
      ImportDraftRowStatus.INVALID,
      ImportDraftRowStatus.SOURCE_DUPLICATE,
    ]) {
      expect(rowsByStatus.get(status)).toMatchObject({
        actorFallbackApplied: true,
        actorMemberId: husbandMember.id,
        createdByMemberId: husbandMember.id,
        creatorFallbackApplied: true,
      });
    }
  });

  it("waits for concurrent WeChat Pay draft completion before changing owner member", async () => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const draft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-owner-concurrent.xlsx",
      sessionUser,
    });
    let releaseDraftLock = () => {};
    const draftLockReleased = new Promise<void>((resolve) => {
      releaseDraftLock = resolve;
    });
    let markDraftLocked = () => {};
    const draftLocked = new Promise<void>((resolve) => {
      markDraftLocked = resolve;
    });
    const lockTransaction = db.$transaction(
      async (tx) => {
        await tx.importDraft.update({
          where: { id: draft.id },
          data: {
            completedAt: new Date("2026-05-07T12:00:00.000Z"),
            status: ImportDraftStatus.COMPLETED,
          },
        });
        markDraftLocked();
        await draftLockReleased;
      },
      { timeout: 10_000 },
    );

    await draftLocked;

    const ownerChange = services.saveWechatPayDraftOwnerMember(
      draft.id,
      wifeMember.id,
      sessionUser,
    );
    const earlyResult = await Promise.race([
      ownerChange.then(
        () => "resolved",
        (error: Error) => error.message,
      ),
      new Promise<"blocked">((resolve) => {
        setTimeout(() => resolve("blocked"), 250);
      }),
    ]);

    releaseDraftLock();
    await lockTransaction;

    expect(earlyResult).toBe("blocked");
    await expect(ownerChange).rejects.toThrow("Import draft is already completed");
  });

  it("does not allow WeChat Pay owner changes after completion", async () => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-completed-owner.xlsx",
      sessionUser,
    });
    await services.saveImportDraftMappings(
      draft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
        },
      ],
      sessionUser,
    );
    await services.confirmImportDraft(draft.id, sessionUser);

    await expect(
      services.saveWechatPayDraftOwnerMember(draft.id, wifeMember.id, sessionUser),
    ).rejects.toThrow("Import draft is already completed");
  });

  it("rejects WeChat Pay owner member changes to a member outside the current household", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const outsideSessionUser = await createOutsideSessionUser();
    const draft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-owner-private.xlsx",
      sessionUser,
    });

    await expect(
      services.saveWechatPayDraftOwnerMember(draft.id, outsideSessionUser.memberId, sessionUser),
    ).rejects.toThrow("Member not found");
  });

  it("loads possible duplicate candidates without one transaction lookup per parsed row", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();

    await db.importCategoryMapping.create({
      data: {
        categoryId: expenseCategory.id,
        householdId: sessionUser.householdId,
        primaryCategory: "餐饮",
        secondaryCategory: "三餐",
        source: "sui_shou_ji",
        transactionType: TransactionType.EXPENSE,
      },
    });
    await db.transaction.create({
      data: {
        actorMemberId: husbandMember.id,
        amountFen: 17600,
        categoryId: expenseCategory.id,
        createdByMemberId: husbandMember.id,
        householdId: sessionUser.householdId,
        note: "Manual lunch",
        occurredAt: new Date("2026-05-06T02:30:00.000Z"),
        type: TransactionType.EXPENSE,
      },
    });

    const findManySpy = vi.spyOn(db.transaction, "findMany");
    const draft = await services.createSuiShouJiImportDraft({
      buffer: await buildWorkbookBuffer({
        支出: [
          headers,
          expenseRow({ rawAmount: "176", rawNote: "first" }),
          expenseRow({ rawAmount: "28", rawNote: "second" }),
          expenseRow({ rawAmount: "9", rawNote: "third" }),
        ],
      }),
      fileName: "batched-possible-duplicates.xlsx",
      sessionUser,
    });
    const transactionFindManyCallCount = findManySpy.mock.calls.length;

    findManySpy.mockRestore();

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(transactionFindManyCallCount).toBe(2);
    expect(summary.rows.map((row) => row.status)).toEqual([
      ImportDraftRowStatus.POSSIBLE_DUPLICATE,
      ImportDraftRowStatus.READY,
      ImportDraftRowStatus.READY,
    ]);
    expect(summary.rows[0]?.duplicateCandidates).toHaveLength(1);
  });

  it("confirms WeChat Pay drafts and marks later same-source rows as duplicates", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const buffer = await buildWechatPayWorkbook("李环宇");
    const draft = await services.createWechatPayImportDraft({
      buffer,
      fileName: "wechat-pay-confirm.xlsx",
      sessionUser,
    });
    await services.saveImportDraftMappings(
      draft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
        },
      ],
      sessionUser,
    );

    const result = await services.confirmImportDraft(draft.id, sessionUser);

    expect(result).toMatchObject({
      createdCount: 1,
      sourceDuplicateCount: 0,
    });

    const transaction = await db.transaction.findFirstOrThrow({
      where: {
        householdId: sessionUser.householdId,
        source: "wechat_pay",
      },
    });

    expect(transaction).toMatchObject({
      actorMemberId: husbandMember.id,
      amountFen: 3000,
      categoryId: expenseCategory.id,
      createdByMemberId: husbandMember.id,
      householdId: sessionUser.householdId,
      source: "wechat_pay",
    });
    expect(transaction.sourceFingerprint).toEqual(expect.any(String));
    expect(transaction.sourceFingerprint).not.toBe("");
    expect(transaction.sourceImportedAt).toBeInstanceOf(Date);

    const duplicateDraft = await services.createWechatPayImportDraft({
      buffer,
      fileName: "wechat-pay-duplicate.xlsx",
      sessionUser,
    });
    const duplicateSummary = await services.getImportDraftSummary(duplicateDraft.id, sessionUser);

    expect(duplicateSummary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
      userDecision: ImportRowDecision.SKIP,
    });
  });

  it("reuses household WeChat Pay category mappings on the next draft", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const firstDraft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-first.xlsx",
      sessionUser,
    });

    await services.saveImportDraftMappings(
      firstDraft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
        },
      ],
      sessionUser,
    );

    const secondDraft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-second.xlsx",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(secondDraft.id, sessionUser);

    expect(summary.counts.needsMapping).toBe(0);
    expect(summary.rows[0]).toMatchObject({
      categoryId: expenseCategory.id,
      status: ImportDraftRowStatus.READY,
    });
  });

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

  it("confirms large mapped drafts without expiring the transaction", async () => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await db.importDraft.create({
      data: {
        createdByMemberId: sessionUser.memberId,
        fileName: "large-confirm.xlsx",
        householdId: sessionUser.householdId,
        source: "sui_shou_ji",
      },
      select: { id: true },
    });
    const rowCount = 6_000;

    await db.importDraftRow.createMany({
      data: Array.from({ length: rowCount }, (_, index) => ({
        actorMemberId: wifeMember.id,
        amountFen: 1_000 + index,
        categoryId: expenseCategory.id,
        createdByMemberId: wifeMember.id,
        draftId: draft.id,
        mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐",
        note: `large confirm ${index}`,
        occurredAt: new Date(Date.UTC(2026, 4, 6, 5, index % 60, 0)),
        occurredDate: "2026-05-06",
        primaryCategory: "餐饮",
        rawAmount: String(10 + index),
        rawCreatedBy: "晶晶",
        rawCurrency: "CNY",
        rawDate: "2026-05-06 13:00:00",
        rawMember: "晶晶",
        rawTransactionType: "支出",
        rowNumber: index + 2,
        secondaryCategory: "三餐",
        sourceFingerprint: `large-confirm-${index.toString().padStart(4, "0")}`,
        status: ImportDraftRowStatus.READY,
        transactionType: TransactionType.EXPENSE,
        userDecision: ImportRowDecision.KEEP,
      })),
    });

    const result = await services.confirmImportDraft(draft.id, sessionUser);

    expect(result.createdCount).toBe(rowCount);
    expect(result.sourceDuplicateCount).toBe(0);
    await expect(
      db.transaction.count({
        where: {
          householdId: sessionUser.householdId,
          source: "sui_shou_ji",
        },
      }),
    ).resolves.toBe(rowCount);
  }, 30_000);

  it("saves category mappings without per-row draft row updates", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await db.importDraft.create({
      data: {
        createdByMemberId: sessionUser.memberId,
        fileName: "batched-mapping.xlsx",
        householdId: sessionUser.householdId,
        source: "sui_shou_ji",
      },
      select: { id: true },
    });
    const mappingKey = "sui_shou_ji|EXPENSE|餐饮|三餐";

    await db.importDraftRow.createMany({
      data: [
        {
          actorMemberId: husbandMember.id,
          amountFen: 17600,
          createdByMemberId: husbandMember.id,
          draftId: draft.id,
          mappingKey,
          occurredAt: new Date("2026-05-06T05:23:02.000Z"),
          occurredDate: "2026-05-06",
          primaryCategory: "餐饮",
          rowNumber: 1,
          secondaryCategory: "三餐",
          sourceFingerprint: "batched-mapping-ready-1",
          status: ImportDraftRowStatus.NEEDS_MAPPING,
          transactionType: TransactionType.EXPENSE,
          userDecision: ImportRowDecision.KEEP,
        },
        {
          actorMemberId: husbandMember.id,
          amountFen: 2800,
          createdByMemberId: husbandMember.id,
          draftId: draft.id,
          mappingKey,
          occurredAt: new Date("2026-05-06T06:23:02.000Z"),
          occurredDate: "2026-05-06",
          primaryCategory: "餐饮",
          rowNumber: 2,
          secondaryCategory: "三餐",
          sourceFingerprint: "batched-mapping-ready-2",
          status: ImportDraftRowStatus.NEEDS_MAPPING,
          transactionType: TransactionType.EXPENSE,
          userDecision: ImportRowDecision.KEEP,
        },
        {
          actorMemberId: husbandMember.id,
          amountFen: 900,
          createdByMemberId: husbandMember.id,
          draftId: draft.id,
          duplicateCandidates: [
            {
              amountFen: 900,
              categoryId: expenseCategory.id,
              id: "candidate-1",
              occurredAt: "2026-05-06T02:30:00.000Z",
              source: null,
              type: TransactionType.EXPENSE,
            },
          ] satisfies Prisma.InputJsonValue,
          mappingKey,
          occurredAt: new Date("2026-05-06T07:23:02.000Z"),
          occurredDate: "2026-05-06",
          primaryCategory: "餐饮",
          rowNumber: 3,
          secondaryCategory: "三餐",
          sourceFingerprint: "batched-mapping-duplicate",
          status: ImportDraftRowStatus.NEEDS_MAPPING,
          transactionType: TransactionType.EXPENSE,
          userDecision: ImportRowDecision.KEEP,
        },
        {
          draftId: draft.id,
          mappingKey,
          rowNumber: 4,
          skipReason: "Invalid amount",
          status: ImportDraftRowStatus.INVALID,
          userDecision: ImportRowDecision.SKIP,
        },
        {
          draftId: draft.id,
          mappingKey,
          rowNumber: 5,
          skipReason: "Source duplicate",
          sourceFingerprint: "batched-mapping-source-duplicate",
          status: ImportDraftRowStatus.SOURCE_DUPLICATE,
          userDecision: ImportRowDecision.SKIP,
        },
      ],
    });

    const rowUpdateSpy = vi
      .spyOn(db.importDraftRow, "update")
      .mockRejectedValue(new Error("saveImportDraftMappings must not update rows one by one"));

    try {
      await services.saveImportDraftMappings(
        draft.id,
        [{ categoryId: expenseCategory.id, mappingKey }],
        sessionUser,
      );
    } finally {
      rowUpdateSpy.mockRestore();
    }

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(rowUpdateSpy).not.toHaveBeenCalled();
    expect(summary.rows.map((row) => row.status)).toEqual([
      ImportDraftRowStatus.READY,
      ImportDraftRowStatus.READY,
      ImportDraftRowStatus.POSSIBLE_DUPLICATE,
      ImportDraftRowStatus.INVALID,
      ImportDraftRowStatus.SOURCE_DUPLICATE,
    ]);
    expect(summary.rows.slice(0, 3).map((row) => row.categoryId)).toEqual([
      expenseCategory.id,
      expenseCategory.id,
      expenseCategory.id,
    ]);
    expect(summary.rows.slice(3).map((row) => row.categoryId)).toEqual([null, null]);
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

  it("rejects mappings whose source does not match the import draft source", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await services.createSuiShouJiImportDraft({
      buffer: await buildExpenseWorkbook(),
      fileName: "wrong-source-mapping.xlsx",
      sessionUser,
    });

    await expect(
      services.saveImportDraftMappings(
        draft.id,
        [
          {
            categoryId: expenseCategory.id,
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
          },
        ],
        sessionUser,
      ),
    ).rejects.toThrow("Mapping source does not match import draft source");

    await expect(
      db.importCategoryMapping.count({
        where: {
          householdId: sessionUser.householdId,
          source: "wechat_pay",
        },
      }),
    ).resolves.toBe(0);
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
