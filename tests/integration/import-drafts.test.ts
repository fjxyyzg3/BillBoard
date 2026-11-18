import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

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
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import {
  ALIPAY_FULLY_REFUNDED,
  ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
  ALIPAY_SOURCE,
  CATEGORY_MAPPING_IGNORED,
  CMB_FULLY_REFUNDED,
  CMB_REFUND_MANUAL_REASONS,
  CMB_SOURCE,
  SUI_SHOU_JI_SOURCE,
  WECHAT_PAY_SOURCE,
  WECHAT_FULLY_REFUNDED,
  WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
} from "@/lib/imports/types";
import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";

type SessionUser = {
  householdId: string;
  ledgerId: string;
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

beforeEach(async () => {
  await db.resourceLease.deleteMany();
  await db.resourceWindow.deleteMany();
});

describe("import category ignore rules", () => {
  const mappingKey = "sui_shou_ji|EXPENSE|餐饮|三餐";

  async function createCategoryFixture(source: string = SUI_SHOU_JI_SOURCE) {
    const fixture = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await db.importDraft.create({
      data: {
        ledgerId: fixture.sessionUser.ledgerId,
        createdByMemberId: fixture.sessionUser.memberId,
        fileName: "category-rules.xlsx", householdId: fixture.sessionUser.householdId, source,
      },
    });

    return { ...fixture, draft, expenseCategory };
  }

  async function addCategoryRow(
    fixture: Awaited<ReturnType<typeof createCategoryFixture>>,
    overrides: Partial<Prisma.ImportDraftRowUncheckedCreateInput> = {},
  ) {
    return db.importDraftRow.create({
      data: {
        actorMemberId: fixture.husbandMember.id, amountFen: 1000,
        createdByMemberId: fixture.husbandMember.id, draftId: fixture.draft.id, mappingKey,
        occurredAt: new Date("2026-05-06T02:30:00.000Z"), occurredDate: "2026-05-06",
        primaryCategory: "餐饮", rowNumber: 1, secondaryCategory: "三餐",
        sourceFingerprint: `ignore-${Math.random().toString(36).slice(2)}`,
        status: ImportDraftRowStatus.NEEDS_MAPPING, transactionType: TransactionType.EXPENSE,
        userDecision: ImportRowDecision.KEEP, ...overrides,
      },
    });
  }

  it("ignores a category group, excludes unresolved members, and confirms zero transactions", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildWorkbookBuffer({
        支出: [headers, expenseRow({ rawMember: "外部成员", rawCreatedBy: "外部成员" }),
          expenseRow({ rawAmount: "20", rawMember: "外部成员", rawCreatedBy: "外部成员" })],
      }),
      fileName: "category-ignore.xlsx",
      sessionUser,
    });
    await services.saveImportDraftMappings(draft.id, [{ categoryId: null, mappingKey }], sessionUser);

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);
    expect(summary.counts).toMatchObject({ importable: 0, needsMapping: 0, userSkipped: 2 });
    expect(summary.hasUnresolvedMemberMappings).toBe(false);
    expect(summary.memberMappings).toEqual([]);
    expect(summary.missingMappings).toEqual([]);
    expect(summary.ignoredMappings).toEqual([
      { count: 2, mappingKey, primaryCategory: "餐饮", secondaryCategory: "三餐", transactionType: TransactionType.EXPENSE },
    ]);
    expect(summary.rows).toEqual(expect.arrayContaining([
      expect.objectContaining({
        categoryId: null, skipReason: "CATEGORY_MAPPING_IGNORED",
        status: ImportDraftRowStatus.USER_SKIPPED, userDecision: ImportRowDecision.SKIP,
      }),
    ]));
    expect(await services.confirmImportDraft(draft.id, sessionUser))
      .toMatchObject({ completedNow: true, createdCount: 0, userSkippedCount: 2 });
    expect(await services.confirmImportDraft(draft.id, sessionUser))
      .toMatchObject({ completedNow: false, createdCount: 0 });
    expect(await db.transaction.count({ where: { householdId: sessionUser.householdId } })).toBe(0);

    const nextDraft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "category-ignore-reuse.xlsx", sessionUser,
    });
    const nextSummary = await services.getImportDraftSummary(nextDraft.id, sessionUser);
    expect(nextSummary.counts).toMatchObject({ importable: 0, needsMapping: 0, userSkipped: 1 });
    expect(nextSummary.rows[0]?.skipReason).toBe("CATEGORY_MAPPING_IGNORED");
  });

  it.each([SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE, ALIPAY_SOURCE, CMB_SOURCE])(
    "reuses household category ignore rules for %s when the other member imports", async (source) => {
      const { sessionUser, wifeMember } = await createHouseholdFixture();
      const input = { fileName: "category-rule", sessionUser };
      const create = async (currentUser: SessionUser) => {
        const currentInput = { ...input, sessionUser: currentUser };
        switch (source) {
          case SUI_SHOU_JI_SOURCE:
            return services.createSuiShouJiImportDraft({ context: currentInput.sessionUser, ...currentInput, buffer: await buildExpenseWorkbook() });
          case WECHAT_PAY_SOURCE:
            return services.createWechatPayImportDraft({ context: currentInput.sessionUser, ...currentInput, buffer: await buildWechatPayWorkbook() });
          case ALIPAY_SOURCE:
            return services.createAlipayImportDraft({ context: currentInput.sessionUser, ...currentInput, buffer: buildAlipayCsv() });
          case CMB_SOURCE:
            return services.createCmbImportDraft({ context: currentInput.sessionUser, ...currentInput, buffer: await readCmbFixture() });
        }
      };
      const first = await create(sessionUser);
      const firstSummary = await services.getImportDraftSummary(first.id, sessionUser);
      const key = firstSummary.missingMappings.find((group) => group.transactionType === TransactionType.EXPENSE)!.mappingKey;
      await services.saveImportDraftMappings(first.id, [{ categoryId: null, mappingKey: key }], sessionUser);
      const next = await create({ ...sessionUser, memberId: wifeMember.id });
      const nextSummary = await services.getImportDraftSummary(next.id, sessionUser);

      expect(nextSummary.rows.filter((row) => row.mappingKey === key)).toEqual([
        expect.objectContaining({ categoryId: null, skipReason: CATEGORY_MAPPING_IGNORED,
          status: ImportDraftRowStatus.USER_SKIPPED, userDecision: ImportRowDecision.SKIP }),
      ]);
      expect(nextSummary.ignoredMappings).toEqual([
        expect.objectContaining({ count: 1, mappingKey: key }),
      ]);
      expect(await db.category.count({ where: { name: "忽略" } })).toBe(0);
    },
  );

  it("keeps category ignore rules isolated by household, source, type, primary and secondary category", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const outside = await createHouseholdFixture();
    const initial = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "category-ignore.xlsx", sessionUser,
    });
    await services.saveImportDraftMappings(initial.id, [{ categoryId: null, mappingKey }], sessionUser);
    const sameHousehold = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildWorkbookBuffer({
        支出: [headers, expenseRow(), expenseRow({ rawPrimaryCategory: "其他" }),
          expenseRow({ rawSecondaryCategory: "其他" })],
        收入: [headers, incomeRow({ rawPrimaryCategory: "餐饮", rawSecondaryCategory: "三餐" })],
      }),
      fileName: "category-key-isolation.xlsx", sessionUser,
    });
    const summary = await services.getImportDraftSummary(sameHousehold.id, sessionUser);
    expect(summary.counts).toMatchObject({ needsMapping: 3, userSkipped: 1 });
    const outsideDraft = await services.createSuiShouJiImportDraft({ context: outside.sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "outside.xlsx", sessionUser: outside.sessionUser,
    });
    expect((await services.getImportDraftSummary(outsideDraft.id, outside.sessionUser)).counts)
      .toMatchObject({ needsMapping: 1, userSkipped: 0 });
    const wechatDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWorkbookBuffer({ Sheet1: [
        ["微信支付账单明细"], ["微信昵称：[老公]"], [], wechatHeaders,
        ["2026-05-02 17:22:40", "餐饮", "三餐", "商品", "支出", "30", "零钱",
          "支付成功", "isolation-order", "isolation-merchant", "/"],
      ] }),
      fileName: "source-isolation.xlsx", sessionUser,
    });
    const wechatSummary = await services.getImportDraftSummary(wechatDraft.id, sessionUser);
    expect(wechatSummary.rows[0]?.mappingKey).toBe("wechat_pay|EXPENSE|餐饮|三餐");
    expect(wechatSummary.counts).toMatchObject({ needsMapping: 1, userSkipped: 0 });
  });

  it("restores category-ignored rows only, leaving manual, bank, invalid, source and refund skips unchanged", async () => {
    const fixture = await createCategoryFixture();
    const normal = await addCategoryRow(fixture);
    const duplicate = await addCategoryRow(fixture, {
      duplicateCandidates: [{ id: "candidate" }], rowNumber: 2,
      status: ImportDraftRowStatus.POSSIBLE_DUPLICATE, userDecision: ImportRowDecision.SKIP,
    });
    const protectedRows = [];
    const protectedReasons = [
      "User skipped", "Suggested bank transfer-like transaction", ALIPAY_FULLY_REFUNDED,
      ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT, WECHAT_FULLY_REFUNDED,
      WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT, CMB_FULLY_REFUNDED, ...CMB_REFUND_MANUAL_REASONS,
    ];
    for (const [index, skipReason] of protectedReasons.entries()) {
      protectedRows.push(await addCategoryRow(fixture, {
        categoryId: fixture.expenseCategory.id, rowNumber: index + 3, skipReason,
        status: ImportDraftRowStatus.USER_SKIPPED, userDecision: ImportRowDecision.SKIP,
      }));
    }
    for (const status of [ImportDraftRowStatus.INVALID, ImportDraftRowStatus.SOURCE_DUPLICATE]) {
      protectedRows.push(await addCategoryRow(fixture, {
        rowNumber: protectedRows.length + 3, skipReason: status,
        status, userDecision: ImportRowDecision.SKIP,
      }));
    }
    await services.saveImportDraftMappings(fixture.draft.id, [{ categoryId: null, mappingKey }], fixture.sessionUser);
    const ignored = await services.getImportDraftSummary(fixture.draft.id, fixture.sessionUser);
    expect(ignored.ignoredMappings[0]?.count).toBe(2);
    await services.saveImportDraftMappings(fixture.draft.id,
      [{ categoryId: fixture.expenseCategory.id, mappingKey }], fixture.sessionUser);
    const restored = await services.getImportDraftSummary(fixture.draft.id, fixture.sessionUser);
    expect(restored.rows.find((row) => row.id === normal.id)).toMatchObject({
      categoryId: fixture.expenseCategory.id, skipReason: null,
      status: ImportDraftRowStatus.READY, userDecision: ImportRowDecision.KEEP,
    });
    expect(restored.rows.find((row) => row.id === duplicate.id)).toMatchObject({
      categoryId: fixture.expenseCategory.id, skipReason: null,
      status: ImportDraftRowStatus.POSSIBLE_DUPLICATE, userDecision: ImportRowDecision.SKIP,
    });
    expect(restored.ignoredMappings).toEqual([]);
    expect(await db.importDraftRow.findMany({ where: { id: { in: protectedRows.map((row) => row.id) } },
      orderBy: { rowNumber: "asc" } })).toEqual(protectedRows);
    const future = await services.createSuiShouJiImportDraft({ context: fixture.sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "restored-rule.xlsx", sessionUser: fixture.sessionUser,
    });
    expect((await services.getImportDraftSummary(future.id, fixture.sessionUser)).rows[0])
      .toMatchObject({ categoryId: fixture.expenseCategory.id, status: ImportDraftRowStatus.READY });
  });

  it("restores one ignored category row to missing mapping without deleting the family rule", async () => {
    const fixture = await createCategoryFixture();
    const first = await addCategoryRow(fixture);
    await addCategoryRow(fixture, { rowNumber: 2 });
    await services.saveImportDraftMappings(fixture.draft.id, [{ categoryId: null, mappingKey }], fixture.sessionUser);
    await services.setImportDraftRowDecision(fixture.draft.id, first.id, ImportRowDecision.KEEP, fixture.sessionUser);
    const restored = await services.getImportDraftSummary(fixture.draft.id, fixture.sessionUser);
    expect(restored.rows[0]).toMatchObject({ categoryId: null, status: ImportDraftRowStatus.NEEDS_MAPPING,
      skipReason: null, userDecision: ImportRowDecision.KEEP });
    expect(restored.missingMappings[0]?.count).toBe(1);
    expect(restored.ignoredMappings[0]?.count).toBe(1);
    expect(await db.importCategoryMapping.findFirstOrThrow({ where: { householdId: fixture.household.id } }))
      .toMatchObject({ categoryId: null });
    await expect(services.confirmImportDraft(fixture.draft.id, fixture.sessionUser))
      .rejects.toThrow("Import draft has unresolved category mappings");
    await services.saveImportDraftMappings(fixture.draft.id, [{ categoryId: null, mappingKey }], fixture.sessionUser);
    expect((await services.getImportDraftSummary(fixture.draft.id, fixture.sessionUser)).counts)
      .toMatchObject({ needsMapping: 0, userSkipped: 2 });
  });

  it("does not republish an unchanged category ignore rule when another draft changes it", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory, incomeCategory } = await getSeededCategories();
    const first = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "category-A.xlsx", sessionUser,
    });
    await services.saveImportDraftMappings(first.id, [{ categoryId: null, mappingKey }], sessionUser);
    const second = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseIncomeWorkbook(), fileName: "category-B.xlsx", sessionUser,
    });
    await services.saveImportDraftMappings(first.id, [{ categoryId: expenseCategory.id, mappingKey }], sessionUser);
    const before = await db.importDraftRow.findMany({ where: { draftId: second.id, mappingKey } });
    await services.saveImportDraftMappings(second.id,
      [{ categoryId: incomeCategory.id, mappingKey: "sui_shou_ji|INCOME|职业收入|工资" }], sessionUser);
    await services.saveImportDraftMappings(second.id, [], sessionUser);
    expect(await db.importDraftRow.findMany({ where: { draftId: second.id, mappingKey } })).toEqual(before);
    expect((await services.getImportDraftSummary(second.id, sessionUser)).ignoredMappings)
      .toEqual([expect.objectContaining({ mappingKey })]);
    const next = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "category-C.xlsx", sessionUser,
    });
    expect((await services.getImportDraftSummary(next.id, sessionUser)).rows[0])
      .toMatchObject({ categoryId: expenseCategory.id, status: ImportDraftRowStatus.READY });
  });

  it("keeps soft-deleted source duplicates ahead of category ignore rules", async () => {
    const fixture = await createCategoryFixture();
    const initial = await services.createSuiShouJiImportDraft({ context: fixture.sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "source-history.xlsx", sessionUser: fixture.sessionUser,
    });
    const original = await db.importDraftRow.findFirstOrThrow({ where: { draftId: initial.id } });
    await db.transaction.create({ data: {
      ledgerId: fixture.sessionUser.ledgerId,
      actorMemberId: fixture.husbandMember.id, amountFen: original.amountFen!, categoryId: fixture.expenseCategory.id,
      createdByMemberId: fixture.husbandMember.id, deletedAt: new Date(), householdId: fixture.household.id,
      occurredAt: original.occurredAt!, source: SUI_SHOU_JI_SOURCE,
      sourceFingerprint: original.sourceFingerprint, type: TransactionType.EXPENSE,
    } });
    await services.saveImportDraftMappings(initial.id, [{ categoryId: null, mappingKey }], fixture.sessionUser);
    const next = await services.createSuiShouJiImportDraft({ context: fixture.sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "deleted-source.xlsx", sessionUser: fixture.sessionUser,
    });
    expect((await services.getImportDraftSummary(next.id, fixture.sessionUser)).rows[0])
      .toMatchObject({ skipReason: "Source duplicate", status: ImportDraftRowStatus.SOURCE_DUPLICATE });
  });

  it("keeps initial full refunds and default CMB skips ahead of persistent category ignore", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const partial = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook(), fileName: "partial.xlsx", sessionUser,
    });
    await services.saveImportDraftMappings(partial.id,
      [{ categoryId: null, mappingKey: "wechat_pay|EXPENSE|商户消费|示例服务有限公司" }], sessionUser);
    const full = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook({ paymentStatus: "已全额退款", refundAmount: "2.00" }),
      fileName: "full.xlsx", sessionUser,
    });
    expect((await services.getImportDraftSummary(full.id, sessionUser)).rows[0])
      .toMatchObject({ skipReason: WECHAT_FULLY_REFUNDED, status: ImportDraftRowStatus.USER_SKIPPED });

    const bank = await services.createCmbImportDraft({ context: sessionUser,
      buffer: await readCmbFixture(), fileName: "bank.pdf", sessionUser,
    });
    const bankSummary = await services.getImportDraftSummary(bank.id, sessionUser);
    const transfer = bankSummary.rows.find((row) => row.skipReason === "Suggested bank transfer-like transaction")!;
    await services.saveImportDraftMappings(bank.id,
      [{ categoryId: null, mappingKey: transfer.mappingKey! }], sessionUser);
    const { expenseCategory, incomeCategory } = await getSeededCategories();
    await services.saveImportDraftMappings(bank.id,
      [{ categoryId: transfer.transactionType === TransactionType.EXPENSE ? expenseCategory.id : incomeCategory.id,
        mappingKey: transfer.mappingKey! }], sessionUser);
    expect((await services.getImportDraftSummary(bank.id, sessionUser)).rows.find((row) => row.id === transfer.id))
      .toEqual(transfer);
    await services.saveImportDraftMappings(bank.id,
      [{ categoryId: null, mappingKey: transfer.mappingKey! }], sessionUser);
    const nextBank = await services.createCmbImportDraft({ context: sessionUser,
      buffer: await readCmbFixture(), fileName: "bank-next.pdf", sessionUser,
    });
    expect((await services.getImportDraftSummary(nextBank.id, sessionUser)).rows
      .find((row) => row.mappingKey === transfer.mappingKey))
      .toMatchObject({ skipReason: transfer.skipReason, status: transfer.status, userDecision: transfer.userDecision });
  });

  it.each([null, "actual"])("rejects forged groups, sources, and foreign households for category mapping %s", async (value) => {
    const fixture = await createCategoryFixture();
    const row = await addCategoryRow(fixture);
    const categoryId = value === null ? null : fixture.expenseCategory.id;
    const outside = await createHouseholdFixture();
    await expect(services.saveImportDraftMappings(fixture.draft.id,
      [{ categoryId, mappingKey }], outside.sessionUser)).rejects.toThrow("Import draft not found");
    await expect(services.getImportDraftSummary(fixture.draft.id, outside.sessionUser))
      .rejects.toThrow("Import draft not found");
    await expect(services.confirmImportDraft(fixture.draft.id, outside.sessionUser))
      .rejects.toThrow("Import draft not found");
    await expect(services.saveImportDraftMappings(fixture.draft.id,
      [{ categoryId, mappingKey: "wechat_pay|EXPENSE|餐饮|三餐" }], fixture.sessionUser))
      .rejects.toThrow("Mapping source does not match import draft source");
    await expect(services.saveImportDraftMappings(fixture.draft.id,
      [{ categoryId, mappingKey: "sui_shou_ji|EXPENSE|不存在|三餐" }], fixture.sessionUser))
      .rejects.toThrow("Mapping group does not exist in import draft");
    await expect(services.saveImportDraftMappings(fixture.draft.id,
      [{ categoryId, mappingKey: `${mappingKey}|extra` }], fixture.sessionUser))
      .rejects.toThrow("Invalid import mapping key");
    await expect(services.saveImportDraftMappings(fixture.draft.id,
      [{ categoryId, mappingKey }, { categoryId, mappingKey }], fixture.sessionUser))
      .rejects.toThrow("Invalid import draft mappings");
    expect(await db.importCategoryMapping.count({ where: { householdId: fixture.household.id } })).toBe(0);
    expect(await db.importDraftRow.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
  });

  it("validates all category mappings before saving any group", async () => {
    const fixture = await createCategoryFixture();
    const first = await addCategoryRow(fixture);
    const secondKey = "sui_shou_ji|EXPENSE|其他|三餐";
    const second = await addCategoryRow(fixture, { mappingKey: secondKey, primaryCategory: "其他", rowNumber: 2 });
    const { incomeCategory } = await getSeededCategories();
    const inactive = await db.category.create({ data: {
      isActive: false, name: `Inactive ${fixture.household.id}`, sortOrder: 999, type: CategoryType.EXPENSE,
    } });
    createdCategoryIds.push(inactive.id);
    for (const [categoryId, message] of [
      [incomeCategory.id, "Category does not match transaction type"],
      [inactive.id, "Category not found"], ["not-a-category", "Category not found"], ["", "Category not found"],
    ]) {
      await expect(services.saveImportDraftMappings(fixture.draft.id,
        [{ categoryId: null, mappingKey }, { categoryId, mappingKey: secondKey }], fixture.sessionUser))
        .rejects.toThrow(message);
      expect(await db.importCategoryMapping.count({ where: { householdId: fixture.household.id } })).toBe(0);
      expect(await db.importDraftRow.findMany({ where: { draftId: fixture.draft.id }, orderBy: { rowNumber: "asc" } }))
        .toEqual([first, second]);
    }
  });

  it("rolls back saved category rules and earlier rows when a later database update fails", async () => {
    const fixture = await createCategoryFixture();
    const first = await addCategoryRow(fixture);
    const secondKey = "sui_shou_ji|EXPENSE|其他|三餐";
    const second = await addCategoryRow(fixture, {
      mappingKey: secondKey, note: "category-ignore-write-failure", primaryCategory: "其他", rowNumber: 2,
    });
    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION import_category_ignore_test_before_update()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.note = 'category-ignore-write-failure' THEN
          RAISE EXCEPTION 'Category mapping batch write failed';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER import_category_ignore_test_before_update_trigger
      BEFORE UPDATE ON "ImportDraftRow"
      FOR EACH ROW EXECUTE FUNCTION import_category_ignore_test_before_update();
    `);
    try {
      await expect(services.saveImportDraftMappings(fixture.draft.id,
        [{ categoryId: null, mappingKey }, { categoryId: null, mappingKey: secondKey }], fixture.sessionUser))
        .rejects.toThrow("Category mapping batch write failed");
      expect(await db.importCategoryMapping.count({ where: { householdId: fixture.household.id } })).toBe(0);
      expect(await db.importDraftRow.findMany({ where: { draftId: fixture.draft.id }, orderBy: { rowNumber: "asc" } }))
        .toEqual([first, second]);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS import_category_ignore_test_before_update_trigger ON "ImportDraftRow";');
      await db.$executeRawUnsafe("DROP FUNCTION IF EXISTS import_category_ignore_test_before_update();");
    }
  });

  it.each([null, "actual"])("waits for concurrent completion then rejects category mapping %s", async (value) => {
    const fixture = await createCategoryFixture();
    const row = await addCategoryRow(fixture);
    let releaseLock = () => {};
    const released = new Promise<void>((resolve) => { releaseLock = resolve; });
    let markLocked = () => {};
    const locked = new Promise<void>((resolve) => { markLocked = resolve; });
    const completion = db.$transaction(async (tx) => {
      await tx.importDraft.update({ where: { id: fixture.draft.id },
        data: { status: ImportDraftStatus.COMPLETED, completedAt: new Date() } });
      markLocked();
      await released;
    }, { timeout: 10_000 });
    await locked;
    const saving = services.saveImportDraftMappings(fixture.draft.id,
      [{ categoryId: value === null ? null : fixture.expenseCategory.id, mappingKey }], fixture.sessionUser);
    const earlyResult = await Promise.race([
      saving.then(() => "saved", (error: Error) => error.message),
      new Promise<string>((resolve) => { setTimeout(() => resolve("blocked"), 250); }),
    ]);
    releaseLock();
    await completion;
    expect(earlyResult).toBe("blocked");
    await expect(saving).rejects.toThrow("Import draft is already completed");
    await expect(services.saveImportDraftMappings(fixture.draft.id, [], fixture.sessionUser))
      .rejects.toThrow("Import draft is already completed");
    expect(await db.importCategoryMapping.count({ where: { householdId: fixture.household.id } })).toBe(0);
    expect(await db.importDraftRow.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
  });

  it("serializes category ignoring with confirmation of the same draft", async () => {
    const fixture = await createCategoryFixture();
    const row = await addCategoryRow(fixture, { categoryId: fixture.expenseCategory.id, status: ImportDraftRowStatus.READY });
    let releaseLock = () => {};
    const released = new Promise<void>((resolve) => { releaseLock = resolve; });
    let markLocked = () => {};
    const locked = new Promise<void>((resolve) => { markLocked = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ImportDraft" WHERE "id" = ${fixture.draft.id} FOR UPDATE`;
      markLocked();
      await released;
    }, { timeout: 10_000 });
    await locked;
    const confirming = services.confirmImportDraft(fixture.draft.id, fixture.sessionUser);
    await new Promise<void>((resolve) => { setTimeout(resolve, 150); });
    const saving = services.saveImportDraftMappings(fixture.draft.id, [{ categoryId: null, mappingKey }], fixture.sessionUser);
    const earlyResult = await Promise.race([
      saving.then(() => "saved", (error: Error) => error.message),
      new Promise<string>((resolve) => { setTimeout(() => resolve("blocked"), 150); }),
    ]);
    releaseLock();
    await blocker;
    expect(earlyResult).toBe("blocked");
    expect(await confirming).toMatchObject({ completedNow: true, createdCount: 1 });
    await expect(saving).rejects.toThrow("Import draft is already completed");
    expect(await db.importDraftRow.findUniqueOrThrow({ where: { id: row.id } })).toEqual(row);
    expect(await db.importCategoryMapping.count({ where: { householdId: fixture.household.id } })).toBe(0);
  });

  it("serializes category ignoring with a row decision so a restored row needs mapping", async () => {
    const fixture = await createCategoryFixture();
    const row = await addCategoryRow(fixture);
    let releaseLock = () => {};
    const released = new Promise<void>((resolve) => { releaseLock = resolve; });
    let markLocked = () => {};
    const locked = new Promise<void>((resolve) => { markLocked = resolve; });
    const blocker = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "ImportDraft" WHERE "id" = ${fixture.draft.id} FOR UPDATE`;
      markLocked();
      await released;
    }, { timeout: 10_000 });
    await locked;
    const ignoring = services.saveImportDraftMappings(fixture.draft.id, [{ categoryId: null, mappingKey }], fixture.sessionUser);
    await new Promise<void>((resolve) => { setTimeout(resolve, 150); });
    const restoring = services.setImportDraftRowDecision(fixture.draft.id, row.id, ImportRowDecision.KEEP, fixture.sessionUser);
    const earlyResult = await Promise.race([
      restoring.then(() => "restored", (error: Error) => error.message),
      new Promise<string>((resolve) => { setTimeout(() => resolve("blocked"), 150); }),
    ]);
    releaseLock();
    await blocker;
    expect(earlyResult).toBe("blocked");
    await ignoring;
    expect(await restoring).toMatchObject({ status: ImportDraftRowStatus.NEEDS_MAPPING, userDecision: ImportRowDecision.KEEP });
    expect(await db.importCategoryMapping.findFirstOrThrow({ where: { householdId: fixture.household.id } }))
      .toMatchObject({ categoryId: null });
    await expect(services.confirmImportDraft(fixture.draft.id, fixture.sessionUser))
      .rejects.toThrow("Import draft has unresolved category mappings");
  });

  it("ignores and restores a large category group before confirming all rows", async () => {
    const fixture = await createCategoryFixture();
    const rowCount = 1501;
    await db.importDraftRow.createMany({ data: Array.from({ length: rowCount }, (_, index) => ({
      actorMemberId: fixture.husbandMember.id, amountFen: index + 1000,
      createdByMemberId: fixture.husbandMember.id, draftId: fixture.draft.id, mappingKey,
      occurredAt: new Date("2026-05-06T02:30:00.000Z"), occurredDate: "2026-05-06",
      primaryCategory: "餐饮", rowNumber: index + 1, secondaryCategory: "三餐",
      sourceFingerprint: `large-ignore-${index}`, status: ImportDraftRowStatus.NEEDS_MAPPING,
      transactionType: TransactionType.EXPENSE, userDecision: ImportRowDecision.KEEP,
    })) });
    await services.saveImportDraftMappings(fixture.draft.id, [{ categoryId: null, mappingKey }], fixture.sessionUser);
    expect((await services.getImportDraftSummary(fixture.draft.id, fixture.sessionUser)).counts)
      .toMatchObject({ needsMapping: 0, userSkipped: rowCount });
    await services.saveImportDraftMappings(fixture.draft.id,
      [{ categoryId: fixture.expenseCategory.id, mappingKey }], fixture.sessionUser);
    expect((await services.getImportDraftSummary(fixture.draft.id, fixture.sessionUser)).counts)
      .toMatchObject({ importable: rowCount, needsMapping: 0, userSkipped: 0 });
    expect(await services.confirmImportDraft(fixture.draft.id, fixture.sessionUser))
      .toMatchObject({ completedNow: true, createdCount: rowCount });
    expect(await db.transaction.count({ where: { householdId: fixture.household.id } })).toBe(rowCount);
  }, 30_000);

  it("keeps nullable category rules constrained with RESTRICT deletion and CASCADE updates", async () => {
    const constraints = await db.$queryRaw<Array<{ deletion: string; update: string }>>`
      SELECT confdeltype AS "deletion", confupdtype AS "update"
      FROM pg_constraint
      WHERE conname = 'ImportCategoryMapping_category_id_fkey'
    `;
    expect(constraints).toEqual([{ deletion: "r", update: "c" }]);
  });
});

describe("import draft review services", () => {
  async function createReviewFixture() {
    const fixture = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await db.importDraft.create({
      data: {
        ledgerId: fixture.sessionUser.ledgerId,
        createdByMemberId: fixture.sessionUser.memberId,
        fileName: "review.xlsx",
        householdId: fixture.sessionUser.householdId,
        source: SUI_SHOU_JI_SOURCE,
      },
    });

    return { ...fixture, draft, expenseCategory };
  }

  async function createReviewRow(
    fixture: Awaited<ReturnType<typeof createReviewFixture>>,
    overrides: Partial<Prisma.ImportDraftRowUncheckedCreateInput> = {},
  ) {
    return db.importDraftRow.create({
      data: {
        actorMemberId: fixture.wifeMember.id,
        amountFen: 1000,
        categoryId: fixture.expenseCategory.id,
        createdByMemberId: fixture.wifeMember.id,
        draftId: fixture.draft.id,
        occurredAt: new Date("2026-05-06T02:30:00.000Z"),
        occurredDate: "2026-05-06",
        rowNumber: 2,
        status: ImportDraftRowStatus.READY,
        transactionType: TransactionType.EXPENSE,
        userDecision: ImportRowDecision.KEEP,
        ...overrides,
      },
    });
  }

  async function createReviewCandidate(
    fixture: Awaited<ReturnType<typeof createReviewFixture>>,
  ) {
    return db.transaction.create({
      data: {
        ledgerId: fixture.sessionUser.ledgerId,
        actorMemberId: fixture.wifeMember.id,
        amountFen: 2599,
        categoryId: fixture.expenseCategory.id,
        createdByMemberId: fixture.wifeMember.id,
        householdId: fixture.sessionUser.householdId,
        note: "Original record from another member",
        occurredAt: new Date("2020-01-02T04:00:00.000Z"),
        source: "other_source",
        sourceFingerprint: `private-source-fingerprint-${Math.random().toString(36).slice(2)}`,
        type: TransactionType.EXPENSE,
      },
    });
  }

  function candidateSnapshot(candidate: { id: string }) {
    return [{
      amountFen: 1,
      categoryId: "stale-category",
      id: candidate.id,
      occurredAt: "2026-01-01T00:00:00.000Z",
      source: null,
      type: TransactionType.INCOME,
    }] satisfies Prisma.InputJsonValue;
  }

  it("rejects changing an Alipay refund requiring manual adjustment", async () => {
    const fixture = await createReviewFixture();
    const row = await createReviewRow(fixture, {
      skipReason: ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
      status: ImportDraftRowStatus.USER_SKIPPED,
      userDecision: ImportRowDecision.SKIP,
    });

    await expect(
      services.setImportDraftRowDecision(
        fixture.draft.id,
        row.id,
        ImportRowDecision.KEEP,
        fixture.sessionUser,
      ),
    ).rejects.toThrow("Import draft row decision cannot be changed");
    await expect(db.importDraftRow.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({
        skipReason: ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
        status: ImportDraftRowStatus.USER_SKIPPED,
        userDecision: ImportRowDecision.SKIP,
      });
  });

  it("saves changed decisions together and preserves unchanged default skips", async () => {
    const fixture = await createReviewFixture();
    const ready = await createReviewRow(fixture);
    const defaultSkip = await createReviewRow(fixture, {
      rowNumber: 3,
      skipReason: "Possible duplicate",
      status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
      userDecision: ImportRowDecision.SKIP,
    });
    const needsMapping = await createReviewRow(fixture, {
      categoryId: null,
      rowNumber: 4,
      skipReason: "User skipped",
      status: ImportDraftRowStatus.USER_SKIPPED,
      userDecision: ImportRowDecision.SKIP,
    });
    const possibleDuplicate = await createReviewRow(fixture, {
      duplicateCandidates: candidateSnapshot({ id: "candidate" }),
      rowNumber: 5,
      skipReason: "User skipped",
      status: ImportDraftRowStatus.USER_SKIPPED,
      userDecision: ImportRowDecision.SKIP,
    });
    const skippedReady = await createReviewRow(fixture, {
      rowNumber: 6,
      skipReason: "User skipped",
      status: ImportDraftRowStatus.USER_SKIPPED,
      userDecision: ImportRowDecision.SKIP,
    });

    await services.setImportDraftRowDecisions(fixture.draft.id, [
      { decision: ImportRowDecision.SKIP, rowId: ready.id },
      { decision: ImportRowDecision.SKIP, rowId: defaultSkip.id },
      { decision: ImportRowDecision.KEEP, rowId: needsMapping.id },
      { decision: ImportRowDecision.KEEP, rowId: possibleDuplicate.id },
      { decision: ImportRowDecision.KEEP, rowId: skippedReady.id },
    ], fixture.sessionUser);

    const rows = await db.importDraftRow.findMany({
      orderBy: { rowNumber: "asc" },
      where: { draftId: fixture.draft.id },
    });
    expect(rows.map(({ skipReason, status, userDecision }) => ({
      skipReason, status, userDecision,
    }))).toEqual([
      { skipReason: "User skipped", status: ImportDraftRowStatus.USER_SKIPPED, userDecision: ImportRowDecision.SKIP },
      { skipReason: "Possible duplicate", status: ImportDraftRowStatus.POSSIBLE_DUPLICATE, userDecision: ImportRowDecision.SKIP },
      { skipReason: null, status: ImportDraftRowStatus.NEEDS_MAPPING, userDecision: ImportRowDecision.KEEP },
      { skipReason: null, status: ImportDraftRowStatus.POSSIBLE_DUPLICATE, userDecision: ImportRowDecision.KEEP },
      { skipReason: null, status: ImportDraftRowStatus.READY, userDecision: ImportRowDecision.KEEP },
    ]);
    expect(rows[1]?.updatedAt).toEqual(defaultSkip.updatedAt);
  });

  it.each([ImportDraftRowStatus.INVALID, ImportDraftRowStatus.SOURCE_DUPLICATE])(
    "does not partially save a batch containing an uneditable %s row", async (status) => {
    const fixture = await createReviewFixture();
    const ready = await createReviewRow(fixture);
    const invalid = await createReviewRow(fixture, {
      rowNumber: 3,
      skipReason: "Invalid amount",
      status,
      userDecision: ImportRowDecision.SKIP,
    });

    await expect(services.setImportDraftRowDecisions(fixture.draft.id, [
      { decision: ImportRowDecision.SKIP, rowId: ready.id },
      { decision: ImportRowDecision.KEEP, rowId: invalid.id },
    ], fixture.sessionUser)).rejects.toThrow("Import draft row decision cannot be changed");
    await expect(db.importDraftRow.findUniqueOrThrow({ where: { id: ready.id } }))
      .resolves.toMatchObject({
        status: ImportDraftRowStatus.READY,
        userDecision: ImportRowDecision.KEEP,
      });
    },
  );

  it("rolls back earlier update groups when a later database write fails", async () => {
    const fixture = await createReviewFixture();
    const ready = await createReviewRow(fixture, { note: "batch-decision-failure-skip" });
    const restore = await createReviewRow(fixture, {
      note: "batch-decision-failure-keep",
      rowNumber: 3,
      skipReason: "User skipped",
      status: ImportDraftRowStatus.USER_SKIPPED,
      userDecision: ImportRowDecision.SKIP,
    });

    await db.$executeRawUnsafe(`
      CREATE OR REPLACE FUNCTION import_review_test_before_update()
      RETURNS trigger AS $$
      BEGIN
        IF NEW.note IN ('batch-decision-failure-skip', 'batch-decision-failure-keep')
          AND EXISTS (
            SELECT 1 FROM "ImportDraftRow"
            WHERE draft_id = NEW.draft_id AND id <> NEW.id
              AND (
                (note = 'batch-decision-failure-skip' AND user_decision = 'SKIP') OR
                (note = 'batch-decision-failure-keep' AND user_decision = 'KEEP')
              )
          )
        THEN
          RAISE EXCEPTION 'Review batch write failed';
        END IF;
        RETURN NEW;
      END;
      $$ LANGUAGE plpgsql;
    `);
    await db.$executeRawUnsafe(`
      CREATE TRIGGER import_review_test_before_update_trigger
      BEFORE UPDATE ON "ImportDraftRow"
      FOR EACH ROW EXECUTE FUNCTION import_review_test_before_update();
    `);

    try {
      await expect(services.setImportDraftRowDecisions(fixture.draft.id, [
        { decision: ImportRowDecision.SKIP, rowId: ready.id },
        { decision: ImportRowDecision.KEEP, rowId: restore.id },
      ], fixture.sessionUser)).rejects.toThrow("Review batch write failed");
      await expect(db.importDraftRow.findUniqueOrThrow({ where: { id: ready.id } }))
        .resolves.toMatchObject({ status: ImportDraftRowStatus.READY, userDecision: ImportRowDecision.KEEP });
      await expect(db.importDraftRow.findUniqueOrThrow({ where: { id: restore.id } }))
        .resolves.toMatchObject({ status: ImportDraftRowStatus.USER_SKIPPED, userDecision: ImportRowDecision.SKIP });
    } finally {
      await db.$executeRawUnsafe(`
        DROP TRIGGER IF EXISTS import_review_test_before_update_trigger ON "ImportDraftRow";
      `);
      await db.$executeRawUnsafe("DROP FUNCTION IF EXISTS import_review_test_before_update();");
    }
  });

  it("rejects oversized or duplicate-row decision batches", async () => {
    const fixture = await createReviewFixture();
    const row = await createReviewRow(fixture);

    await expect(services.setImportDraftRowDecisions(fixture.draft.id, [
      { decision: ImportRowDecision.SKIP, rowId: row.id },
      { decision: ImportRowDecision.KEEP, rowId: row.id },
    ], fixture.sessionUser)).rejects.toThrow("Invalid import draft row decisions");
    await expect(services.setImportDraftRowDecisions(fixture.draft.id,
      Array.from({ length: 101 }, (_, index) => ({
        decision: ImportRowDecision.SKIP,
        rowId: `row-${index}`,
      })), fixture.sessionUser,
    )).rejects.toThrow("Invalid import draft row decisions");
    await expect(db.importDraftRow.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({ userDecision: ImportRowDecision.KEEP });
  });

  it.each([
    ALIPAY_FULLY_REFUNDED,
    ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
    WECHAT_FULLY_REFUNDED,
    WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
  ])("rejects a whole batch for locked refund %s", async (skipReason) => {
    const fixture = await createReviewFixture();
    const ready = await createReviewRow(fixture);
    const locked = await createReviewRow(fixture, {
      rowNumber: 3,
      skipReason,
      status: ImportDraftRowStatus.USER_SKIPPED,
      userDecision: ImportRowDecision.SKIP,
    });

    await expect(services.setImportDraftRowDecisions(fixture.draft.id, [
      { decision: ImportRowDecision.SKIP, rowId: ready.id },
      { decision: ImportRowDecision.KEEP, rowId: locked.id },
    ], fixture.sessionUser)).rejects.toThrow("Import draft row decision cannot be changed");
    await expect(db.importDraftRow.findUniqueOrThrow({ where: { id: ready.id } }))
      .resolves.toMatchObject({ userDecision: ImportRowDecision.KEEP });
    await expect(db.importDraftRow.findUniqueOrThrow({ where: { id: locked.id } }))
      .resolves.toMatchObject({ skipReason, userDecision: ImportRowDecision.SKIP });
  });

  it("isolates batch decisions by household, member, and draft", async () => {
    const fixture = await createReviewFixture();
    const ready = await createReviewRow(fixture);
    const otherDraft = await db.importDraft.create({
      data: {
        ledgerId: fixture.sessionUser.ledgerId,
        createdByMemberId: fixture.sessionUser.memberId,
        fileName: "other.xlsx",
        householdId: fixture.sessionUser.householdId,
        source: SUI_SHOU_JI_SOURCE,
      },
    });
    const otherRow = await createReviewRow(fixture, { draftId: otherDraft.id });
    const outside = await createHouseholdFixture();
    const validDecision = [{ decision: ImportRowDecision.SKIP, rowId: ready.id }];

    await expect(services.setImportDraftRowDecisions(fixture.draft.id, [
      ...validDecision,
      { decision: ImportRowDecision.SKIP, rowId: otherRow.id },
    ], fixture.sessionUser)).rejects.toThrow("Import draft row not found");
    await expect(services.setImportDraftRowDecisions(fixture.draft.id, validDecision, outside.sessionUser))
      .rejects.toThrow(/Unauthorized|Import draft not found/);
    await expect(services.setImportDraftRowDecisions(fixture.draft.id, validDecision, {
      ...fixture.sessionUser,
      memberId: outside.sessionUser.memberId,
    })).rejects.toThrow("Unauthorized");
    await expect(db.importDraftRow.findUniqueOrThrow({ where: { id: ready.id } }))
      .resolves.toMatchObject({ userDecision: ImportRowDecision.KEEP });
  });

  it("rejects decisions on a completed draft", async () => {
    const fixture = await createReviewFixture();
    const row = await createReviewRow(fixture);
    await db.importDraft.update({
      data: { status: ImportDraftStatus.COMPLETED },
      where: { id: fixture.draft.id },
    });

    await expect(services.setImportDraftRowDecisions(fixture.draft.id, [
      { decision: ImportRowDecision.SKIP, rowId: row.id },
    ], fixture.sessionUser)).rejects.toThrow("Import draft is already completed");
    await expect(db.importDraftRow.findUniqueOrThrow({ where: { id: row.id } }))
      .resolves.toMatchObject({ userDecision: ImportRowDecision.KEEP });
  });

  it("opens live candidate details from an older date and another household member", async () => {
    const fixture = await createReviewFixture();
    const candidate = await createReviewCandidate(fixture);
    const row = await createReviewRow(fixture, {
      duplicateCandidates: candidateSnapshot(candidate),
      status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
    });

    const detail = await services.getImportDuplicateCandidate(
      fixture.draft.id, row.id, candidate.id, fixture.sessionUser,
    );

    expect(detail).toEqual({
      actorMemberName: "老婆",
      amountFen: 2599,
      categoryName: "Dining",
      createdByMemberName: "老婆",
      id: candidate.id,
      note: "Original record from another member",
      occurredAt: new Date("2020-01-02T04:00:00.000Z"),
      source: "other_source",
      type: TransactionType.EXPENSE,
    });
  });

  it("does not return deleted, missing, or unlisted candidate records", async () => {
    const fixture = await createReviewFixture();
    const candidate = await createReviewCandidate(fixture);
    const unlisted = await createReviewCandidate(fixture);
    const row = await createReviewRow(fixture, {
      duplicateCandidates: candidateSnapshot(candidate),
    });

    await expect(services.getImportDuplicateCandidate(
      fixture.draft.id, row.id, unlisted.id, fixture.sessionUser,
    )).resolves.toBeNull();
    await db.transaction.update({
      data: { deletedAt: new Date() },
      where: { id: candidate.id },
    });
    await expect(services.getImportDuplicateCandidate(
      fixture.draft.id, row.id, candidate.id, fixture.sessionUser,
    )).resolves.toBeNull();
    await db.transaction.delete({ where: { id: candidate.id } });
    await expect(services.getImportDuplicateCandidate(
      fixture.draft.id, row.id, candidate.id, fixture.sessionUser,
    )).resolves.toBeNull();
  });

  it("does not return candidate data from another household or draft", async () => {
    const fixture = await createReviewFixture();
    const outside = await createReviewFixture();
    const candidate = await createReviewCandidate(outside);
    const row = await createReviewRow(fixture, {
      duplicateCandidates: candidateSnapshot(candidate),
    });

    await expect(services.getImportDuplicateCandidate(
      fixture.draft.id, row.id, candidate.id, fixture.sessionUser,
    )).resolves.toBeNull();
    await expect(services.getImportDuplicateCandidate(
      fixture.draft.id, row.id, candidate.id, outside.sessionUser,
    )).resolves.toBeNull();
    await expect(services.getImportDuplicateCandidate(
      outside.draft.id, row.id, candidate.id, outside.sessionUser,
    )).resolves.toBeNull();
    await expect(services.getImportDuplicateCandidate(
      fixture.draft.id, row.id, candidate.id, {
        ...fixture.sessionUser,
        memberId: outside.sessionUser.memberId,
      },
    )).rejects.toThrow("Unauthorized");
  });
});

afterEach(async () => {
  await uninstallImportDraftTestTrigger();

  for (const householdId of createdHouseholdIds.splice(0, createdHouseholdIds.length)) {
    await db.importMemberMapping.deleteMany({ where: { householdId } });
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
    overrides.rawMember ?? "老婆",
    overrides.rawMerchant ?? "小店",
    overrides.rawCreatedBy ?? "老婆",
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
    overrides.rawCreatedBy ?? "老公",
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

function readCmbFixture(name = "statement-single-page.pdf") {
  return readFile(path.join(process.cwd(), "tests", "fixtures", "imports", "cmb", name));
}

async function buildCmbZip() {
  const writer = new Uint8ArrayWriter();
  const zipWriter = new ZipWriter(writer, {
    password: "integration-password",
    useWebWorkers: false,
    zipCrypto: true,
  });
  await zipWriter.add(
    "招商银行交易流水.pdf",
    new Uint8ArrayReader(await readCmbFixture()),
  );
  return Buffer.from(await zipWriter.close());
}

async function buildWechatPayWorkbook(ownerName = "老公") {
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
      "示例商户",
      "收款方备注:二维码收款",
      "支出",
      "30",
      "示例银行储蓄卡(0000)",
      "已转账",
      "wechat-order-example-1",
      "wechat-merchant-order-example-1",
      "/",
    ],
  ]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

async function buildWechatRefundWorkbook(input: {
  includeOrdinaryExpense?: boolean;
  includePayment?: boolean;
  includeRefundIncome?: boolean;
  ownerName?: string;
  paymentAmount?: string;
  paymentStatus?: string;
  refundAmount?: string;
} = {}) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  const rows: unknown[][] = [];
  const paymentAmount = input.paymentAmount ?? "2";
  const refundAmount = input.refundAmount ?? "1.19";

  if (input.includeRefundIncome !== false) {
    rows.push([
      "2026-08-22 12:33:33",
      "示例服务有限公司-退款",
      "示例服务有限公司",
      "示例服务有限公司",
      "收入",
      refundAmount,
      "零钱",
      `已退款¥${refundAmount}`,
      "wechat-refund-order",
      "",
      "/",
    ]);
  }

  if (input.includePayment !== false) {
    rows.push([
      "2026-08-22 06:10:21",
      "商户消费",
      "示例服务有限公司",
      "示例商品",
      "支出",
      paymentAmount,
      "零钱",
      input.paymentStatus ?? `已退款(¥${refundAmount})`,
      "wechat-payment-order",
      "wechat-payment-merchant-order",
      "/",
    ]);
  }

  if (input.includeOrdinaryExpense) {
    rows.push([
      "2026-08-22 07:10:21",
      "餐饮",
      "普通商户",
      "普通商品",
      "支出",
      "3.00",
      "零钱",
      "支付成功",
      "wechat-ordinary-order",
      "wechat-ordinary-merchant-order",
      "/",
    ]);
  }

  sheet.addRows([
    ["微信支付账单明细"],
    [`微信昵称：[${input.ownerName ?? "老公"}]`],
    ["起始时间：[2026-08-21 00:00:00] 终止时间：[2026-08-23 23:59:59]"],
    [],
    ["----------------------微信支付账单明细列表--------------------"],
    wechatHeaders,
    ...rows,
  ]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

const alipayHeaders = [
  "交易时间",
  "交易分类",
  "交易对方",
  "对方账号",
  "商品说明",
  "收/支",
  "金额",
  "收/付款方式",
  "交易状态",
  "交易订单号",
  "商家订单号",
  "备注",
  "",
];

function alipayExpenseRow(
  orderId: string,
  overrides: { amount?: string; merchantOrderId?: string } = {},
) {
  return [
    "2026-05-07 12:17:13",
    "餐饮美食",
    "示例商户",
    "/",
    "示例商品",
    "支出",
    overrides.amount ?? "22.85",
    "示例银行信用卡(0000)&红包",
    "交易成功",
    orderId,
    overrides.merchantOrderId ?? `${orderId}-merchant`,
    "/",
    "",
  ];
}

function alipayRefundRow(
  orderId: string,
  overrides: { amount?: string; merchantOrderId?: string } = {},
) {
  return [
    "2026-05-07 18:17:13",
    "退款",
    "示例商户",
    "/",
    "退款-示例商品",
    "不计收支",
    overrides.amount ?? "1.15",
    "示例银行信用卡(0000)&红包",
    "退款成功",
    `${orderId}-refund`,
    overrides.merchantOrderId ?? `${orderId}-merchant`,
    "/",
    "",
  ];
}

function buildAlipayCsvRows(rows: string[][], ownerName = "老公") {
  return Buffer.from(
    [
      "导出信息：",
      `姓名：${ownerName}`,
      "------------------------支付宝支付科技有限公司  电子客户回单------------------------",
      alipayHeaders.join(","),
      ...rows.map((row) => row.join(",")),
    ].join("\n"),
    "utf8",
  );
}

function buildAlipayCsv(ownerName = "老公", orderId = "alipay-draft-order") {
  return buildAlipayCsvRows([alipayExpenseRow(orderId)], ownerName);
}

function buildAlipayRefundCsv(input: {
  ownerName?: string;
  orderId: string;
  paymentAmount?: string;
  refundAmounts: string[];
}) {
  const merchantOrderId = `${input.orderId}-merchant`;

  return buildAlipayCsvRows(
    [
      alipayExpenseRow(input.orderId, {
        amount: input.paymentAmount,
        merchantOrderId,
      }),
      ...input.refundAmounts.map((amount, index) =>
        alipayRefundRow(`${input.orderId}-${index + 1}`, { amount, merchantOrderId }),
      ),
    ],
    input.ownerName,
  );
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
  const ledger = await db.ledger.create({
    data: { householdId: household.id, name: "Default", isDefault: true },
  });

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
    ledger,
    husbandMember,
    wifeMember,
    sessionUser: {
      householdId: household.id,
      ledgerId: ledger.id,
      memberId: husbandMember.id,
    } satisfies SessionUser,
  };
}

async function createOutsideSessionUser() {
  const fixture = await createHouseholdFixture();

  return {
    householdId: fixture.household.id,
    ledgerId: fixture.ledger.id,
    memberId: fixture.husbandMember.id,
  } satisfies SessionUser;
}

async function saveDefaultMappings(draftId: string, sessionUser: SessionUser) {
  const { expenseCategory, incomeCategory } = await getSeededCategories();
  const householdMembers = await db.householdMember.findMany({
    where: { householdId: sessionUser.householdId },
    select: { id: true, memberName: true },
  });
  const memberIdByName = new Map(
    householdMembers.map((member) => [member.memberName, member.id]),
  );
  const draftMappingKeys = new Set((await services.getImportDraftSummary(draftId, sessionUser))
    .rows.map((row) => row.mappingKey));

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
    ].filter((mapping) => draftMappingKeys.has(mapping.mappingKey)),
    sessionUser,
  );
  await services.saveImportDraftMemberMappings(
    draftId,
    [
      { externalName: "老婆", memberId: memberIdByName.get("老婆") ?? sessionUser.memberId },
      { externalName: "老公", memberId: memberIdByName.get("老公") ?? sessionUser.memberId },
    ],
    sessionUser,
  );

  return { expenseCategory, incomeCategory };
}

async function saveOwnerMemberMapping(
  draftId: string,
  sessionUser: SessionUser,
  externalName = "老公",
  memberId = sessionUser.memberId,
) {
  await services.saveImportDraftMemberMappings(
    draftId,
    [{ externalName, memberId }],
    sessionUser,
  );
}

async function saveAlipayMappingAndOwner(
  draftId: string,
  sessionUser: SessionUser,
  categoryId: string,
) {
  await services.saveImportDraftMappings(
    draftId,
    [
      {
        categoryId,
        mappingKey: "alipay|EXPENSE|餐饮美食|",
      },
    ],
    sessionUser,
  );
  await saveOwnerMemberMapping(draftId, sessionUser);
}

async function saveWechatRefundMappingAndOwner(
  draftId: string,
  sessionUser: SessionUser,
  categoryId: string,
  includeOrdinaryExpense = false,
) {
  await services.saveImportDraftMappings(
    draftId,
    [
      {
        categoryId,
        mappingKey: "wechat_pay|EXPENSE|商户消费|示例服务有限公司",
      },
      ...(includeOrdinaryExpense
        ? [
            {
              categoryId,
              mappingKey: "wechat_pay|EXPENSE|餐饮|普通商户",
            },
          ]
        : []),
    ],
    sessionUser,
  );
  await saveOwnerMemberMapping(draftId, sessionUser);
}

async function installImportDraftTestTrigger(mode: "conflict" | "sleep" | "expire" | "wait" | "wait-expire") {
  const triggerBehavior =
    mode === "wait" || mode === "wait-expire"
      ? `PERFORM pg_advisory_xact_lock(hashtextextended('billboard-import-confirm-wait-test', 0));
         ${mode === "wait-expire" ? `UPDATE "ResourceLease" SET expires_at = clock_timestamp() - INTERVAL '1 second'
         WHERE household_id = NEW.household_id AND kind = 'import';` : ""}`
      : mode === "expire"
      ? `UPDATE "ResourceLease" SET expires_at = clock_timestamp() - INTERVAL '1 second'
         WHERE household_id = NEW.household_id AND kind = 'import';`
      : mode === "sleep"
      ? `
      IF NEW.source = 'sui_shou_ji'
      THEN
        PERFORM pg_sleep(0.5);
      END IF;
`
      : `
      IF pg_trigger_depth() = 1
        AND NEW.source = 'sui_shou_ji'
      THEN
        INSERT INTO "Transaction" (
          "id",
          "household_id",
          "ledger_id",
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
          NEW."ledger_id",
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
`;

  await db.$executeRawUnsafe(`
    CREATE OR REPLACE FUNCTION import_draft_test_before_insert()
    RETURNS trigger AS $$
    BEGIN
${triggerBehavior}

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
  it("rolls back late transaction inserts when the import lease expires before commit", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "expired-import.xlsx", sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);
    await installImportDraftTestTrigger("expire");
    try {
      await expect(services.confirmImportDraft(draft.id, sessionUser)).rejects.toMatchObject({ code: "EXPIRED" });
      expect(await db.transaction.count({ where: { householdId: sessionUser.householdId } })).toBe(0);
      expect(await db.importDraft.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ status: "PENDING", completedAt: null });
      expect(await db.ledgerAuditLog.count({ where: { householdId: sessionUser.householdId } })).toBe(0);
      expect(await db.resourceLease.count({ where: { householdId: sessionUser.householdId } })).toBe(0);
    } finally { await uninstallImportDraftTestTrigger(); }
  });

  it("records one atomic confirmation audit for the acting member and none for retries or failed drafts", async () => {
    const { ledger, sessionUser, wifeMember } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "audited-import.xlsx", sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);
    const actingSession = { ...sessionUser, memberId: wifeMember.id };

    expect(await services.confirmImportDraft(draft.id, actingSession)).toMatchObject({ completedNow: true, createdCount: 1 });
    const charged = await db.resourceWindow.findMany({ orderBy: { key: "asc" } });
    expect(await services.confirmImportDraft(draft.id, actingSession)).toMatchObject({ completedNow: false, createdCount: 1 });
    expect(await db.resourceWindow.findMany({ orderBy: { key: "asc" } })).toEqual(charged);
    const audit = await db.ledgerAuditLog.findMany({ where: { householdId: sessionUser.householdId } });
    expect(audit).toEqual([expect.objectContaining({
      ledgerId: ledger.id, memberId: wifeMember.id, action: "IMPORT_CONFIRMED", targetId: draft.id,
    })]);
    expect(Object.keys(audit[0]!).sort()).toEqual([
      "action", "createdAt", "householdId", "id", "ledgerId", "memberId", "targetId",
    ]);
    const failed = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({ rawPrimaryCategory: "未映射分类", rawAmount: "18" }),
      fileName: "failed-audit.xlsx", sessionUser,
    });
    await expect(services.confirmImportDraft(failed.id, sessionUser)).rejects.toThrow("Import draft has unresolved category mappings");
    expect(await db.ledgerAuditLog.count({ where: { householdId: sessionUser.householdId } })).toBe(1);
    expect(await db.importDraft.findUniqueOrThrow({ where: { id: failed.id } }))
      .toMatchObject({ status: ImportDraftStatus.PENDING });
  });

  it("rolls back imported transactions and draft completion if the required audit cannot be stored", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "atomic-audit-failure.xlsx", sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);
    const fixtureKey = crypto.randomUUID().replaceAll("-", "");
    const triggerName = `import_audit_failure_${fixtureKey}`;
    const functionName = `${triggerName}_fn`;
    const draftLiteral = draft.id.replaceAll("'", "''");
    await db.$executeRawUnsafe(`
      CREATE FUNCTION "${functionName}"() RETURNS trigger AS $$
      BEGIN
        RAISE EXCEPTION 'Simulated import audit storage failure';
      END;
      $$ LANGUAGE plpgsql;
    `);
    try {
      await db.$executeRawUnsafe(`
        CREATE TRIGGER "${triggerName}" BEFORE INSERT ON "LedgerAuditLog"
        FOR EACH ROW WHEN (NEW."target_id" = '${draftLiteral}')
        EXECUTE FUNCTION "${functionName}"();
      `);
      await expect(services.confirmImportDraft(draft.id, sessionUser))
        .rejects.toThrow("Simulated import audit storage failure");
    } finally {
      await db.$executeRawUnsafe(`DROP TRIGGER IF EXISTS "${triggerName}" ON "LedgerAuditLog"`);
      await db.$executeRawUnsafe(`DROP FUNCTION IF EXISTS "${functionName}"()`);
    }

    expect(await db.transaction.count({ where: { householdId: sessionUser.householdId } })).toBe(0);
    expect(await db.ledgerAuditLog.count({ where: { householdId: sessionUser.householdId } })).toBe(0);
    expect(await db.importDraft.findUniqueOrThrow({ where: { id: draft.id } }))
      .toMatchObject({ status: ImportDraftStatus.PENDING, completedAt: null });
    expect(await services.confirmImportDraft(draft.id, sessionUser)).toMatchObject({ completedNow: true, createdCount: 1 });
    expect(await db.ledgerAuditLog.count({ where: { householdId: sessionUser.householdId } })).toBe(1);
  });

  it.each(["inactive", "wrong-type"])("requires fresh mapping when the saved category target becomes %s", async (kind) => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const category = await db.category.create({ data: {
      name: `Import stale category ${crypto.randomUUID()}`, type: CategoryType.EXPENSE, sortOrder: 999,
    } });
    createdCategoryIds.push(category.id);
    const completed = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "completed-category.xlsx", sessionUser,
    });
    await services.saveImportDraftMemberMappings(completed.id,
      [{ externalName: "老婆", memberId: wifeMember.id }], sessionUser);
    await services.saveImportDraftMappings(completed.id,
      [{ categoryId: category.id, mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐" }], sessionUser);
    await services.confirmImportDraft(completed.id, sessionUser);
    const pending = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({ rawAmount: "18" }), fileName: "pending-category.xlsx", sessionUser,
    });
    const directCorrection = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({ rawAmount: "20" }), fileName: "direct-category-correction.xlsx", sessionUser,
    });
    await db.category.update({ where: { id: category.id }, data: kind === "inactive" ? { isActive: false } : { type: CategoryType.INCOME } });
    const next = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({ rawAmount: "19" }), fileName: "stale-category-reuse.xlsx", sessionUser,
    });

    expect(await services.getImportDraftSummary(next.id, sessionUser)).toMatchObject({ counts: { needsMapping: 1 } });
    expect(await services.getImportDraftSummary(pending.id, sessionUser)).toMatchObject({ counts: { needsMapping: 1 } });
    expect(await services.confirmImportDraft(pending.id, sessionUser)).toMatchObject({
      completedNow: false, createdCount: 0, requiresReview: true, needsMappingCount: 1,
    });
    expect(await db.importDraftRow.findFirstOrThrow({ where: { draftId: pending.id } })).toMatchObject({
      categoryId: null, status: ImportDraftRowStatus.NEEDS_MAPPING,
    });
    expect(await db.transaction.count({ where: { householdId: sessionUser.householdId } })).toBe(1);
    expect(await db.ledgerAuditLog.count({ where: { householdId: sessionUser.householdId } })).toBe(1);
    expect(await services.getImportDraftSummary(completed.id, sessionUser)).toMatchObject({
      rows: [expect.objectContaining({ categoryId: category.id, status: ImportDraftRowStatus.READY })],
    });
    expect(await services.confirmImportDraft(completed.id, sessionUser)).toMatchObject({ completedNow: false, createdCount: 1 });
    expect(await services.getImportDraftSummary(directCorrection.id, sessionUser)).toMatchObject({ counts: { needsMapping: 1 } });
    const { expenseCategory } = await getSeededCategories();
    await services.saveImportDraftMappings(directCorrection.id,
      [{ categoryId: expenseCategory.id, mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐" }], sessionUser);
    expect(await services.getImportDraftSummary(directCorrection.id, sessionUser)).toMatchObject({ counts: { needsMapping: 0, importable: 1 } });
    expect(await services.confirmImportDraft(directCorrection.id, sessionUser)).toMatchObject({ createdCount: 1 });
  });

  it("requires explicit context for a new import upload", async () => {
    const { sessionUser } = await createHouseholdFixture();
    await expect(services.createSuiShouJiImportDraft({ buffer: await buildExpenseWorkbook(), fileName: "old-page.xlsx", sessionUser }))
      .rejects.toThrow("Entry context is required; refresh and select a ledger");
    expect(await db.importDraft.count({ where: { householdId: sessionUser.householdId } })).toBe(0);
  });

  it("pins an explicitly selected non-default upload target through confirmation", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const alternate = await db.ledger.create({ data: { householdId: sessionUser.householdId, name: "Explicit target" } });
    const context = { ...sessionUser, ledgerId: alternate.id };
    const draft = await services.createSuiShouJiImportDraft({ buffer: await buildExpenseWorkbook(), fileName: "explicit-target.xlsx", sessionUser, context });
    await saveDefaultMappings(draft.id, sessionUser);
    expect(await services.getImportDraftSummary(draft.id, sessionUser)).toMatchObject({ ledgerId: alternate.id });
    await services.confirmImportDraft(draft.id, sessionUser);
    expect(await db.transaction.findFirstOrThrow({ where: { householdId: sessionUser.householdId } })).toMatchObject({ ledgerId: alternate.id });
  });

  it("keeps the draft target fixed when the default ledger changes and deduplicates across the household", async () => {
    const { ledger, sessionUser } = await createHouseholdFixture();
    const buffer = await buildExpenseWorkbook();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser, buffer, fileName: "fixed-ledger.xlsx", sessionUser });
    await saveDefaultMappings(draft.id, sessionUser);
    await db.ledger.update({ where: { id: ledger.id }, data: { isDefault: false } });
    const nextLedger = await db.ledger.create({ data: {
      householdId: sessionUser.householdId, name: "Next ledger", isDefault: true,
    } });

    expect(await services.getImportDraftSummary(draft.id, sessionUser)).toMatchObject({
      ledgerId: ledger.id, ledgerName: "Default", blockedReason: null,
    });
    expect(await services.confirmImportDraft(draft.id, sessionUser)).toMatchObject({ createdCount: 1 });
    const imported = await db.transaction.findFirstOrThrow({ where: { householdId: sessionUser.householdId } });
    expect(imported.ledgerId).toBe(ledger.id);
    await db.transaction.update({ where: { id: imported.id }, data: { ledgerId: nextLedger.id, deletedAt: new Date() } });
    const duplicate = await services.createSuiShouJiImportDraft({ context: { ...sessionUser, ledgerId: nextLedger.id }, buffer, fileName: "second-ledger.xlsx", sessionUser });

    expect(await services.getImportDraftSummary(duplicate.id, sessionUser)).toMatchObject({
      ledgerId: nextLedger.id, counts: { sourceDuplicate: 1, importable: 0 },
    });
    expect(await services.confirmImportDraft(duplicate.id, sessionUser)).toMatchObject({ createdCount: 0 });
    expect(await db.transaction.count({ where: { householdId: sessionUser.householdId } })).toBe(1);
    expect(await services.confirmImportDraft(draft.id, sessionUser)).toMatchObject({ completedNow: false, createdCount: 1 });
  });

  it("keeps completed draft history but blocks pending tasks after their creator leaves and rejoins", async () => {
    const { husbandMember, wifeMember, sessionUser } = await createHouseholdFixture();
    const first = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "completed-history.xlsx", sessionUser,
    });
    await saveDefaultMappings(first.id, sessionUser);
    await services.confirmImportDraft(first.id, sessionUser);
    const pending = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({ rawAmount: "18" }), fileName: "original-task.xlsx", sessionUser,
    });
    await db.householdMember.update({ where: { id: husbandMember.id }, data: { leftAt: new Date(), role: HouseholdRole.MEMBER } });
    await db.householdMember.update({ where: { id: wifeMember.id }, data: { role: HouseholdRole.OWNER } });
    const rejoined = await db.householdMember.create({ data: {
      householdId: sessionUser.householdId, memberName: husbandMember.memberName,
      userId: husbandMember.userId, role: HouseholdRole.MEMBER,
    } });
    const rejoinedSession = { ...sessionUser, memberId: rejoined.id };
    const otherMemberSession = { ...sessionUser, memberId: wifeMember.id };

    await expect(services.getImportDraftSummary(pending.id, sessionUser)).rejects.toThrow("Unauthorized");
    expect(await services.getImportDraftSummary(pending.id, rejoinedSession)).toMatchObject({
      status: ImportDraftStatus.PENDING, blockedReason: "INACTIVE_CREATOR",
    });
    await expect(services.confirmImportDraft(pending.id, rejoinedSession))
      .rejects.toThrow("Import draft creator is no longer active");
    await expect(services.saveImportDraftMemberMappings(pending.id,
      [{ externalName: "老婆", memberId: wifeMember.id }], otherMemberSession))
      .rejects.toThrow("Import draft creator is no longer active");
    expect(await services.getImportDraftSummary(first.id, otherMemberSession)).toMatchObject({
      status: ImportDraftStatus.COMPLETED, blockedReason: null,
    });
    expect(await services.confirmImportDraft(first.id, otherMemberSession))
      .toMatchObject({ completedNow: false, createdCount: 1 });
    expect(await db.transaction.count({ where: { householdId: sessionUser.householdId } })).toBe(1);
  });

  it("requires explicit remapping when a saved payment attribution becomes inactive", async () => {
    const { wifeMember, sessionUser } = await createHouseholdFixture();
    const draft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatPayWorkbook(), fileName: "inactive-attribution.xlsx", sessionUser,
    });
    const summary = await services.getImportDraftSummary(draft.id, sessionUser);
    const { expenseCategory } = await getSeededCategories();
    await services.saveImportDraftMappings(draft.id, summary.missingMappings.map(({ mappingKey }) => ({
      mappingKey, categoryId: expenseCategory.id,
    })), sessionUser);
    await services.savePaymentImportDraftOwnerMember(draft.id, wifeMember.id, sessionUser);
    await db.householdMember.update({ where: { id: wifeMember.id }, data: { leftAt: new Date() } });

    expect(await services.getImportDraftSummary(draft.id, sessionUser)).toMatchObject({
      hasUnresolvedMemberMappings: true,
    });
    await expect(services.confirmImportDraft(draft.id, sessionUser))
      .rejects.toThrow("Import draft has unresolved member mappings");
    expect(await db.transaction.count({ where: { householdId: sessionUser.householdId } })).toBe(0);
    await services.savePaymentImportDraftOwnerMember(draft.id, sessionUser.memberId, sessionUser);
    expect(await services.confirmImportDraft(draft.id, sessionUser)).toMatchObject({ createdCount: 1 });
    expect(await db.transaction.findFirstOrThrow({ where: { householdId: sessionUser.householdId } }))
      .toMatchObject({ actorMemberId: sessionUser.memberId, createdByMemberId: sessionUser.memberId });
  });

  it("blocks an archived draft target without moving it to the new default ledger", async () => {
    const { ledger, sessionUser } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "archived-target.xlsx", sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);
    await db.ledger.update({ where: { id: ledger.id }, data: { isDefault: false, archivedAt: new Date() } });
    await db.ledger.create({ data: { householdId: sessionUser.householdId, name: "Next ledger", isDefault: true } });

    expect(await services.getImportDraftSummary(draft.id, sessionUser)).toMatchObject({
      ledgerId: ledger.id, status: ImportDraftStatus.PENDING, blockedReason: "ARCHIVED_LEDGER",
    });
    await expect(services.confirmImportDraft(draft.id, sessionUser)).rejects.toThrow("Ledger is unavailable");
    expect(await db.transaction.count({ where: { householdId: sessionUser.householdId } })).toBe(0);
    expect(await db.importDraft.findUniqueOrThrow({ where: { id: draft.id } })).toMatchObject({ ledgerId: ledger.id });
  });

  it("rechecks authorization after waiting for a concurrent membership change", async () => {
    const { husbandMember, wifeMember, sessionUser } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "concurrent-membership.xlsx", sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);
    let confirmation: Promise<{ error: unknown } | { result: unknown }> | undefined;

    await db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT id FROM "Household" WHERE id = ${sessionUser.householdId} FOR UPDATE`;
      const [holder] = await tx.$queryRaw<Array<{ pid: number }>>`SELECT pg_backend_pid() AS pid`;
      confirmation = services.confirmImportDraft(draft.id, sessionUser).then(
        (result) => ({ result }), (error: unknown) => ({ error }),
      );
      let waiting = false;
      const deadline = Date.now() + 5_000;
      while (!waiting && Date.now() < deadline) {
        const [row] = await tx.$queryRaw<Array<{ waiting: boolean }>>`
          SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity
            WHERE datname = current_database() AND ${holder!.pid} = ANY(pg_blocking_pids(pid))
          ) AS waiting
        `;
        waiting = row!.waiting;
        if (!waiting) await new Promise((resolve) => setTimeout(resolve, 10));
      }
      expect(waiting).toBe(true);
      await tx.householdMember.update({ where: { id: husbandMember.id }, data: { leftAt: new Date(), role: HouseholdRole.MEMBER } });
      await tx.householdMember.update({ where: { id: wifeMember.id }, data: { role: HouseholdRole.OWNER } });
    }, { timeout: 15_000 });

    expect(await confirmation).toEqual({ error: expect.objectContaining({ message: "Unauthorized" }) });
    expect(await db.transaction.count({ where: { householdId: sessionUser.householdId } })).toBe(0);
    expect(await db.importDraft.findUniqueOrThrow({ where: { id: draft.id } }))
      .toMatchObject({ status: ImportDraftStatus.PENDING });
  });

  it("rejects draft access and confirmation when the original account becomes unavailable", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "unavailable-account.xlsx", sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);
    await db.user.update({ where: { id: husbandMember.userId }, data: { status: "LOCKED" } });

    await expect(services.getImportDraftSummary(draft.id, sessionUser)).rejects.toThrow("Unauthorized");
    await expect(services.confirmImportDraft(draft.id, sessionUser)).rejects.toThrow("Unauthorized");
    expect(await db.transaction.count({ where: { householdId: sessionUser.householdId } })).toBe(0);
    expect(await db.importDraft.findUniqueOrThrow({ where: { id: draft.id } }))
      .toMatchObject({ status: ImportDraftStatus.PENDING });
  });

  it("creates Sui Shou Ji draft rows with unresolved external member names", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({
        rawCreatedBy: "随手记老婆",
        rawMember: "随手记老婆",
      }),
      fileName: "member-mapping-unresolved.xlsx",
      sessionUser,
    });

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.memberMappings).toMatchObject([
      {
        count: 2,
        externalName: "随手记老婆",
        fallbackApplied: true,
        memberId: sessionUser.memberId,
      },
    ]);
    expect(summary.rows[0]).toMatchObject({
      actorExternalName: "随手记老婆",
      actorFallbackApplied: true,
      actorMemberId: sessionUser.memberId,
      creatorExternalName: "随手记老婆",
      createdByMemberId: sessionUser.memberId,
      creatorFallbackApplied: true,
    });
  });

  it("reuses saved member mappings when creating Sui Shou Ji drafts", async () => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    await db.importMemberMapping.create({
      data: {
        externalName: "随手记老婆",
        householdId: sessionUser.householdId,
        memberId: wifeMember.id,
        source: "sui_shou_ji",
      },
    });

    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({
        rawCreatedBy: "随手记老婆",
        rawMember: "随手记老婆",
      }),
      fileName: "member-mapping-reused.xlsx",
      sessionUser,
    });

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.memberMappings).toMatchObject([
      {
        count: 2,
        externalName: "随手记老婆",
        fallbackApplied: false,
        memberId: wifeMember.id,
      },
    ]);
    expect(summary.rows[0]).toMatchObject({
      actorExternalName: "随手记老婆",
      actorFallbackApplied: false,
      actorMemberId: wifeMember.id,
      creatorExternalName: "随手记老婆",
      createdByMemberId: wifeMember.id,
      creatorFallbackApplied: false,
    });
  });

  it("rejects cross-household saved member mappings at the database boundary", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const outsideSessionUser = await createOutsideSessionUser();
    await expect(db.importMemberMapping.create({
      data: {
        externalName: "随手记老婆",
        householdId: sessionUser.householdId,
        memberId: outsideSessionUser.memberId,
        source: SUI_SHOU_JI_SOURCE,
      },
    })).rejects.toMatchObject({ code: "P2003" });

    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({
        rawCreatedBy: "随手记老婆",
        rawMember: "随手记老婆",
      }),
      fileName: "member-mapping-cross-household.xlsx",
      sessionUser,
    });

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.hasUnresolvedMemberMappings).toBe(true);
    expect(summary.rows[0]).toMatchObject({
      actorFallbackApplied: true,
      actorMemberId: sessionUser.memberId,
      createdByMemberId: sessionUser.memberId,
      creatorFallbackApplied: true,
    });
  });

  it("rejects confirmation when importable rows still have unresolved external member mappings", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({
        rawCreatedBy: "随手记老婆",
        rawMember: "随手记老婆",
      }),
      fileName: "unresolved-member-confirm.xlsx",
      sessionUser,
    });

    await services.saveImportDraftMappings(
      draft.id,
      [{ categoryId: expenseCategory.id, mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐" }],
      sessionUser,
    );

    await expect(services.confirmImportDraft(draft.id, sessionUser)).rejects.toThrow(
      "Import draft has unresolved member mappings",
    );
  });

  it("saves import member mappings and updates matching draft rows", async () => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({
        rawCreatedBy: "随手记老婆",
        rawMember: "随手记老婆",
      }),
      fileName: "save-member-mapping.xlsx",
      sessionUser,
    });

    await services.saveImportDraftMemberMappings(
      draft.id,
      [{ externalName: "随手记老婆", memberId: wifeMember.id }],
      sessionUser,
    );

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);
    const persistedMapping = await db.importMemberMapping.findFirstOrThrow({
      where: {
        externalName: "随手记老婆",
        householdId: sessionUser.householdId,
        source: "sui_shou_ji",
      },
    });

    expect(persistedMapping.memberId).toBe(wifeMember.id);
    expect(summary.hasUnresolvedMemberMappings).toBe(false);
    expect(summary.rows[0]).toMatchObject({
      actorFallbackApplied: false,
      actorMemberId: wifeMember.id,
      createdByMemberId: wifeMember.id,
      creatorFallbackApplied: false,
    });
  });

  it("waits for concurrent draft completion before saving import member mappings", async () => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({
        rawCreatedBy: "随手记老婆",
        rawMember: "随手记老婆",
      }),
      fileName: "member-mapping-concurrent-completion.xlsx",
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

    const saveMappings = services.saveImportDraftMemberMappings(
      draft.id,
      [{ externalName: "随手记老婆", memberId: wifeMember.id }],
      sessionUser,
    );
    const earlyResult = await Promise.race([
      saveMappings.then(
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
    await expect(saveMappings).rejects.toThrow("Import draft is already completed");
  });

  it("does not allow import member mapping changes after completion", async () => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({
        rawCreatedBy: "随手记老婆",
        rawMember: "随手记老婆",
      }),
      fileName: "member-mapping-completed.xlsx",
      sessionUser,
    });
    await db.importDraft.update({
      where: { id: draft.id },
      data: {
        completedAt: new Date("2026-05-07T12:00:00.000Z"),
        status: ImportDraftStatus.COMPLETED,
      },
    });

    await expect(
      services.saveImportDraftMemberMappings(
        draft.id,
        [{ externalName: "随手记老婆", memberId: wifeMember.id }],
        sessionUser,
      ),
    ).rejects.toThrow("Import draft is already completed");
  });

  it("rejects import member mappings to members from another household", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const outsideSessionUser = await createOutsideSessionUser();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({
        rawCreatedBy: "随手记老婆",
        rawMember: "随手记老婆",
      }),
      fileName: "reject-outside-member-mapping.xlsx",
      sessionUser,
    });

    await expect(
      services.saveImportDraftMemberMappings(
        draft.id,
        [{ externalName: "随手记老婆", memberId: outsideSessionUser.memberId }],
        sessionUser,
      ),
    ).rejects.toThrow("Member not found");
  });

  it("creates a WeChat Pay draft with unresolved owner from the file header", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const draft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatPayWorkbook("老公"),
      fileName: "wechat-pay.xlsx",
      sessionUser,
    });

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.source).toBe(WECHAT_PAY_SOURCE);
    expect(summary.missingMappings).toMatchObject([
      {
        mappingKey: "wechat_pay|EXPENSE|扫二维码付款|示例商户",
        primaryCategory: "扫二维码付款",
        secondaryCategory: "示例商户",
        transactionType: TransactionType.EXPENSE,
      },
    ]);
    expect(summary.hasUnresolvedMemberMappings).toBe(true);
    expect(summary.memberMappings).toMatchObject([
      {
        count: 2,
        externalName: "老公",
        fallbackApplied: true,
        memberId: husbandMember.id,
      },
    ]);
    expect(summary.rows[0]).toMatchObject({
      actorExternalName: "老公",
      actorFallbackApplied: true,
      actorMemberId: husbandMember.id,
      createdByMemberId: husbandMember.id,
      creatorExternalName: "老公",
      creatorFallbackApplied: true,
      rawCreatedBy: null,
      rawMember: null,
      status: ImportDraftRowStatus.NEEDS_MAPPING,
    });
  });

  it("creates net, full, and unmatched WeChat refund draft outcomes", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const partialDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook(),
      fileName: "wechat-partial-refund.xlsx",
      sessionUser,
    });
    const partialSummary = await services.getImportDraftSummary(partialDraft.id, sessionUser);
    const storedPartialRow = await db.importDraftRow.findFirstOrThrow({
      where: { draftId: partialDraft.id },
      select: { rawAmount: true },
    });

    expect(partialSummary.rows).toHaveLength(1);
    expect(partialSummary.rows[0]).toMatchObject({
      amountFen: 81,
      status: ImportDraftRowStatus.NEEDS_MAPPING,
      userDecision: ImportRowDecision.KEEP,
    });
    expect(storedPartialRow.rawAmount).toBe("200");
    expect(Object.hasOwn(partialSummary.rows[0] ?? {}, "rawAmount")).toBe(false);
    expect(Object.hasOwn(partialSummary.rows[0] ?? {}, "sourceFingerprint")).toBe(false);

    const fullDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook({
        includeRefundIncome: false,
        paymentStatus: "已全额退款",
      }),
      fileName: "wechat-full-refund.xlsx",
      sessionUser,
    });
    const fullSummary = await services.getImportDraftSummary(fullDraft.id, sessionUser);
    const fullRow = fullSummary.rows[0]!;

    expect(fullSummary.counts).toMatchObject({ importable: 0, total: 1, userSkipped: 1 });
    expect(fullSummary.hasUnresolvedMemberMappings).toBe(false);
    expect(fullRow).toMatchObject({
      amountFen: 200,
      skipReason: "WECHAT_FULLY_REFUNDED",
      status: ImportDraftRowStatus.USER_SKIPPED,
      userDecision: ImportRowDecision.SKIP,
    });
    await expect(
      services.setImportDraftRowDecision(
        fullDraft.id,
        fullRow.id,
        ImportRowDecision.KEEP,
        sessionUser,
      ),
    ).rejects.toThrow("Import draft row decision cannot be changed");

    const unmatchedDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook({ includePayment: false }),
      fileName: "wechat-unmatched-refund.xlsx",
      sessionUser,
    });
    const unmatchedSummary = await services.getImportDraftSummary(unmatchedDraft.id, sessionUser);
    const unmatchedRow = unmatchedSummary.rows[0]!;

    expect(unmatchedSummary.counts).toMatchObject({ importable: 0, total: 1, userSkipped: 1 });
    expect(unmatchedRow).toMatchObject({
      amountFen: 119,
      skipReason: "WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT",
      status: ImportDraftRowStatus.USER_SKIPPED,
      userDecision: ImportRowDecision.SKIP,
    });
    await expect(
      services.setImportDraftRowDecision(
        unmatchedDraft.id,
        unmatchedRow.id,
        ImportRowDecision.KEEP,
        sessionUser,
      ),
    ).rejects.toThrow("Import draft row decision cannot be changed");
  });

  it("classifies stable WeChat refund history by the current net amount", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const firstDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook(),
      fileName: "wechat-refund-stable-first.xlsx",
      sessionUser,
    });
    const firstRow = await db.importDraftRow.findFirstOrThrow({
      where: { draftId: firstDraft.id },
      select: { sourceFingerprint: true },
    });

    await db.transaction.create({
      data: {
        ledgerId: sessionUser.ledgerId,
        actorMemberId: husbandMember.id,
        amountFen: 81,
        categoryId: expenseCategory.id,
        createdByMemberId: husbandMember.id,
        householdId: sessionUser.householdId,
        occurredAt: new Date("2026-08-21T22:10:21.000Z"),
        source: WECHAT_PAY_SOURCE,
        sourceFingerprint: firstRow.sourceFingerprint,
        sourceImportedAt: new Date(),
        type: TransactionType.EXPENSE,
      },
    });

    const repeatedDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook(),
      fileName: "wechat-refund-stable-repeat.xlsx",
      sessionUser,
    });
    const increasedDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook({ refundAmount: "1.25" }),
      fileName: "wechat-refund-stable-increased.xlsx",
      sessionUser,
    });
    const fullDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook({
        includeRefundIncome: false,
        paymentStatus: "已全额退款",
      }),
      fileName: "wechat-refund-stable-full.xlsx",
      sessionUser,
    });
    const [repeated, increased, full] = await Promise.all([
      services.getImportDraftSummary(repeatedDraft.id, sessionUser),
      services.getImportDraftSummary(increasedDraft.id, sessionUser),
      services.getImportDraftSummary(fullDraft.id, sessionUser),
    ]);

    expect(repeated.rows[0]).toMatchObject({
      skipReason: "Source duplicate",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
    });
    expect(increased.rows[0]).toMatchObject({
      amountFen: 75,
      skipReason: "WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
    });
    expect(full.rows[0]).toMatchObject({
      skipReason: "WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
    });
  });

  it("uses the conservative WeChat legacy amount interval within one household", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const createLegacyTransaction = (amountFen: number, deletedAt: Date | null = null) =>
      db.transaction.create({
        data: {
          ledgerId: sessionUser.ledgerId,
          actorMemberId: husbandMember.id,
          amountFen,
          categoryId: expenseCategory.id,
          createdByMemberId: husbandMember.id,
          deletedAt,
          householdId: sessionUser.householdId,
          occurredAt: new Date("2026-08-21T22:10:21.000Z"),
          source: WECHAT_PAY_SOURCE,
          sourceFingerprint: `legacy-wechat-${amountFen}-${deletedAt ? "deleted" : "active"}`,
          sourceImportedAt: new Date(),
          type: TransactionType.EXPENSE,
        },
      });

    const original = await createLegacyTransaction(200);
    const originalDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook(),
      fileName: "wechat-legacy-original.xlsx",
      sessionUser,
    });
    const originalSummary = await services.getImportDraftSummary(originalDraft.id, sessionUser);

    expect(originalSummary.rows[0]).toMatchObject({
      skipReason: "WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
    });

    await db.transaction.update({ where: { id: original.id }, data: { amountFen: 81 } });
    const adjustedDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook(),
      fileName: "wechat-legacy-adjusted.xlsx",
      sessionUser,
    });
    const adjustedSummary = await services.getImportDraftSummary(adjustedDraft.id, sessionUser);

    expect(adjustedSummary.rows[0]).toMatchObject({
      skipReason: "Source duplicate",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
    });

    await db.transaction.update({ where: { id: original.id }, data: { amountFen: 90 } });
    const increasedRefundDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook({ refundAmount: "1.25" }),
      fileName: "wechat-legacy-increased-refund.xlsx",
      sessionUser,
    });
    const increasedRefundSummary = await services.getImportDraftSummary(
      increasedRefundDraft.id,
      sessionUser,
    );

    expect(increasedRefundSummary.rows[0]).toMatchObject({
      amountFen: 75,
      skipReason: "WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
    });

    await db.transaction.update({
      where: { id: original.id },
      data: { amountFen: 201, deletedAt: new Date() },
    });
    const outsideFixture = await createHouseholdFixture();
    await db.transaction.create({
      data: {
        ledgerId: outsideFixture.sessionUser.ledgerId,
        actorMemberId: outsideFixture.husbandMember.id,
        amountFen: 200,
        categoryId: expenseCategory.id,
        createdByMemberId: outsideFixture.husbandMember.id,
        householdId: outsideFixture.sessionUser.householdId,
        occurredAt: new Date("2026-08-21T22:10:21.000Z"),
        source: WECHAT_PAY_SOURCE,
        sourceFingerprint: "legacy-wechat-other-household",
        sourceImportedAt: new Date(),
        type: TransactionType.EXPENSE,
      },
    });
    const outsideIntervalDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook(),
      fileName: "wechat-legacy-outside.xlsx",
      sessionUser,
    });
    const outsideIntervalSummary = await services.getImportDraftSummary(
      outsideIntervalDraft.id,
      sessionUser,
    );

    expect(outsideIntervalSummary.rows[0]).toMatchObject({
      amountFen: 81,
      status: ImportDraftRowStatus.NEEDS_MAPPING,
      userDecision: ImportRowDecision.KEEP,
    });

    await createLegacyTransaction(150, new Date());
    const softDeletedDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook(),
      fileName: "wechat-legacy-soft-deleted.xlsx",
      sessionUser,
    });
    const softDeletedSummary = await services.getImportDraftSummary(softDeletedDraft.id, sessionUser);

    expect(softDeletedSummary.rows[0]).toMatchObject({
      skipReason: "WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
    });

    await createLegacyTransaction(160);
    const multipleDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook(),
      fileName: "wechat-legacy-multiple.xlsx",
      sessionUser,
    });
    const multipleSummary = await services.getImportDraftSummary(multipleDraft.id, sessionUser);

    expect(multipleSummary.rows[0]).toMatchObject({
      skipReason: "WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
    });
  });

  it("keeps a partial WeChat refund draft pending when stable history appears before confirmation", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook({ includeOrdinaryExpense: true }),
      fileName: "wechat-refund-confirm-stable-race.xlsx",
      sessionUser,
    });

    await saveWechatRefundMappingAndOwner(draft.id, sessionUser, expenseCategory.id, true);
    const row = await db.importDraftRow.findFirstOrThrow({
      where: { draftId: draft.id, rawAmount: "200" },
      select: { sourceFingerprint: true },
    });
    await db.transaction.create({
      data: {
        ledgerId: sessionUser.ledgerId,
        actorMemberId: husbandMember.id,
        amountFen: 81,
        categoryId: expenseCategory.id,
        createdByMemberId: husbandMember.id,
        householdId: sessionUser.householdId,
        occurredAt: new Date("2026-08-21T22:10:21.000Z"),
        source: WECHAT_PAY_SOURCE,
        sourceFingerprint: row.sourceFingerprint,
        sourceImportedAt: new Date(),
        type: TransactionType.EXPENSE,
      },
    });

    const result = await services.confirmImportDraft(draft.id, sessionUser);
    const [summary, transactionCount] = await Promise.all([
      services.getImportDraftSummary(draft.id, sessionUser),
      db.transaction.count({
        where: { householdId: sessionUser.householdId, source: WECHAT_PAY_SOURCE },
      }),
    ]);

    expect(result).toMatchObject({
      completedNow: false,
      createdCount: 0,
      requiresReview: true,
      sourceDuplicateCount: 1,
    });
    expect(summary.status).toBe(ImportDraftStatus.PENDING);
    expect(summary.rows[0]).toMatchObject({
      skipReason: "Source duplicate",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
      userDecision: ImportRowDecision.SKIP,
    });
    expect(transactionCount).toBe(1);

    const reviewedResult = await services.confirmImportDraft(draft.id, sessionUser);
    const reviewedSummary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(reviewedResult).toMatchObject({ completedNow: true, requiresReview: false });
    expect(reviewedSummary.status).toBe(ImportDraftStatus.COMPLETED);
    expect(reviewedResult.createdCount).toBe(1);
    expect(
      await db.transaction.count({
        where: { householdId: sessionUser.householdId, source: WECHAT_PAY_SOURCE },
      }),
    ).toBe(2);
  });

  it("keeps a partial WeChat refund draft pending when legacy history appears before confirmation", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatRefundWorkbook(),
      fileName: "wechat-refund-confirm-legacy-race.xlsx",
      sessionUser,
    });

    await saveWechatRefundMappingAndOwner(draft.id, sessionUser, expenseCategory.id);
    await db.transaction.create({
      data: {
        ledgerId: sessionUser.ledgerId,
        actorMemberId: husbandMember.id,
        amountFen: 200,
        categoryId: expenseCategory.id,
        createdByMemberId: husbandMember.id,
        householdId: sessionUser.householdId,
        occurredAt: new Date("2026-08-21T22:10:21.000Z"),
        source: WECHAT_PAY_SOURCE,
        sourceFingerprint: "wechat-legacy-confirm-race",
        sourceImportedAt: new Date(),
        type: TransactionType.EXPENSE,
      },
    });

    const result = await services.confirmImportDraft(draft.id, sessionUser);
    const summary = await services.getImportDraftSummary(draft.id, sessionUser);
    const transactionCount = await db.transaction.count({
      where: { householdId: sessionUser.householdId, source: WECHAT_PAY_SOURCE },
    });

    expect(result).toMatchObject({
      completedNow: false,
      createdCount: 0,
      requiresReview: true,
      sourceDuplicateCount: 1,
    });
    expect(summary.status).toBe(ImportDraftStatus.PENDING);
    expect(summary.rows[0]).toMatchObject({
      skipReason: "WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
      userDecision: ImportRowDecision.SKIP,
    });
    expect(transactionCount).toBe(1);
  });

  it("creates an Alipay draft with unresolved owner from the file header", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const draft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: buildAlipayCsv("老公"),
      fileName: "alipay.csv",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.source).toBe(ALIPAY_SOURCE);
    expect(summary.counts.total).toBe(1);
    expect(summary.hasUnresolvedMemberMappings).toBe(true);
    expect(summary.memberMappings).toMatchObject([
      {
        count: 2,
        externalName: "老公",
        fallbackApplied: true,
        memberId: husbandMember.id,
      },
    ]);
    expect(summary.rows[0]).toMatchObject({
      actorExternalName: "老公",
      actorFallbackApplied: true,
      actorMemberId: husbandMember.id,
      amountFen: 2285,
      createdByMemberId: husbandMember.id,
      creatorExternalName: "老公",
      creatorFallbackApplied: true,
      mappingKey: "alipay|EXPENSE|餐饮美食|",
      primaryCategory: "餐饮美食",
      secondaryCategory: "示例商户",
      status: ImportDraftRowStatus.NEEDS_MAPPING,
      transactionType: TransactionType.EXPENSE,
    });
    expect(summary.missingMappings).toMatchObject([
      {
        count: 1,
        mappingKey: "alipay|EXPENSE|餐饮美食|",
        primaryCategory: "餐饮美食",
        secondaryCategory: null,
        transactionType: TransactionType.EXPENSE,
      },
    ]);
  });

  it("stores sanitized import draft metadata instead of raw bill fields", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({
        rawAccount: "示例账户",
        rawCreatedBy: "老婆",
        rawMember: "老婆",
        rawMerchant: "示例商户",
        rawNote: "示例备注",
      }),
      fileName: "private-household-ledger.xlsx",
      sessionUser,
    });

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.fileName).toBe("sui_shou_ji.xlsx");
    expect(summary.rows[0]).toMatchObject({
      note: null,
      rawCreatedBy: null,
      rawMember: null,
    });
    for (const field of ["rawAmount", "rawCurrency", "rawDate", "rawTransactionType"]) {
      expect(Object.hasOwn(summary.rows[0] ?? {}, field)).toBe(false);
    }
  });

  it("updates payment draft owner member for Alipay rows before confirmation", async () => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const draft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: buildAlipayCsv("老公"),
      fileName: "alipay-owner.csv",
      sessionUser,
    });

    await services.savePaymentImportDraftOwnerMember(draft.id, wifeMember.id, sessionUser);
    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.rows[0]).toMatchObject({
      actorFallbackApplied: false,
      actorMemberId: wifeMember.id,
      createdByMemberId: wifeMember.id,
      creatorFallbackApplied: false,
    });
  });

  it("keeps ownerless payment drafts editable through the one-time owner member action", async () => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const draft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: buildAlipayCsv("", "alipay-ownerless-order"),
      fileName: "alipay-ownerless.csv",
      sessionUser,
    });

    const before = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(before.memberMappings).toEqual([]);
    expect(before.hasUnresolvedMemberMappings).toBe(false);

    await services.savePaymentImportDraftOwnerMember(draft.id, wifeMember.id, sessionUser);
    const after = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(after.rows[0]).toMatchObject({
      actorMemberId: wifeMember.id,
      createdByMemberId: wifeMember.id,
    });
  });

  it("confirms mapped Alipay rows into transactions with source metadata", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: buildAlipayCsv("老公", "alipay-confirm-order"),
      fileName: "alipay-confirm.csv",
      sessionUser,
    });

    await services.saveImportDraftMappings(
      draft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "alipay|EXPENSE|餐饮美食|",
        },
      ],
      sessionUser,
    );
    await saveOwnerMemberMapping(draft.id, sessionUser, "老公", husbandMember.id);

    const result = await services.confirmImportDraft(draft.id, sessionUser);

    expect(result).toMatchObject({
      completedNow: true,
      createdCount: 1,
      source: ALIPAY_SOURCE,
      sourceDuplicateCount: 0,
      userSkippedCount: 0,
    });

    const transaction = await db.transaction.findFirstOrThrow({
      where: {
        householdId: sessionUser.householdId,
        source: ALIPAY_SOURCE,
      },
    });

    expect(transaction).toMatchObject({
      actorMemberId: husbandMember.id,
      amountFen: 2285,
      categoryId: expenseCategory.id,
      createdByMemberId: husbandMember.id,
      note: "交易对方：示例商户；商品：示例商品",
      source: ALIPAY_SOURCE,
      sourceFingerprint: expect.any(String),
      sourceImportedAt: expect.any(Date),
      type: TransactionType.EXPENSE,
    });
    expect(transaction.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("reuses household Alipay category mappings on the next draft", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const firstDraft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: buildAlipayCsv("老公", "alipay-reuse-first"),
      fileName: "alipay-first.csv",
      sessionUser,
    });

    await services.saveImportDraftMappings(
      firstDraft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "alipay|EXPENSE|餐饮美食|",
        },
      ],
      sessionUser,
    );

    const secondDraft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: buildAlipayCsv("老公", "alipay-reuse-second"),
      fileName: "alipay-second.csv",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(secondDraft.id, sessionUser);

    expect(summary.counts.needsMapping).toBe(0);
    expect(summary.rows[0]).toMatchObject({
      categoryId: expenseCategory.id,
      status: ImportDraftRowStatus.READY,
    });
  });

  it("marks repeated Alipay source fingerprints as source duplicates", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const firstDraft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: buildAlipayCsv("老公", "alipay-duplicate-order"),
      fileName: "alipay-first-duplicate.csv",
      sessionUser,
    });
    await services.saveImportDraftMappings(
      firstDraft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "alipay|EXPENSE|餐饮美食|",
        },
      ],
      sessionUser,
    );
    await saveOwnerMemberMapping(firstDraft.id, sessionUser);
    await services.confirmImportDraft(firstDraft.id, sessionUser);

    const secondDraft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: buildAlipayCsv("老公", "alipay-duplicate-order"),
      fileName: "alipay-second-duplicate.csv",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(secondDraft.id, sessionUser);

    expect(summary.counts.sourceDuplicate).toBe(1);
    expect(summary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
      userDecision: ImportRowDecision.SKIP,
    });
  });

  it("confirms a first partial Alipay refund as one net expense", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: buildAlipayRefundCsv({
        orderId: "alipay-partial-first",
        paymentAmount: "1.80",
        refundAmounts: ["1.15"],
      }),
      fileName: "alipay-partial-first.csv",
      sessionUser,
    });
    const initial = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(initial.counts).toMatchObject({ needsMapping: 1, total: 1 });
    expect(initial.rows[0]).toMatchObject({
      amountFen: 65,
      status: ImportDraftRowStatus.NEEDS_MAPPING,
      userDecision: ImportRowDecision.KEEP,
    });

    await saveAlipayMappingAndOwner(draft.id, sessionUser, expenseCategory.id);
    const result = await services.confirmImportDraft(draft.id, sessionUser);
    const transactions = await db.transaction.findMany({
      where: { householdId: sessionUser.householdId, source: ALIPAY_SOURCE },
    });

    expect(result).toMatchObject({ createdCount: 1, sourceDuplicateCount: 0 });
    expect(transactions).toHaveLength(1);
    expect(transactions[0]).toMatchObject({ amountFen: 65, type: TransactionType.EXPENSE });
  });

  it("persists a full Alipay refund as a locked user-skipped row", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const draft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: buildAlipayRefundCsv({
        orderId: "alipay-full-first",
        paymentAmount: "1.80",
        refundAmounts: ["1.80"],
      }),
      fileName: "alipay-full-first.csv",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(draft.id, sessionUser);
    const fullRow = summary.rows[0]!;

    expect(summary.counts).toMatchObject({
      importable: 0,
      invalid: 0,
      sourceDuplicate: 0,
      total: 1,
      userSkipped: 1,
    });
    expect(fullRow).toMatchObject({
      amountFen: 180,
      skipReason: "ALIPAY_FULLY_REFUNDED",
      status: ImportDraftRowStatus.USER_SKIPPED,
      userDecision: ImportRowDecision.SKIP,
    });
    await expect(
      services.setImportDraftRowDecision(
        draft.id,
        fullRow.id,
        ImportRowDecision.KEEP,
        sessionUser,
      ),
    ).rejects.toThrow("Import draft row decision cannot be changed");

    const result = await services.confirmImportDraft(draft.id, sessionUser);
    const transactionCount = await db.transaction.count({
      where: { householdId: sessionUser.householdId, source: ALIPAY_SOURCE },
    });

    expect(result).toMatchObject({ createdCount: 0, userSkippedCount: 1 });
    expect(transactionCount).toBe(0);
  });

  it("marks a partial refund for an imported original amount as requiring manual adjustment", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const orderId = "alipay-original-then-refund";
    const originalDraft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: buildAlipayCsvRows([alipayExpenseRow(orderId, { amount: "1.80" })]),
      fileName: "alipay-original.csv",
      sessionUser,
    });

    await saveAlipayMappingAndOwner(originalDraft.id, sessionUser, expenseCategory.id);
    await services.confirmImportDraft(originalDraft.id, sessionUser);

    const refundBuffer = buildAlipayRefundCsv({
      orderId,
      paymentAmount: "1.80",
      refundAmounts: ["1.15"],
    });
    const refundDraft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: refundBuffer,
      fileName: "alipay-original-refund.csv",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(refundDraft.id, sessionUser);

    expect(summary.rows[0]).toMatchObject({
      amountFen: 65,
      skipReason: "ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
      userDecision: ImportRowDecision.SKIP,
    });

    await db.transaction.updateMany({
      where: { householdId: sessionUser.householdId, source: ALIPAY_SOURCE },
      data: { deletedAt: new Date() },
    });
    const softDeletedDraft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: refundBuffer,
      fileName: "alipay-original-refund-soft-deleted.csv",
      sessionUser,
    });
    const softDeletedSummary = await services.getImportDraftSummary(
      softDeletedDraft.id,
      sessionUser,
    );

    expect(softDeletedSummary.rows[0]).toMatchObject({
      skipReason: "ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
    });
  });

  it("distinguishes an equal repeated net amount from later refund changes", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const orderId = "alipay-refund-history";
    const firstBuffer = buildAlipayRefundCsv({
      orderId,
      paymentAmount: "1.80",
      refundAmounts: ["1.15"],
    });
    const firstDraft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: firstBuffer,
      fileName: "alipay-refund-history-first.csv",
      sessionUser,
    });

    await saveAlipayMappingAndOwner(firstDraft.id, sessionUser, expenseCategory.id);
    await services.confirmImportDraft(firstDraft.id, sessionUser);

    const repeatedDraft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: firstBuffer,
      fileName: "alipay-refund-history-repeat.csv",
      sessionUser,
    });
    const increasedDraft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: buildAlipayRefundCsv({
        orderId,
        paymentAmount: "1.80",
        refundAmounts: ["1.25"],
      }),
      fileName: "alipay-refund-history-increased.csv",
      sessionUser,
    });
    const fullDraft = await services.createAlipayImportDraft({ context: sessionUser,
      buffer: buildAlipayRefundCsv({
        orderId,
        paymentAmount: "1.80",
        refundAmounts: ["1.80"],
      }),
      fileName: "alipay-refund-history-full.csv",
      sessionUser,
    });
    const [repeated, increased, full] = await Promise.all([
      services.getImportDraftSummary(repeatedDraft.id, sessionUser),
      services.getImportDraftSummary(increasedDraft.id, sessionUser),
      services.getImportDraftSummary(fullDraft.id, sessionUser),
    ]);

    expect(repeated.rows[0]).toMatchObject({
      amountFen: 65,
      skipReason: "Source duplicate",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
    });
    expect(increased.rows[0]).toMatchObject({
      amountFen: 55,
      skipReason: "ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
    });
    expect(full.rows[0]).toMatchObject({
      amountFen: 180,
      skipReason: "ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT",
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
    });
  });

  it("does not match an Alipay refund fingerprint from another household", async () => {
    const first = await createHouseholdFixture();
    const second = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const orderId = "alipay-refund-household-isolation";
    const originalDraft = await services.createAlipayImportDraft({ context: first.sessionUser,
      buffer: buildAlipayCsvRows([alipayExpenseRow(orderId, { amount: "1.80" })]),
      fileName: "alipay-household-original.csv",
      sessionUser: first.sessionUser,
    });

    await saveAlipayMappingAndOwner(
      originalDraft.id,
      first.sessionUser,
      expenseCategory.id,
    );
    await services.confirmImportDraft(originalDraft.id, first.sessionUser);

    const secondDraft = await services.createAlipayImportDraft({ context: second.sessionUser,
      buffer: buildAlipayRefundCsv({
        orderId,
        paymentAmount: "1.80",
        refundAmounts: ["1.15"],
      }),
      fileName: "alipay-household-refund.csv",
      sessionUser: second.sessionUser,
    });
    const summary = await services.getImportDraftSummary(secondDraft.id, second.sessionUser);

    expect(summary.rows[0]).toMatchObject({
      amountFen: 65,
      status: ImportDraftRowStatus.NEEDS_MAPPING,
      userDecision: ImportRowDecision.KEEP,
    });
  });

  it("falls back to the current member when a WeChat Pay owner cannot be inferred", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const draft = await services.createWechatPayImportDraft({ context: sessionUser,
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
    const draft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatPayWorkbook("老公"),
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

  it("updates WeChat Pay draft owner member only on rows that still participate in import", async () => {
    const { husbandMember, sessionUser, wifeMember } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await services.createWechatPayImportDraft({ context: sessionUser,
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
      ImportDraftRowStatus.USER_SKIPPED,
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
    const draft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatPayWorkbook("老公"),
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
    const draft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatPayWorkbook("老公"),
      fileName: "wechat-completed-owner.xlsx",
      sessionUser,
    });
    await services.saveImportDraftMappings(
      draft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "wechat_pay|EXPENSE|扫二维码付款|示例商户",
        },
      ],
      sessionUser,
    );
    await saveOwnerMemberMapping(draft.id, sessionUser);
    await services.confirmImportDraft(draft.id, sessionUser);

    await expect(
      services.saveWechatPayDraftOwnerMember(draft.id, wifeMember.id, sessionUser),
    ).rejects.toThrow("Import draft is already completed");
  });

  it("rejects WeChat Pay owner member changes to a member outside the current household", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const outsideSessionUser = await createOutsideSessionUser();
    const draft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatPayWorkbook("老公"),
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
        ledgerId: sessionUser.ledgerId,
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
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
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
    const buffer = await buildWechatPayWorkbook("老公");
    const draft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer,
      fileName: "wechat-pay-confirm.xlsx",
      sessionUser,
    });
    await services.saveImportDraftMappings(
      draft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "wechat_pay|EXPENSE|扫二维码付款|示例商户",
        },
      ],
      sessionUser,
    );
    await saveOwnerMemberMapping(draft.id, sessionUser, "老公", husbandMember.id);

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
      note: "交易对方：示例商户；商品：收款方备注:二维码收款",
      source: "wechat_pay",
    });
    expect(transaction.sourceFingerprint).toEqual(expect.any(String));
    expect(transaction.sourceFingerprint).not.toBe("");
    expect(transaction.sourceImportedAt).toBeInstanceOf(Date);

    const duplicateDraft = await services.createWechatPayImportDraft({ context: sessionUser,
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

  it("creates a CMB draft with member mapping and default skip decisions", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const draft = await services.createCmbImportDraft({ context: sessionUser,
      buffer: await readCmbFixture(),
      fileName: "private-bank-statement.pdf",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary).toMatchObject({
      fileName: "cmb.pdf",
      hasUnresolvedMemberMappings: true,
      source: CMB_SOURCE,
    });
    expect(summary.counts).toMatchObject({
      invalid: 1,
      needsMapping: 2,
      total: 4,
      userSkipped: 1,
    });
    expect(summary.memberMappings).toMatchObject([
      {
        count: 4,
        externalName: "示例户名",
        fallbackApplied: true,
        memberId: husbandMember.id,
      },
    ]);
    expect(summary.rows[0]).toMatchObject({
      mappingKey: "cmb|EXPENSE|快捷支付|示例商户 示例门店",
      note: "招商银行：快捷支付；对手信息：示例商户 示例门店",
      status: ImportDraftRowStatus.NEEDS_MAPPING,
      userDecision: ImportRowDecision.KEEP,
    });
    expect(summary.rows[2]).toMatchObject({
      skipReason: "Suggested bank transfer-like transaction",
      status: ImportDraftRowStatus.USER_SKIPPED,
      userDecision: ImportRowDecision.SKIP,
    });
  });

  it("creates the same CMB draft from a password-protected ZIP without storing the password", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const draft = await services.createCmbImportDraft({ context: sessionUser,
      buffer: await buildCmbZip(),
      fileName: "download.zip",
      password: "integration-password",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary).toMatchObject({
      fileName: "cmb.pdf",
      hasUnresolvedMemberMappings: true,
      source: CMB_SOURCE,
    });
    expect(summary.rows).toHaveLength(4);
    expect(summary.memberMappings[0]).toMatchObject({
      externalName: "示例户名",
      memberId: husbandMember.id,
    });
    expect(JSON.stringify(summary)).not.toContain("integration-password");
  });

  it("reuses a saved CMB owner mapping when a default-skipped row is restored", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const draft = await services.createCmbImportDraft({ context: sessionUser,
      buffer: await readCmbFixture(),
      fileName: "statement.pdf",
      sessionUser,
    });
    const before = await services.getImportDraftSummary(draft.id, sessionUser);
    const suggestedRow = before.rows.find(
      (row) => row.status === ImportDraftRowStatus.USER_SKIPPED,
    );

    expect(suggestedRow).toBeDefined();
    await saveOwnerMemberMapping(draft.id, sessionUser, "示例户名", husbandMember.id);
    await services.setImportDraftRowDecision(
      draft.id,
      suggestedRow!.id,
      ImportRowDecision.KEEP,
      sessionUser,
    );
    const restored = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(restored.hasUnresolvedMemberMappings).toBe(false);
    expect(restored.rows.find((row) => row.id === suggestedRow!.id)).toMatchObject({
      actorFallbackApplied: false,
      actorMemberId: husbandMember.id,
      createdByMemberId: husbandMember.id,
      creatorFallbackApplied: false,
      status: ImportDraftRowStatus.NEEDS_MAPPING,
      userDecision: ImportRowDecision.KEEP,
    });

    const nextDraft = await services.createCmbImportDraft({ context: sessionUser,
      buffer: await readCmbFixture(),
      fileName: "next-statement.pdf",
      sessionUser,
    });
    const nextSummary = await services.getImportDraftSummary(nextDraft.id, sessionUser);

    expect(nextSummary.memberMappings[0]).toMatchObject({
      externalName: "示例户名",
      fallbackApplied: false,
      memberId: husbandMember.id,
    });
  });

  it("confirms mapped CMB rows while leaving suggested movements skipped", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const { expenseCategory, incomeCategory } = await getSeededCategories();
    const draft = await services.createCmbImportDraft({ context: sessionUser,
      buffer: await readCmbFixture(),
      fileName: "statement.pdf",
      sessionUser,
    });

    await services.saveImportDraftMappings(
      draft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "cmb|EXPENSE|快捷支付|示例商户 示例门店",
        },
        {
          categoryId: incomeCategory.id,
          mappingKey: "cmb|INCOME|工资|示例公司",
        },
      ],
      sessionUser,
    );
    await saveOwnerMemberMapping(draft.id, sessionUser, "示例户名", husbandMember.id);

    const result = await services.confirmImportDraft(draft.id, sessionUser);
    const transactions = await db.transaction.findMany({
      where: { householdId: sessionUser.householdId, source: CMB_SOURCE },
      orderBy: { amountFen: "asc" },
    });

    expect(result).toMatchObject({
      createdCount: 2,
      invalidCount: 1,
      source: CMB_SOURCE,
      userSkippedCount: 1,
    });
    expect(transactions).toHaveLength(2);
    expect(transactions.map((transaction) => transaction.note)).toEqual([
      "招商银行：快捷支付；对手信息：示例商户 示例门店",
      "招商银行：工资；对手信息：示例公司",
    ]);
    expect(transactions.every((transaction) => transaction.sourceFingerprint?.length === 64)).toBe(
      true,
    );

    await db.transaction.updateMany({
      where: { householdId: sessionUser.householdId, source: CMB_SOURCE },
      data: { deletedAt: new Date() },
    });
    const duplicateDraft = await services.createCmbImportDraft({ context: sessionUser,
      buffer: await readCmbFixture(),
      fileName: "duplicate-statement.pdf",
      sessionUser,
    });
    const duplicateSummary = await services.getImportDraftSummary(
      duplicateDraft.id,
      sessionUser,
    );

    expect(duplicateSummary.counts.sourceDuplicate).toBe(2);
    expect(
      duplicateSummary.rows.filter(
        (row) => row.status === ImportDraftRowStatus.SOURCE_DUPLICATE,
      ),
    ).toHaveLength(2);
  });

  it("does not require member mappings for source duplicate rows", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const ownerlessBuffer = await buildWechatPayWorkbook("");
    const draft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: ownerlessBuffer,
      fileName: "wechat-pay-source-duplicate-first.xlsx",
      sessionUser,
    });

    await services.saveImportDraftMappings(
      draft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "wechat_pay|EXPENSE|扫二维码付款|示例商户",
        },
      ],
      sessionUser,
    );
    await services.savePaymentImportDraftOwnerMember(draft.id, sessionUser.memberId, sessionUser);
    await services.confirmImportDraft(draft.id, sessionUser);

    const buffer = await buildWechatPayWorkbook("老公");
    const duplicateDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer,
      fileName: "wechat-pay-source-duplicate-second.xlsx",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(duplicateDraft.id, sessionUser);

    expect(summary.counts.sourceDuplicate).toBe(1);
    expect(summary.memberMappings).toEqual([]);
    expect(summary.hasUnresolvedMemberMappings).toBe(false);
  });

  it("reuses household WeChat Pay category mappings on the next draft", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const firstDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatPayWorkbook("老公"),
      fileName: "wechat-first.xlsx",
      sessionUser,
    });

    await services.saveImportDraftMappings(
      firstDraft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "wechat_pay|EXPENSE|扫二维码付款|示例商户",
        },
      ],
      sessionUser,
    );

    const secondDraft = await services.createWechatPayImportDraft({ context: sessionUser,
      buffer: await buildWechatPayWorkbook("老公"),
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

    await db.importMemberMapping.createMany({
      data: [
        {
          externalName: "老婆",
          householdId: sessionUser.householdId,
          memberId: wifeMember.id,
          source: SUI_SHOU_JI_SOURCE,
        },
        {
          externalName: "老公",
          householdId: sessionUser.householdId,
          memberId: sessionUser.memberId,
          source: SUI_SHOU_JI_SOURCE,
        },
      ],
    });

    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
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
      completedNow: true,
      createdCount: 2,
      source: SUI_SHOU_JI_SOURCE,
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
    expect(transactions[0]?.note).toBeNull();
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

    expect(secondResult).toMatchObject({
      completedNow: false,
      createdCount: 2,
      source: SUI_SHOU_JI_SOURCE,
    });
    expect(transactionCount).toBe(2);
  });

  it("marks same-source duplicate rows even when the existing transaction is soft deleted", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const buffer = await buildExpenseWorkbook();
    const firstDraft = await services.createSuiShouJiImportDraft({ context: sessionUser,
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

    const secondDraft = await services.createSuiShouJiImportDraft({ context: sessionUser,
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
    const firstDraft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({ rawAccount: "现金", rawMerchant: "小店" }),
      fileName: "cash.xlsx",
      sessionUser,
    });
    await saveDefaultMappings(firstDraft.id, sessionUser);
    await services.confirmImportDraft(firstDraft.id, sessionUser);

    const secondDraft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook({ rawAccount: "银行卡", rawMerchant: "小店" }),
      fileName: "card.xlsx",
      sessionUser,
    });
    const thirdDraft = await services.createSuiShouJiImportDraft({ context: sessionUser,
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

  it("defaults manual same-day same-amount possible duplicates to skip and honors keep on confirm", async () => {
    const { sessionUser, husbandMember } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    await db.transaction.create({
      data: {
        ledgerId: sessionUser.ledgerId,
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

    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(),
      fileName: "possible.xlsx",
      sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
      userDecision: ImportRowDecision.SKIP,
    });
    expect(summary.rows[0]?.duplicateCandidates).toHaveLength(1);

    await services.setImportDraftRowDecision(
      draft.id,
      summary.rows[0]!.id,
      ImportRowDecision.KEEP,
      sessionUser,
    );
    const result = await services.confirmImportDraft(draft.id, sessionUser);

    expect(result).toMatchObject({
      createdCount: 1,
      userSkippedCount: 0,
    });

    const importedCount = await db.transaction.count({
      where: {
        householdId: sessionUser.householdId,
        source: "sui_shou_ji",
      },
    });

    expect(importedCount).toBe(1);
  });

  it("allows skipping a row that still needs category mapping and confirms the rest", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseIncomeWorkbook(),
      fileName: "skip-unmapped.xlsx",
      sessionUser,
    });
    const initialSummary = await services.getImportDraftSummary(draft.id, sessionUser);
    const expenseRow = initialSummary.rows.find(
      (row) => row.mappingKey === "sui_shou_ji|EXPENSE|餐饮|三餐",
    );

    await services.setImportDraftRowDecision(
      draft.id,
      expenseRow!.id,
      ImportRowDecision.SKIP,
      sessionUser,
    );

    const skippedSummary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(skippedSummary.counts.needsMapping).toBe(1);
    expect(skippedSummary.counts.userSkipped).toBe(1);
    expect(skippedSummary.missingMappings.map((mapping) => mapping.mappingKey)).toEqual([
      "sui_shou_ji|INCOME|职业收入|工资",
    ]);

    const { incomeCategory } = await getSeededCategories();

    await services.saveImportDraftMappings(
      draft.id,
      [{ categoryId: incomeCategory.id, mappingKey: "sui_shou_ji|INCOME|职业收入|工资" }],
      sessionUser,
    );
    await saveOwnerMemberMapping(draft.id, sessionUser, "老公", sessionUser.memberId);

    const result = await services.confirmImportDraft(draft.id, sessionUser);

    expect(result).toMatchObject({
      createdCount: 1,
      needsMappingCount: 0,
      userSkippedCount: 1,
    });
  });

  it("restores a skipped needs-mapping row back to needs mapping", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(),
      fileName: "restore-unmapped.xlsx",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    await services.setImportDraftRowDecision(
      draft.id,
      summary.rows[0]!.id,
      ImportRowDecision.SKIP,
      sessionUser,
    );
    await services.setImportDraftRowDecision(
      draft.id,
      summary.rows[0]!.id,
      ImportRowDecision.KEEP,
      sessionUser,
    );

    const restoredSummary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(restoredSummary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.NEEDS_MAPPING,
      userDecision: ImportRowDecision.KEEP,
    });
    expect(restoredSummary.missingMappings).toHaveLength(1);
  });

  it("does not let saved mappings override a user skipped row", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(),
      fileName: "skip-then-map.xlsx",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    await services.setImportDraftRowDecision(
      draft.id,
      summary.rows[0]!.id,
      ImportRowDecision.SKIP,
      sessionUser,
    );
    await services.saveImportDraftMappings(
      draft.id,
      [{ categoryId: expenseCategory.id, mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐" }],
      sessionUser,
    );

    const mappedSummary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(mappedSummary.rows[0]).toMatchObject({
      categoryId: null,
      status: ImportDraftRowStatus.USER_SKIPPED,
      userDecision: ImportRowDecision.SKIP,
    });
  });

  it("treats non-empty cross-source same-day same-amount transactions as possible duplicates", async () => {
    const { sessionUser, husbandMember } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    await db.transaction.create({
      data: {
        ledgerId: sessionUser.ledgerId,
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

    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(),
      fileName: "cross-source-possible.xlsx",
      sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
      userDecision: ImportRowDecision.SKIP,
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
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(),
      fileName: "unique-conflict.xlsx",
      sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);
    await installImportDraftTestTrigger("conflict");

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
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
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
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(),
      fileName: "concurrent-confirm.xlsx",
      sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);
    await installImportDraftTestTrigger("sleep");

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
    expect([firstResult.completedNow, secondResult.completedNow].sort()).toEqual([false, true]);
    expect([firstResult.source, secondResult.source]).toEqual([
      SUI_SHOU_JI_SOURCE,
      SUI_SHOU_JI_SOURCE,
    ]);
    expect(firstResult.sourceDuplicateCount + secondResult.sourceDuplicateCount).toBe(0);
    expect(importedCount).toBe(1);
    expect(await db.resourceWindow.findUnique({ where: { key: `import:household:${sessionUser.householdId}` } })).toMatchObject({ used: 2 });
    expect(await db.resourceLease.count({ where: { householdId: sessionUser.householdId } })).toBe(0);
    expect(summary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.READY,
      userDecision: ImportRowDecision.KEEP,
    });
  });

  it.each([false, true])("bounds duplicate confirmation waiters without recharging or rerunning the original task (expire=%s)", async (expire) => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(), fileName: "bounded-confirm.xlsx", sessionUser,
    });
    await saveDefaultMappings(draft.id, sessionUser);
    await installImportDraftTestTrigger(expire ? "wait-expire" : "wait");
    let began!: () => void;
    let release!: () => void;
    const ready = new Promise<void>((resolve) => { began = resolve; });
    const gate = new Promise<void>((resolve) => { release = resolve; });
    const holding = db.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('billboard-import-confirm-wait-test', 0))::text`;
      began();
      await gate;
    }, { timeout: 20_000 });
    await ready;
    const requests: Array<Promise<PromiseSettledResult<Awaited<ReturnType<DraftServices["confirmImportDraft"]>>>>> = [];
    const settle = (pending: ReturnType<DraftServices["confirmImportDraft"]>) => pending.then(
      (value) => ({ status: "fulfilled" as const, value }),
      (reason: unknown) => ({ status: "rejected" as const, reason }),
    );
    let results: Array<Awaited<(typeof requests)[number]>> = [];
    let completedWaiters = 0;
    try {
      requests.push(settle(services.confirmImportDraft(draft.id, sessionUser)));
      await vi.waitFor(async () => {
        const [{ count }] = await db.$queryRaw<Array<{ count: number }>>`SELECT count(*)::int AS count FROM pg_locks WHERE locktype = 'advisory' AND NOT granted`;
        expect(count).toBe(1);
      }, { timeout: 5000 });
      await expect(services.confirmImportDraft(draft.id, { ...sessionUser, memberId: wifeMember.id })).rejects.toMatchObject({ code: "BUSY" });
      for (let index = 0; index < 7; index += 1) {
        requests.push(settle(services.confirmImportDraft(draft.id, sessionUser)).then((result) => { completedWaiters += 1; return result; }));
      }
      await vi.waitFor(() => expect(completedWaiters).toBe(5), { timeout: 5000 });
      expect(await db.resourceLease.findFirst({ where: { householdId: sessionUser.householdId, taskKey: `import-confirm:${draft.id}` } })).toMatchObject({ waiters: 2 });
      expect(await db.resourceWindow.findUnique({ where: { key: `import:household:${sessionUser.householdId}` } })).toMatchObject({ used: 2 });
    } finally {
      release();
      await holding;
      results = await Promise.all(requests);
    }
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(expire ? 0 : 3);
    const errors = results.flatMap((result) => result.status === "rejected" ? [result.reason as { code: string }] : []);
    expect(errors.filter(({ code }) => code === "BUSY")).toHaveLength(expire ? 7 : 5);
    expect(errors.filter(({ code }) => code === "EXPIRED")).toHaveLength(expire ? 1 : 0);
    expect(await db.transaction.count({ where: { householdId: sessionUser.householdId } })).toBe(expire ? 0 : 1);
    expect(await db.resourceLease.count({ where: { householdId: sessionUser.householdId } })).toBe(0);
    expect(await db.resourceWindow.findUnique({ where: { key: `import:household:${sessionUser.householdId}` } })).toMatchObject({ used: 2 });
  }, 30_000);

  it("restores keep after skip and imports the possible duplicate row", async () => {
    const { sessionUser, husbandMember } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    await db.transaction.create({
      data: {
        ledgerId: sessionUser.ledgerId,
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

    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
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
        ledgerId: sessionUser.ledgerId,
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
        rawCreatedBy: "老婆",
        rawCurrency: "CNY",
        rawDate: "2026-05-06 13:00:00",
        rawMember: "老婆",
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
        ledgerId: sessionUser.ledgerId,
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
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
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
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
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
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|示例商户",
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
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
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
        ledgerId: sessionUser.ledgerId,
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
    const firstDraft = await services.createSuiShouJiImportDraft({ context: sessionUser,
      buffer: await buildExpenseWorkbook(),
      fileName: "first-decision.xlsx",
      sessionUser,
    });
    const secondDraft = await services.createSuiShouJiImportDraft({ context: sessionUser,
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
      userDecision: ImportRowDecision.SKIP,
    });
  });

  it("rejects summary and confirmation access from outside the draft household", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const outsideSessionUser = await createOutsideSessionUser();
    const draft = await services.createSuiShouJiImportDraft({ context: sessionUser,
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
