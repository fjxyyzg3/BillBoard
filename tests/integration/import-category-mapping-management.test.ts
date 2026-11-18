import { randomUUID } from "node:crypto";
import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { CategoryType, HouseholdRole, ImportDraftRowStatus, ImportDraftStatus, ImportRowDecision, type Prisma, TransactionType } from "@prisma/client";
import ExcelJS from "exceljs";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

import type { ManagedImportCategoryMappingChange } from "@/lib/imports/category-mapping-management";
import { ALIPAY_SOURCE, CATEGORY_MAPPING_IGNORED, CMB_SOURCE, type ImportSource, SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE } from "@/lib/imports/types";

if (existsSync(".env.example")) {
  process.loadEnvFile?.(".env.example");
}

type SessionUser = { householdId: string; ledgerId: string; memberId: string };
let db: typeof import("@/lib/db").db;
let drafts: typeof import("@/lib/imports/drafts");
let management: typeof import("@/lib/imports/category-mapping-management");
const householdIds: string[] = [];
const userIds: string[] = [];
const categoryIds: string[] = [];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" ||
    !["127.0.0.1", "localhost"].includes(url.hostname) ||
    !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Refusing to run category mapping tests against a non-local dev/test database");
  }
  ({ db } = await import("@/lib/db"));
  drafts = await import("@/lib/imports/drafts");
  management = await import("@/lib/imports/category-mapping-management");
});

beforeEach(async () => {
  // Global admission windows survive household fixture deletion.
  await db.resourceWindow.deleteMany({ where: { kind: "import" } });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await db.resourceWindow.deleteMany({ where: { kind: "import" } });
  await db.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  await db.category.deleteMany({ where: { id: { in: categoryIds.splice(0) } } });
});

afterAll(async () => {
  await db.$disconnect();
});

async function householdFixture() {
  const household = await db.household.create({ data: { name: "Mapping management test" } });
  householdIds.push(household.id);
  const ledger = await db.ledger.create({ data: { householdId: household.id, name: "Default", isDefault: true } });
  const user = await db.user.create({ data: {
    displayName: "Mapping management member", email: `mapping-${randomUUID()}@example.com`, passwordHash: "not-used",
  } });
  userIds.push(user.id);
  const member = await db.householdMember.create({ data: {
    householdId: household.id, userId: user.id, memberName: "老公", role: HouseholdRole.OWNER,
  } });
  const [expenseCategory, otherExpenseCategory, incomeCategory] = await Promise.all([
    db.category.findUniqueOrThrow({ where: { type_name: { name: "Dining", type: CategoryType.EXPENSE } } }),
    db.category.findUniqueOrThrow({ where: { type_name: { name: "Transport", type: CategoryType.EXPENSE } } }),
    db.category.findUniqueOrThrow({ where: { type_name: { name: "Salary", type: CategoryType.INCOME } } }),
  ]);
  return { sessionUser: { householdId: household.id, ledgerId: ledger.id, memberId: member.id } satisfies SessionUser,
    expenseCategory, otherExpenseCategory, incomeCategory };
}

async function draftFixture(sessionUser: SessionUser, primaryCategory = "餐饮") {
  const draft = await db.importDraft.create({ data: {
    ledgerId: sessionUser.ledgerId,
    createdByMemberId: sessionUser.memberId, fileName: "mapping-test.xlsx", householdId: sessionUser.householdId,
    source: "sui_shou_ji",
  } });
  const mappingKey = `sui_shou_ji|EXPENSE|${primaryCategory}|三餐`;
  await db.importDraftRow.create({ data: {
    draftId: draft.id, rowNumber: 1, mappingKey, primaryCategory, secondaryCategory: "三餐",
    status: ImportDraftRowStatus.NEEDS_MAPPING, transactionType: TransactionType.EXPENSE,
  } });
  return { draft, mappingKey };
}

async function ruleFixture(sessionUser: SessionUser, data: Partial<Prisma.ImportCategoryMappingUncheckedCreateInput> = {}) {
  return db.importCategoryMapping.create({ data: {
    householdId: sessionUser.householdId, primaryCategory: "餐饮", secondaryCategory: "三餐",
    source: SUI_SHOU_JI_SOURCE, transactionType: TransactionType.EXPENSE, categoryId: null, ...data,
  } });
}

function changeFor(rule: { id: string; updatedAt: Date }, categoryId: string | null): ManagedImportCategoryMappingChange {
  return { id: rule.id, categoryId, expectedUpdatedAt: rule.updatedAt.toISOString() };
}

async function createImportedDraft(source: ImportSource, sessionUser: SessionUser) {
  const common = { sessionUser, context: sessionUser, fileName: "management-source-fixture" };
  if (source === CMB_SOURCE) {
    return drafts.createCmbImportDraft({ ...common,
      buffer: await readFile(path.join(process.cwd(), "tests/fixtures/imports/cmb/statement-single-page.pdf")),
    });
  }
  if (source === ALIPAY_SOURCE) {
    const rows = ["导出信息：", "姓名：老公",
      "------------------------支付宝支付科技有限公司  电子客户回单------------------------",
      "交易时间,交易分类,交易对方,对方账号,商品说明,收/支,金额,收/付款方式,交易状态,交易订单号,商家订单号,备注,",
      "2026-05-07 12:17:13,餐饮美食,示例商户,/,示例商品,支出,22.85,零钱,交易成功,management-order,management-merchant,/,",
    ];
    return drafts.createAlipayImportDraft({ ...common, buffer: Buffer.from(rows.join("\n")) });
  }
  const workbook = new ExcelJS.Workbook();
  if (source === SUI_SHOU_JI_SOURCE) {
    workbook.addWorksheet("支出").addRows([
      ["交易类型", "日期", "一级分类", "二级分类", "账户1", "账户币种", "金额", "成员", "商家", "记账人", "备注"],
      ["支出", "2026-05-06 13:23:02", "餐饮", "三餐", "现金", "CNY", "176", "老公", "小店", "老公", "午饭"],
    ]);
    return drafts.createSuiShouJiImportDraft({ ...common, buffer: Buffer.from(await workbook.xlsx.writeBuffer()) });
  }
  workbook.addWorksheet("Sheet1").addRows([
    ["微信支付账单明细"], ["微信昵称：[老公]"], [],
    ["交易时间", "交易类型", "交易对方", "商品", "收/支", "金额(元)", "支付方式", "当前状态", "交易单号", "商户单号", "备注"],
    ["2026-05-02 17:22:40", "扫二维码付款", "示例商户", "商品", "支出", "30", "零钱", "已转账", "management-order", "management-merchant", "/"],
  ]);
  return drafts.createWechatPayImportDraft({ ...common, buffer: Buffer.from(await workbook.xlsx.writeBuffer()) });
}

describe("import category mapping management", () => {
  it("advances the persisted rule version after a future version in the existing draft writer", async () => {
    const fixture = await householdFixture();
    const { draft, mappingKey } = await draftFixture(fixture.sessionUser);
    await drafts.saveImportDraftMappings(draft.id, [{ mappingKey, categoryId: fixture.expenseCategory.id }], fixture.sessionUser);
    const rule = await db.importCategoryMapping.findFirstOrThrow({ where: { householdId: fixture.sessionUser.householdId } });
    const futureVersion = new Date("2099-01-01T00:00:00.000Z");
    await db.importCategoryMapping.update({ where: { id: rule.id }, data: { updatedAt: futureVersion } });

    await drafts.saveImportDraftMappings(draft.id, [{ mappingKey, categoryId: null }], fixture.sessionUser);

    const saved = await db.importCategoryMapping.findUniqueOrThrow({ where: { id: rule.id } });
    expect(saved.categoryId).toBeNull();
    expect(saved.updatedAt.getTime()).toBeGreaterThan(futureVersion.getTime());
  });

  it("lists all supported sources and current inactive targets without including other households or unsupported rules", async () => {
    const fixture = await householdFixture();
    const outside = await householdFixture();
    const inactiveCategory = await db.category.create({ data: {
      name: `Inactive mapping ${randomUUID()}`, type: CategoryType.EXPENSE, sortOrder: 999, isActive: false,
    } });
    categoryIds.push(inactiveCategory.id);
    const rules = await Promise.all([SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE, ALIPAY_SOURCE, CMB_SOURCE].map((source, index) =>
      ruleFixture(fixture.sessionUser, { source, categoryId: index === 0 ? inactiveCategory.id : null,
        primaryCategory: index === 1 ? "" : `source ${index}`, secondaryCategory: index === 1 ? "" : "secondary" }),
    ));
    await ruleFixture(outside.sessionUser, { categoryId: fixture.expenseCategory.id });
    await ruleFixture(fixture.sessionUser, { source: "unsupported_source" });
    const result = await management.getImportCategoryMappingManagement(fixture.sessionUser);

    expect(result.mappings).toHaveLength(4);
    expect(new Set(result.mappings.map(({ source }) => source))).toEqual(new Set([SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE, ALIPAY_SOURCE, CMB_SOURCE]));
    expect(result.mappings.find(({ id }) => id === rules[0].id)).toMatchObject({
      categoryId: inactiveCategory.id, categoryName: inactiveCategory.name, categoryIsActive: false,
      updatedAt: rules[0].updatedAt.toISOString(),
    });
    expect(result.mappings.find(({ id }) => id === rules[1].id)).toMatchObject({
      primaryCategory: "", secondaryCategory: "", categoryId: null, categoryName: null, categoryIsActive: null,
    });
    expect(result.categories.map(({ id }) => id)).not.toContain(inactiveCategory.id);
    expect(result.categories).toContainEqual({ id: fixture.expenseCategory.id, name: "Dining", type: CategoryType.EXPENSE });
  });

  it("returns an empty rules list without requiring an import draft", async () => {
    const { sessionUser } = await householdFixture();
    expect((await management.getImportCategoryMappingManagement(sessionUser)).mappings).toEqual([]);
    expect(await db.importDraft.count({ where: { householdId: sessionUser.householdId } })).toBe(0);
  });

  it("shares an income rule with another current household member", async () => {
    const fixture = await householdFixture();
    const rule = await ruleFixture(fixture.sessionUser, {
      primaryCategory: "职业收入", secondaryCategory: "工资", transactionType: TransactionType.INCOME,
    });
    const user = await db.user.create({ data: {
      email: `mapping-second-${randomUUID()}@example.com`, displayName: "Second member", passwordHash: "not-used",
    } });
    userIds.push(user.id);
    const member = await db.householdMember.create({ data: {
      householdId: fixture.sessionUser.householdId, userId: user.id, memberName: "老婆", role: HouseholdRole.MEMBER,
    } });
    const otherMember = { ...fixture.sessionUser, memberId: member.id };
    expect((await management.getImportCategoryMappingManagement(otherMember)).mappings).toEqual([
      expect.objectContaining({ id: rule.id, transactionType: TransactionType.INCOME, categoryId: null }),
    ]);
    const result = await management.saveManagedImportCategoryMappings([changeFor(rule, fixture.incomeCategory.id)], otherMember);
    expect(result).toEqual([{ id: rule.id, categoryId: fixture.incomeCategory.id, updatedAt: expect.any(String) }]);
    expect((await management.getImportCategoryMappingManagement(fixture.sessionUser)).mappings).toEqual([
      expect.objectContaining({ id: rule.id, categoryId: fixture.incomeCategory.id, categoryName: "Salary", categoryIsActive: true }),
    ]);
  });

  it("rejects a missing session member for reads and no-op saves", async () => {
    const fixture = await householdFixture();
    const sessionUser = { ...fixture.sessionUser, memberId: "missing-member" };
    await expect(management.getImportCategoryMappingManagement(sessionUser)).rejects.toThrow("Unauthorized");
    await expect(management.saveManagedImportCategoryMappings([], sessionUser)).rejects.toThrow("Unauthorized");
  });

  it.each(["read", "save"])("rejects %s when the session member belongs to another household", async (operation) => {
    const fixture = await householdFixture();
    const outside = await householdFixture();
    const sessionUser = { householdId: fixture.sessionUser.householdId, memberId: outside.sessionUser.memberId };
    const rule = await ruleFixture(fixture.sessionUser);
    const promise = operation === "read" ? management.getImportCategoryMappingManagement(sessionUser) :
      management.saveManagedImportCategoryMappings([changeFor(rule, fixture.expenseCategory.id)], sessionUser);
    await expect(promise).rejects.toThrow("Unauthorized");
    expect(await db.importCategoryMapping.findUnique({ where: { id: rule.id } })).toEqual(rule);
  });

  it.each([SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE, ALIPAY_SOURCE, CMB_SOURCE])(
    "changes a %s rule between real categories and ignore for future drafts only", async (source) => {
      const fixture = await householdFixture();
      const original = await createImportedDraft(source, fixture.sessionUser);
      const initialSummary = await drafts.getImportDraftSummary(original.id, fixture.sessionUser);
      const group = initialSummary.missingMappings.find(({ transactionType }) => transactionType === TransactionType.EXPENSE)!;
      await drafts.saveImportDraftMappings(original.id, [{ mappingKey: group.mappingKey, categoryId: fixture.expenseCategory.id }], fixture.sessionUser);
      const oldRows = await db.importDraftRow.findMany({ where: { draftId: original.id }, orderBy: { id: "asc" } });
      let rule = await db.importCategoryMapping.findFirstOrThrow({ where: { householdId: fixture.sessionUser.householdId, source, transactionType: TransactionType.EXPENSE } });

      for (const categoryId of [fixture.otherExpenseCategory.id, null, fixture.expenseCategory.id]) {
        const saved = await management.saveManagedImportCategoryMappings([changeFor(rule, categoryId)], fixture.sessionUser);
        expect(saved).toEqual([{ id: rule.id, categoryId, updatedAt: expect.any(String) }]);
        const next = await createImportedDraft(source, fixture.sessionUser);
        const summary = await drafts.getImportDraftSummary(next.id, fixture.sessionUser);
        expect(summary.rows.filter(({ mappingKey }) => mappingKey === group.mappingKey)).toEqual([
          expect.objectContaining(categoryId === null ? {
            categoryId: null, skipReason: CATEGORY_MAPPING_IGNORED, status: ImportDraftRowStatus.USER_SKIPPED, userDecision: ImportRowDecision.SKIP,
          } : { categoryId, status: ImportDraftRowStatus.READY, userDecision: ImportRowDecision.KEEP }),
        ]);
        expect(await db.importDraftRow.findMany({ where: { draftId: original.id }, orderBy: { id: "asc" } })).toEqual(oldRows);
        rule = await db.importCategoryMapping.findUniqueOrThrow({ where: { id: rule.id } });
      }
    },
  );

  it("keeps all existing drafts, rows, member ownership, completed states and active or soft-deleted transactions unchanged", async () => {
    const fixture = await householdFixture();
    const first = await draftFixture(fixture.sessionUser);
    const second = await draftFixture(fixture.sessionUser);
    await db.importDraft.update({ where: { id: second.draft.id }, data: { status: ImportDraftStatus.COMPLETED, completedAt: new Date() } });
    await db.importDraftRow.updateMany({ where: { draftId: { in: [first.draft.id, second.draft.id] } }, data: {
      actorMemberId: fixture.sessionUser.memberId, createdByMemberId: fixture.sessionUser.memberId,
      categoryId: fixture.expenseCategory.id, userDecision: ImportRowDecision.SKIP, skipReason: "User skipped",
    } });
    for (const deletedAt of [null, new Date("2026-05-08T00:00:00.000Z")]) {
      await db.transaction.create({ data: {
        ledgerId: fixture.sessionUser.ledgerId,
        householdId: fixture.sessionUser.householdId, actorMemberId: fixture.sessionUser.memberId,
        createdByMemberId: fixture.sessionUser.memberId, categoryId: fixture.expenseCategory.id, amountFen: 2200,
        type: TransactionType.EXPENSE, occurredAt: new Date("2026-05-07T00:00:00.000Z"), deletedAt,
        source: SUI_SHOU_JI_SOURCE, sourceFingerprint: randomUUID(), sourceImportedAt: new Date(),
      } });
    }
    const snapshot = async () => Promise.all([
      db.importDraft.findMany({ where: { householdId: fixture.sessionUser.householdId }, orderBy: { id: "asc" } }),
      db.importDraftRow.findMany({ where: { draft: { householdId: fixture.sessionUser.householdId } }, orderBy: { id: "asc" } }),
      db.transaction.findMany({ where: { householdId: fixture.sessionUser.householdId }, orderBy: { id: "asc" } }),
    ]);
    const before = await snapshot();
    const rule = await ruleFixture(fixture.sessionUser, { categoryId: fixture.expenseCategory.id });
    await management.saveManagedImportCategoryMappings([changeFor(rule, null)], fixture.sessionUser);
    expect(await snapshot()).toEqual(before);
  });

  it("locates an existing rule by ID without splitting raw source category identifiers", async () => {
    const fixture = await householdFixture();
    const rule = await ruleFixture(fixture.sessionUser, { primaryCategory: "food|raw", secondaryCategory: "A|B" });
    await management.saveManagedImportCategoryMappings([changeFor(rule, fixture.expenseCategory.id)], fixture.sessionUser);
    expect(await db.importCategoryMapping.findUnique({ where: { id: rule.id } })).toMatchObject({
      primaryCategory: "food|raw", secondaryCategory: "A|B", categoryId: fixture.expenseCategory.id,
    });
  });

  it("does not write rules for an empty batch or a target unchanged from the current version", async () => {
    const fixture = await householdFixture();
    const rule = await ruleFixture(fixture.sessionUser);
    expect(await management.saveManagedImportCategoryMappings([], fixture.sessionUser)).toEqual([]);
    expect(await management.saveManagedImportCategoryMappings([changeFor(rule, null)], fixture.sessionUser)).toEqual([]);
    expect(await db.importCategoryMapping.findUnique({ where: { id: rule.id } })).toEqual(rule);
  });

  it("does not conflict with or overwrite a concurrently changed unsubmitted group", async () => {
    const fixture = await householdFixture();
    const x = await ruleFixture(fixture.sessionUser);
    const y = await ruleFixture(fixture.sessionUser, { primaryCategory: "出行" });
    const savedX = await management.saveManagedImportCategoryMappings([changeFor(x, fixture.expenseCategory.id)], fixture.sessionUser);
    await management.saveManagedImportCategoryMappings([changeFor(y, fixture.otherExpenseCategory.id)], fixture.sessionUser);
    expect(await db.importCategoryMapping.findUnique({ where: { id: x.id } })).toMatchObject({
      categoryId: fixture.expenseCategory.id, updatedAt: new Date(savedX[0].updatedAt),
    });
    expect(await db.importCategoryMapping.findUnique({ where: { id: y.id } })).toMatchObject({ categoryId: fixture.otherExpenseCategory.id });
  });

  it("advances strict versions at the same millisecond and after clock rollback in both writers", async () => {
    const fixture = await householdFixture();
    const { draft, mappingKey } = await draftFixture(fixture.sessionUser);
    const initialTime = Date.parse("2099-01-01T00:00:00.000Z");
    const rule = await ruleFixture(fixture.sessionUser, { updatedAt: new Date(initialTime), categoryId: fixture.expenseCategory.id });
    const clock = vi.spyOn(Date, "now").mockReturnValue(initialTime);
    const first = await management.saveManagedImportCategoryMappings([changeFor(rule, fixture.otherExpenseCategory.id)], fixture.sessionUser);
    expect(Date.parse(first[0].updatedAt)).toBe(initialTime + 1);
    clock.mockReturnValue(initialTime - 60_000);
    await drafts.saveImportDraftMappings(draft.id, [{ mappingKey, categoryId: null }], fixture.sessionUser);
    const second = await db.importCategoryMapping.findUniqueOrThrow({ where: { id: rule.id } });
    expect(second.updatedAt.getTime()).toBe(initialTime + 2);
    await expect(management.saveManagedImportCategoryMappings([{
      id: rule.id, categoryId: fixture.expenseCategory.id, expectedUpdatedAt: first[0].updatedAt,
    }], fixture.sessionUser)).rejects.toBeInstanceOf(management.ImportCategoryMappingConflictError);
    const third = await management.saveManagedImportCategoryMappings([changeFor(second, fixture.expenseCategory.id)], fixture.sessionUser);
    expect(Date.parse(third[0].updatedAt)).toBe(initialTime + 3);
  });

  it("allows only one of two simultaneous management saves using the same initial version", async () => {
    const fixture = await householdFixture();
    const rule = await ruleFixture(fixture.sessionUser);
    const outcomes = await Promise.allSettled([
      management.saveManagedImportCategoryMappings([changeFor(rule, fixture.expenseCategory.id)], fixture.sessionUser),
      management.saveManagedImportCategoryMappings([changeFor(rule, fixture.otherExpenseCategory.id)], fixture.sessionUser),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.any(management.ImportCategoryMappingConflictError) }),
    ]);
    const saved = await db.importCategoryMapping.findUniqueOrThrow({ where: { id: rule.id } });
    const successful = outcomes.find(({ status }) => status === "fulfilled");
    if (successful?.status !== "fulfilled") throw new Error("Expected a successful save");
    expect(saved.categoryId).toBe(successful.value[0].categoryId);
    expect(saved.updatedAt.toISOString()).toBe(successful.value[0].updatedAt);
  });

  it("serializes simultaneous draft and management writers without allowing a stale management overwrite", async () => {
    const fixture = await householdFixture();
    const { draft, mappingKey } = await draftFixture(fixture.sessionUser);
    const rule = await ruleFixture(fixture.sessionUser, { categoryId: fixture.expenseCategory.id });
    const outcomes = await Promise.allSettled([
      drafts.saveImportDraftMappings(draft.id, [{ mappingKey, categoryId: null }], fixture.sessionUser),
      management.saveManagedImportCategoryMappings([changeFor(rule, fixture.otherExpenseCategory.id)], fixture.sessionUser),
    ]);
    expect(outcomes[0].status).toBe("fulfilled");
    if (outcomes[1].status === "rejected") {
      expect(outcomes[1].reason).toBeInstanceOf(management.ImportCategoryMappingConflictError);
    }
    const saved = await db.importCategoryMapping.findUniqueOrThrow({ where: { id: rule.id } });
    expect(saved.categoryId).toBeNull();
    expect(saved.updatedAt.getTime()).toBeGreaterThan(rule.updatedAt.getTime());
    expect(await db.importDraftRow.findMany({ where: { draftId: draft.id } })).toEqual([
      expect.objectContaining({ status: ImportDraftRowStatus.USER_SKIPPED, skipReason: CATEGORY_MAPPING_IGNORED }),
    ]);
  });

  it("safely creates one shared rule when two different drafts first save the same group", async () => {
    const fixture = await householdFixture();
    const first = await draftFixture(fixture.sessionUser);
    const second = await draftFixture(fixture.sessionUser);
    await Promise.all([
      drafts.saveImportDraftMappings(first.draft.id, [{ mappingKey: first.mappingKey, categoryId: fixture.expenseCategory.id }], fixture.sessionUser),
      drafts.saveImportDraftMappings(second.draft.id, [{ mappingKey: second.mappingKey, categoryId: null }], fixture.sessionUser),
    ]);
    const rules = await db.importCategoryMapping.findMany({ where: { householdId: fixture.sessionUser.householdId } });
    expect(rules).toHaveLength(1);
    expect(rules[0].updatedAt.getTime()).toBeGreaterThan(rules[0].createdAt.getTime());
    expect(await db.importDraftRow.findFirst({ where: { draftId: first.draft.id } })).toMatchObject({
      categoryId: fixture.expenseCategory.id, status: ImportDraftRowStatus.READY,
    });
    expect(await db.importDraftRow.findFirst({ where: { draftId: second.draft.id } })).toMatchObject({
      categoryId: null, status: ImportDraftRowStatus.USER_SKIPPED,
    });
  });

  it("serializes reversed multi-group management batches without deadlock or partial application", async () => {
    const fixture = await householdFixture();
    const x = await ruleFixture(fixture.sessionUser);
    const y = await ruleFixture(fixture.sessionUser, { primaryCategory: "出行" });
    const outcomes = await Promise.allSettled([
      management.saveManagedImportCategoryMappings([changeFor(x, fixture.expenseCategory.id), changeFor(y, fixture.expenseCategory.id)], fixture.sessionUser),
      management.saveManagedImportCategoryMappings([changeFor(y, fixture.otherExpenseCategory.id), changeFor(x, fixture.otherExpenseCategory.id)], fixture.sessionUser),
    ]);
    expect(outcomes.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    expect(outcomes.filter(({ status }) => status === "rejected")).toEqual([
      expect.objectContaining({ reason: expect.any(management.ImportCategoryMappingConflictError) }),
    ]);
    const rules = await db.importCategoryMapping.findMany({ where: { householdId: fixture.sessionUser.householdId } });
    expect(new Set(rules.map(({ categoryId }) => categoryId)).size).toBe(1);
  });

  it("rejects a stale rule and leaves every target and version in the submitted batch unchanged", async () => {
    const fixture = await householdFixture();
    const x = await ruleFixture(fixture.sessionUser);
    const y = await ruleFixture(fixture.sessionUser, { primaryCategory: "出行" });
    await management.saveManagedImportCategoryMappings([changeFor(y, fixture.expenseCategory.id)], fixture.sessionUser);
    const before = await db.importCategoryMapping.findMany({ where: { householdId: fixture.sessionUser.householdId }, orderBy: { id: "asc" } });
    await expect(management.saveManagedImportCategoryMappings([
      changeFor(x, fixture.otherExpenseCategory.id), changeFor(y, fixture.otherExpenseCategory.id),
    ], fixture.sessionUser)).rejects.toBeInstanceOf(management.ImportCategoryMappingConflictError);
    expect(await db.importCategoryMapping.findMany({ where: { householdId: fixture.sessionUser.householdId }, orderBy: { id: "asc" } })).toEqual(before);
    const freshY = before.find(({ id }) => id === y.id)!;
    await expect(management.saveManagedImportCategoryMappings([changeFor(freshY, fixture.otherExpenseCategory.id)], fixture.sessionUser)).resolves.toHaveLength(1);
  });

  it.each(["outside", "unknown", "unsupported", "duplicate", "invalid-version", "forged-version", "empty-category", "missing-category", "wrong-type", "inactive"])(
    "rejects %s input atomically without exposing or modifying other household rules", async (kind) => {
      const fixture = await householdFixture();
      const outside = await householdFixture();
      const rule = await ruleFixture(fixture.sessionUser);
      let invalid: ManagedImportCategoryMappingChange;
      const other = await ruleFixture(outside.sessionUser);
      if (kind === "outside") invalid = changeFor(other, fixture.expenseCategory.id);
      else if (kind === "unsupported") {
        invalid = changeFor(await ruleFixture(fixture.sessionUser, { source: "unsupported" }), fixture.expenseCategory.id);
      } else if (kind === "inactive") {
        const category = await db.category.create({ data: { name: `Inactive ${randomUUID()}`, type: CategoryType.EXPENSE, sortOrder: 999, isActive: false } });
        categoryIds.push(category.id);
        invalid = changeFor(rule, category.id);
      } else {
        invalid = changeFor(rule, fixture.expenseCategory.id);
        if (kind === "unknown") invalid.id = "missing-rule";
        if (kind === "invalid-version") invalid.expectedUpdatedAt = "invalid";
        if (kind === "forged-version") invalid.expectedUpdatedAt = new Date(rule.updatedAt.getTime() + 1).toISOString();
        if (kind === "empty-category") invalid.categoryId = "";
        if (kind === "missing-category") invalid.categoryId = "missing-category";
        if (kind === "wrong-type") invalid.categoryId = fixture.incomeCategory.id;
      }
      const validRule = await ruleFixture(fixture.sessionUser, { primaryCategory: "another group" });
      const changes = [changeFor(validRule, fixture.expenseCategory.id), invalid];
      if (kind === "duplicate") changes.push({ ...invalid });
      const before = await db.importCategoryMapping.findMany({ where: { householdId: { in: [fixture.sessionUser.householdId, outside.sessionUser.householdId] } }, orderBy: { id: "asc" } });
      await expect(management.saveManagedImportCategoryMappings(changes, fixture.sessionUser)).rejects.toThrow();
      expect(await db.importCategoryMapping.findMany({ where: { householdId: { in: [fixture.sessionUser.householdId, outside.sessionUser.householdId] } }, orderBy: { id: "asc" } })).toEqual(before);
    },
  );

  it.each([null, {}, [null], [{ id: "", categoryId: null, expectedUpdatedAt: "2026-01-01T00:00:00.000Z" }],
    [{ id: "id", categoryId: undefined, expectedUpdatedAt: "2026-01-01T00:00:00.000Z" }]])(
    "rejects malformed input %# before performing writes", async (input) => {
      const fixture = await householdFixture();
      const rule = await ruleFixture(fixture.sessionUser);
      await expect(management.saveManagedImportCategoryMappings(input as ManagedImportCategoryMappingChange[], fixture.sessionUser)).rejects.toThrow("Invalid import category mapping changes");
      expect(await db.importCategoryMapping.findUnique({ where: { id: rule.id } })).toEqual(rule);
    },
  );

  it("rolls back all targets and versions after a real second-update database failure and allows a retry", async () => {
    const fixture = await householdFixture();
    const x = await ruleFixture(fixture.sessionUser);
    const y = await ruleFixture(fixture.sessionUser, { primaryCategory: "出行" });
    const ordered = [x, y].sort((a, b) => a.id < b.id ? -1 : 1);
    const before = await db.importCategoryMapping.findMany({ where: { householdId: fixture.sessionUser.householdId }, orderBy: { id: "asc" } });
    await db.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION mapping_management_test_fail() RETURNS trigger AS $$
      BEGIN
        IF NEW."id" = '${ordered[1].id}' THEN RAISE EXCEPTION 'Injected mapping database failure'; END IF;
        RETURN NEW;
      END;
    $$ LANGUAGE plpgsql;`);
    await db.$executeRawUnsafe('CREATE TRIGGER mapping_management_test_fail_trigger BEFORE UPDATE ON "ImportCategoryMapping" FOR EACH ROW EXECUTE FUNCTION mapping_management_test_fail();');
    try {
      await expect(management.saveManagedImportCategoryMappings(ordered.map((rule) => changeFor(rule, fixture.expenseCategory.id)), fixture.sessionUser)).rejects.toThrow();
      expect(await db.importCategoryMapping.findMany({ where: { householdId: fixture.sessionUser.householdId }, orderBy: { id: "asc" } })).toEqual(before);
    } finally {
      await db.$executeRawUnsafe('DROP TRIGGER IF EXISTS mapping_management_test_fail_trigger ON "ImportCategoryMapping";');
      await db.$executeRawUnsafe('DROP FUNCTION IF EXISTS mapping_management_test_fail();');
    }
    await expect(management.saveManagedImportCategoryMappings(ordered.map((rule) => changeFor(rule, fixture.expenseCategory.id)), fixture.sessionUser)).resolves.toHaveLength(2);
    const after = await db.importCategoryMapping.findMany({ where: { householdId: fixture.sessionUser.householdId } });
    expect(after.every(({ categoryId }) => categoryId === fixture.expenseCategory.id)).toBe(true);
    expect(after.every((rule) => rule.updatedAt.getTime() > before.find(({ id }) => id === rule.id)!.updatedAt.getTime())).toBe(true);
  });
});
