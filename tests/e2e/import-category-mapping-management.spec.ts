import { randomUUID } from "node:crypto";

import {
  CategoryType,
  HouseholdRole,
  ImportDraftRowStatus,
  ImportDraftStatus,
  ImportRowDecision,
  PrismaClient,
  TransactionType,
  type ImportCategoryMapping,
} from "@prisma/client";
import { expect, test, type Page, type Route } from "./fixtures";
import ExcelJS from "exceljs";

const managementPath = "/records/import/mappings";
const source = "sui_shou_ji";
const ignoredValue = "__ignore__";
const ignoredReason = "CATEGORY_MAPPING_IGNORED";
const failedMessage = "保存失败，映射选择已保留，请重试。";
const conflictMessage = "映射已被修改，请刷新后重新编辑。";
const unknownMessage = "保存结果暂不确定，请刷新核实。当前选择已保留。";
const workbookHeaders = [
  "交易类型", "日期", "一级分类", "二级分类", "账户1", "账户2", "账户币种", "金额",
  "成员", "商家", "项目分类", "项目", "记账人", "备注",
];

type Fixture = {
  categoryA: string;
  categoryB: string;
  customCategoryIds: string[];
  email: string;
  externalName: string;
  householdId: string;
  ledgerId: string;
  memberId: string;
  prefix: string;
  userId: string;
};

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

function createSafeTestDatabaseClient() {
  const parsedUrl = new URL(requireEnv("DATABASE_URL"));
  const databaseName = parsedUrl.pathname.replace(/^\//, "");
  const hostIsLocal = parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost";

  if (process.env.NODE_ENV === "production" || !hostIsLocal || !/(?:_dev|_test)$/.test(databaseName)) {
    throw new Error("Refusing to create mapping management fixtures in a non-local dev/test database");
  }

  return new PrismaClient();
}

async function createFixture(prisma: PrismaClient): Promise<Fixture> {
  const [seedUser, categoryA, categoryB] = await Promise.all([
    prisma.user.findUniqueOrThrow({ where: { email: requireEnv("SEED_USER_A_EMAIL") } }),
    prisma.category.findFirstOrThrow({ where: { type: CategoryType.EXPENSE, name: "Dining", isActive: true } }),
    prisma.category.findFirstOrThrow({ where: { type: CategoryType.EXPENSE, name: "Transport", isActive: true } }),
  ]);
  const prefix = `mapping-management-${randomUUID()}`;
  const email = `${prefix}@example.com`;
  const household = await prisma.household.create({
    data: {
      name: prefix,
      members: {
        create: {
          role: HouseholdRole.OWNER,
          memberName: "Mapping test member",
          user: { create: { email, displayName: "Mapping test member", passwordHash: seedUser.passwordHash } },
        },
      },
    },
    include: { members: true },
  });
  const member = household.members[0];
  const ledger = await prisma.ledger.create({ data: { householdId: household.id, name: "Default", isDefault: true } });
  const externalName = `${prefix}-member`;
  await prisma.importMemberMapping.create({
    data: { householdId: household.id, memberId: member.id, source, externalName },
  });

  return {
    categoryA: categoryA.id,
    categoryB: categoryB.id,
    customCategoryIds: [],
    email,
    externalName,
    householdId: household.id,
    ledgerId: ledger.id,
    memberId: member.id,
    prefix,
    userId: member.userId,
  };
}

async function cleanFixture(prisma: PrismaClient, fixture: Fixture) {
  await prisma.household.delete({ where: { id: fixture.householdId } });
  await prisma.user.delete({ where: { id: fixture.userId } });
  await prisma.category.deleteMany({ where: { id: { in: fixture.customCategoryIds } } });
}

async function logIn(page: Page, fixture: Fixture) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(fixture.email);
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function createRule(
  prisma: PrismaClient,
  fixture: Fixture,
  secondaryCategory = "X",
  { ruleSource = source, transactionType = TransactionType.EXPENSE, categoryId = fixture.categoryA, primaryCategory = fixture.prefix }:
  { ruleSource?: string; transactionType?: TransactionType; categoryId?: string | null; primaryCategory?: string } = {},
) {
  return prisma.importCategoryMapping.create({
    data: { householdId: fixture.householdId, source: ruleSource, transactionType, primaryCategory, secondaryCategory, categoryId },
  });
}

async function createSnapshotDraft(
  prisma: PrismaClient,
  fixture: Fixture,
  rule: ImportCategoryMapping,
  { completed = false, manuallySkipped = false } = {},
) {
  return prisma.importDraft.create({
    data: {
      householdId: fixture.householdId,
      ledgerId: fixture.ledgerId,
      createdByMemberId: fixture.memberId,
      source,
      fileName: "existing-snapshot.xlsx",
      status: completed ? ImportDraftStatus.COMPLETED : ImportDraftStatus.PENDING,
      completedAt: completed ? new Date() : null,
      rows: {
        create: {
          rowNumber: 1,
          transactionType: TransactionType.EXPENSE,
          occurredAt: new Date("2024-02-03T04:30:00.000Z"),
          occurredDate: "2024-02-03",
          amountFen: 1234,
          actorMemberId: fixture.memberId,
          createdByMemberId: fixture.memberId,
          categoryId: fixture.categoryA,
          primaryCategory: rule.primaryCategory,
          secondaryCategory: rule.secondaryCategory,
          mappingKey: [source, rule.transactionType, rule.primaryCategory, rule.secondaryCategory].join("|"),
          sourceFingerprint: randomUUID(),
          status: manuallySkipped ? ImportDraftRowStatus.USER_SKIPPED : ImportDraftRowStatus.READY,
          userDecision: manuallySkipped ? ImportRowDecision.SKIP : ImportRowDecision.KEEP,
          skipReason: manuallySkipped ? "User skipped" : null,
          duplicateCandidates: [],
        },
      },
    },
  });
}

function ruleSelect(page: Page, rule: Pick<ImportCategoryMapping, "id">) {
  return page.locator(`#managed-import-mappings select[name="managed-mapping:${rule.id}"]`);
}

function ruleArticle(page: Page, rule: Pick<ImportCategoryMapping, "id">) {
  return page.locator(`article[data-managed-mapping-id="${rule.id}"]`);
}

async function openManagement(page: Page, heading = "管理分类映射") {
  await page.goto(managementPath);
  await expect(page.getByRole("heading", { name: heading, exact: true })).toBeVisible();
}

async function saveManagement(page: Page, button = "保存修改") {
  await page.getByRole("button", { name: button, exact: true }).click();
}

async function refreshManagement(page: Page) {
  await Promise.all([
    page.waitForEvent("load"),
    page.getByRole("button", { name: "刷新映射", exact: true }).click(),
  ]);
}

async function readRule(prisma: PrismaClient, rule: Pick<ImportCategoryMapping, "id">) {
  return prisma.importCategoryMapping.findUniqueOrThrow({ where: { id: rule.id } });
}

async function expectRuleCategory(prisma: PrismaClient, rule: ImportCategoryMapping, categoryId: string | null) {
  await expect.poll(async () => (await readRule(prisma, rule)).categoryId).toBe(categoryId);
}

async function uploadFutureDraft(page: Page, fixture: Fixture, rule: ImportCategoryMapping) {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("支出").addRows([
    workbookHeaders,
    ["支出", "2024-03-04 12:00:00", rule.primaryCategory, rule.secondaryCategory, "现金", "", "CNY", "67.89",
      fixture.externalName, "小店", "", "", fixture.externalName, randomUUID()],
  ]);
  workbook.addWorksheet("收入").addRows([workbookHeaders]);
  await page.goto("/records/import");
  await page.getByLabel("随手记", { exact: true }).check();
  await page.getByLabel("文件", { exact: true }).setInputFiles({
    name: "future-mapping.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
  });
  await page.getByRole("button", { name: "上传并解析", exact: true }).click();
  await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("draft")));
  return new URL(page.url()).searchParams.get("draft")!;
}

test("management is reachable without uploading and from pending or completed imports", async ({ page }) => {
  const prisma = createSafeTestDatabaseClient();
  const fixture = await createFixture(prisma);

  try {
    await logIn(page, fixture);
    await page.goto("/records/import");
    await page.getByRole("link", { name: "管理分类映射", exact: true }).click();
    await expect(page).toHaveURL(managementPath);
    await expect(page.getByRole("heading", { name: "管理分类映射", exact: true })).toBeVisible();
    await expect(page.locator("#managed-import-mappings")).toHaveCount(0);
    await expect(page.getByText("尚无保存的分类映射。导入文件并保存分类映射后，规则会出现在这里。", { exact: true })).toBeVisible();
    expect(await prisma.importDraft.count({ where: { householdId: fixture.householdId } })).toBe(0);
    await page.getByRole("link", { name: "返回导入记录", exact: true }).click();
    await expect(page).toHaveURL("/records/import");

    const rule = await createRule(prisma, fixture);
    const pending = await createSnapshotDraft(prisma, fixture, rule);
    const completed = await createSnapshotDraft(prisma, fixture, rule, { completed: true });
    for (const draft of [pending, completed]) {
      await page.goto(`/records/import?draft=${draft.id}`);
      await expect(page.getByRole("heading", { name: draft.status === ImportDraftStatus.PENDING ? "导入复核" : "导入已完成", exact: true })).toBeVisible();
      await page.getByRole("link", { name: "管理分类映射", exact: true }).click();
      await expect(page).toHaveURL(managementPath);
      await expect(ruleSelect(page, rule)).toHaveValue(fixture.categoryA);
    }
  } finally {
    await cleanFixture(prisma, fixture);
    await prisma.$disconnect();
  }
});

test("all four sources show saved targets including ignored, empty and inactive classifications", async ({ page }) => {
  const prisma = createSafeTestDatabaseClient();
  const fixture = await createFixture(prisma);

  try {
    const inactiveCategory = await prisma.category.create({
      data: { type: CategoryType.EXPENSE, name: `${fixture.prefix}-inactive`, sortOrder: 9000, isActive: false },
    });
    fixture.customCategoryIds.push(inactiveCategory.id);
    const income = await prisma.category.findFirstOrThrow({ where: { type: CategoryType.INCOME, name: "Salary", isActive: true } });
    const rules = await Promise.all([
      createRule(prisma, fixture),
      createRule(prisma, fixture, "", { ruleSource: "wechat_pay", categoryId: null }),
      createRule(prisma, fixture, "Income", { ruleSource: "alipay", transactionType: TransactionType.INCOME, categoryId: income.id }),
      createRule(prisma, fixture, "", { ruleSource: "cmb", categoryId: inactiveCategory.id, primaryCategory: "" }),
    ]);
    await logIn(page, fixture);
    await openManagement(page);
    for (const [index, sourceName] of ["随手记", "微信支付", "支付宝", "招商银行"].entries()) {
      await expect(page.getByRole("heading", { name: `${sourceName} · ${index === 2 ? "收入" : "支出"}`, exact: true })).toBeVisible();
      await expect(ruleSelect(page, rules[index])).toHaveAttribute("aria-label", new RegExp(sourceName));
    }
    await expect(ruleArticle(page, rules[0])).toContainText(`${fixture.prefix}`);
    await expect(ruleSelect(page, rules[0]).locator("option:checked")).toHaveText("餐饮");
    await expect(ruleSelect(page, rules[1]).locator("option:checked")).toHaveText("忽略");
    await expect(ruleSelect(page, rules[2]).locator("option:checked")).toHaveText("工资");
    await expect(ruleSelect(page, rules[2]).locator(`option[value="${fixture.categoryA}"]`)).toHaveCount(0);
    await expect(ruleArticle(page, rules[3])).toContainText(inactiveCategory.name);
    await expect(ruleArticle(page, rules[3])).toContainText("已停用");
    await expect(ruleArticle(page, rules[3]).getByText("未提供", { exact: true })).toHaveCount(2);
    await expect(ruleSelect(page, rules[3]).locator(`option[value="${inactiveCategory.id}"]`)).toBeDisabled();
    await expect(ruleSelect(page, rules[0]).locator(`option[value="${inactiveCategory.id}"]`)).toHaveCount(0);
    await ruleSelect(page, rules[3]).selectOption(fixture.categoryB);
    await saveManagement(page);
    await expectRuleCategory(prisma, rules[3], fixture.categoryB);
    await page.reload();
    await expect(ruleSelect(page, rules[3]).locator("option:checked")).toHaveText("交通");
  } finally {
    await cleanFixture(prisma, fixture);
    await prisma.$disconnect();
  }
});

test("source, type and keyword filters compose immediately and can be cleared", async ({ page }) => {
  const prisma = createSafeTestDatabaseClient();
  const fixture = await createFixture(prisma);

  try {
    const salary = await prisma.category.findFirstOrThrow({ where: { type: CategoryType.INCOME, name: "Salary", isActive: true } });
    const rules = await Promise.all([
      createRule(prisma, fixture, "面包", { primaryCategory: "早餐" }),
      createRule(prisma, fixture, "咖啡", { ruleSource: "wechat_pay", primaryCategory: "早餐", categoryId: fixture.categoryB }),
      createRule(prisma, fixture, "面包", { ruleSource: "alipay", primaryCategory: "早餐" }),
      createRule(prisma, fixture, "工资到账", {
        ruleSource: "alipay", transactionType: TransactionType.INCOME, primaryCategory: "职业收入", categoryId: salary.id,
      }),
    ]);
    await logIn(page, fixture);
    await openManagement(page);
    const keyword = page.getByLabel("关键词", { exact: true });
    const visibleRules = page.locator("article[data-managed-mapping-id]");
    await expect(page.getByText("显示 4 / 4 条映射", { exact: true })).toBeVisible();

    await page.getByLabel("来源", { exact: true }).selectOption({ label: "支付宝" });
    await expect(page.getByText("显示 2 / 4 条映射", { exact: true })).toBeVisible();
    await page.getByLabel("收支类型", { exact: true }).selectOption({ label: "支出" });
    await expect(page.getByText("显示 1 / 4 条映射", { exact: true })).toBeVisible();
    for (const query of ["早餐", "面包", "餐饮"]) {
      await keyword.fill(query);
      await expect(visibleRules).toHaveCount(1);
      await expect(ruleArticle(page, rules[2])).toBeVisible();
    }
    await keyword.fill("工资到账");
    await expect(visibleRules).toHaveCount(0);
    await expect(page.getByText("显示 0 / 4 条映射", { exact: true })).toBeVisible();
    await expect(page.getByText("没有符合筛选条件的分类映射。", { exact: true })).toBeVisible();

    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await expect(keyword).toHaveValue("");
    await expect(visibleRules).toHaveCount(4);
    await expect(page.getByText("显示 4 / 4 条映射", { exact: true })).toBeVisible();
    await page.getByLabel("来源", { exact: true }).selectOption({ label: "支付宝" });
    await page.getByLabel("收支类型", { exact: true }).selectOption({ label: "收入" });
    await keyword.fill("工资");
    await expect(visibleRules).toHaveCount(1);
    await expect(ruleArticle(page, rules[3])).toBeVisible();
  } finally {
    await cleanFixture(prisma, fixture);
    await prisma.$disconnect();
  }
});

test("filter changes preserve hidden edits and keyword Enter never saves them", async ({ page }) => {
  const prisma = createSafeTestDatabaseClient();
  const fixture = await createFixture(prisma);

  try {
    const [ruleX, ruleY, untouched] = await Promise.all([
      createRule(prisma, fixture),
      createRule(prisma, fixture, "Y", { ruleSource: "wechat_pay" }),
      createRule(prisma, fixture, "Z", { ruleSource: "alipay" }),
    ]);
    const beforeUntouched = await readRule(prisma, untouched);
    await logIn(page, fixture);
    await openManagement(page);
    const keyword = page.getByLabel("关键词", { exact: true });
    const actions = page.getByTestId("managed-mapping-actions");
    await page.getByLabel("来源", { exact: true }).selectOption({ label: "随手记" });
    await keyword.fill("餐饮");
    await ruleSelect(page, ruleX).selectOption(fixture.categoryB);
    await expect(ruleSelect(page, ruleX)).toHaveValue(fixture.categoryB);
    await expect(page.getByText("显示 1 / 3 条映射", { exact: true })).toBeVisible();
    await keyword.fill("交通");
    await expect(page.locator("article[data-managed-mapping-id]")).toHaveCount(0);
    await expect(actions).toContainText("1 条未保存修改（含 1 条隐藏项）");

    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await page.getByLabel("来源", { exact: true }).selectOption({ label: "微信支付" });
    await ruleSelect(page, ruleY).selectOption(ignoredValue);
    await keyword.fill("no-matching-rule");
    await expect(page.getByText("没有符合筛选条件的分类映射。", { exact: true })).toBeVisible();
    await expect(actions).toContainText("2 条未保存修改（含 2 条隐藏项）");

    const unexpectedSave = page.waitForRequest((request) =>
      request.method() === "POST" && Boolean(request.headers()["next-action"]),
    { timeout: 500 }).then(() => true, () => false);
    await keyword.press("Enter");
    expect(await unexpectedSave).toBe(false);
    expect(await readRule(prisma, ruleX)).toEqual(ruleX);
    expect(await readRule(prisma, ruleY)).toEqual(ruleY);

    await page.getByRole("button", { name: "清除筛选", exact: true }).click();
    await expect(ruleSelect(page, ruleX)).toHaveValue(fixture.categoryB);
    await expect(ruleSelect(page, ruleY)).toHaveValue(ignoredValue);
    await expect(actions).toContainText("2 条未保存修改");
    await keyword.fill("no-matching-rule");
    await expect(page.locator("article[data-managed-mapping-id]")).toHaveCount(0);
    await expect(page.getByRole("button", { name: "保存修改", exact: true })).toHaveCount(1);
    await saveManagement(page);
    await expectRuleCategory(prisma, ruleX, fixture.categoryB);
    await expectRuleCategory(prisma, ruleY, null);
    expect(await readRule(prisma, untouched)).toEqual(beforeUntouched);
    await expect(actions).toContainText("0 条未保存修改");
    await page.reload();
    await expect(ruleSelect(page, ruleX)).toHaveValue(fixture.categoryB);
    await expect(ruleSelect(page, ruleY)).toHaveValue(ignoredValue);
  } finally {
    await cleanFixture(prisma, fixture);
    await prisma.$disconnect();
  }
});

for (const viewport of [{ width: 1280, height: 900 }, { width: 390, height: 844 }]) {
  test(`long-list save remains visible without covering rows or navigation at ${viewport.width}px`, async ({ page }, testInfo) => {
    const prisma = createSafeTestDatabaseClient();
    const fixture = await createFixture(prisma);

    try {
      await prisma.importCategoryMapping.createMany({
        data: Array.from({ length: 24 }, (_, index) => ({
          householdId: fixture.householdId, source, transactionType: TransactionType.EXPENSE,
          primaryCategory: fixture.prefix, secondaryCategory: `A${String(index).padStart(2, "0")}`, categoryId: fixture.categoryA,
        })),
      });
      const lastRule = await createRule(prisma, fixture, "Z-final");
      await page.setViewportSize(viewport);
      await logIn(page, fixture);
      await openManagement(page);
      await ruleSelect(page, lastRule).selectOption(fixture.categoryB);
      const save = page.getByRole("button", { name: "保存修改", exact: true });
      const actions = page.getByTestId("managed-mapping-actions");
      await expect(save).toHaveCount(1);
      const scrollRange = await page.evaluate(() => document.documentElement.scrollHeight - window.innerHeight);
      expect(scrollRange).toBeGreaterThan(viewport.height);

      for (const fraction of [0, 0.5, 1]) {
        await page.evaluate((top) => window.scrollTo({ top, behavior: "instant" }), scrollRange * fraction);
        await expect(save).toBeInViewport({ ratio: 1 });
        if (viewport.width < 768) {
          const navigation = page.getByRole("navigation", { name: "主要导航", exact: true });
          const actionsBox = await actions.boundingBox();
          const navigationBox = await navigation.boundingBox();
          expect(actionsBox).not.toBeNull();
          expect(navigationBox).not.toBeNull();
          expect(actionsBox!.y + actionsBox!.height).toBeLessThanOrEqual(navigationBox!.y);
        }
        if (fraction !== 0.5) {
          await page.screenshot({ path: testInfo.outputPath(`mappings-${fraction === 0 ? "top" : "bottom"}.png`) });
        }
      }
      const lastRowBox = await ruleArticle(page, lastRule).boundingBox();
      const actionsBox = await actions.boundingBox();
      expect(lastRowBox).not.toBeNull();
      expect(actionsBox).not.toBeNull();
      expect(lastRowBox!.y + lastRowBox!.height).toBeLessThanOrEqual(actionsBox!.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      await saveManagement(page);
      await expectRuleCategory(prisma, lastRule, fixture.categoryB);
    } finally {
      await cleanFixture(prisma, fixture);
      await prisma.$disconnect();
    }
  });
}

test("category changes and ignore restoration affect future uploads while preserving all existing financial snapshots", async ({ page }) => {
  test.setTimeout(60_000);
  const prisma = createSafeTestDatabaseClient();
  const fixture = await createFixture(prisma);

  try {
    const rule = await createRule(prisma, fixture);
    const drafts = await Promise.all([
      createSnapshotDraft(prisma, fixture, rule),
      createSnapshotDraft(prisma, fixture, rule, { manuallySkipped: true }),
      createSnapshotDraft(prisma, fixture, rule, { completed: true }),
    ]);
    const transactionIds: string[] = [];
    for (const deleted of [false, true]) {
      const transaction = await prisma.transaction.create({
        data: {
          householdId: fixture.householdId, ledgerId: fixture.ledgerId, type: TransactionType.EXPENSE, actorMemberId: fixture.memberId,
          createdByMemberId: fixture.memberId, categoryId: fixture.categoryA, amountFen: 1234,
          occurredAt: new Date("2024-02-03T04:30:00.000Z"), source, sourceFingerprint: randomUUID(),
          sourceImportedAt: new Date(), deletedAt: deleted ? new Date() : null,
        },
      });
      transactionIds.push(transaction.id);
    }
    const readSnapshots = async () => ({
      drafts: await prisma.importDraft.findMany({ where: { id: { in: drafts.map((draft) => draft.id) } }, include: { rows: true }, orderBy: { id: "asc" } }),
      transactions: await prisma.transaction.findMany({ where: { id: { in: transactionIds } }, orderBy: { id: "asc" } }),
    });
    const before = await readSnapshots();
    await logIn(page, fixture);
    await page.goto(`/records/import?draft=${drafts[0].id}`);
    await page.getByRole("link", { name: "管理分类映射", exact: true }).click();

    for (const target of [fixture.categoryB, null, fixture.categoryA]) {
      await ruleSelect(page, rule).selectOption(target ?? ignoredValue);
      await saveManagement(page);
      await expectRuleCategory(prisma, rule, target);
      await page.reload();
      await expect(ruleSelect(page, rule)).toHaveValue(target ?? ignoredValue);
      const futureDraftId = await uploadFutureDraft(page, fixture, rule);
      const row = await prisma.importDraftRow.findFirstOrThrow({ where: { draftId: futureDraftId } });
      expect(row.categoryId).toBe(target);
      expect(row.status).toBe(target === null ? ImportDraftRowStatus.USER_SKIPPED : ImportDraftRowStatus.READY);
      expect(row.userDecision).toBe(target === null ? ImportRowDecision.SKIP : ImportRowDecision.KEEP);
      expect(row.skipReason).toBe(target === null ? ignoredReason : null);
      expect(await readSnapshots()).toEqual(before);
      await openManagement(page);
    }
  } finally {
    await cleanFixture(prisma, fixture);
    await prisma.$disconnect();
  }
});

test("unchanged and restored selections do not republish rules or block edits to another group", async ({ page, context }) => {
  const prisma = createSafeTestDatabaseClient();
  const fixture = await createFixture(prisma);

  try {
    const ruleX = await createRule(prisma, fixture);
    const ruleY = await createRule(prisma, fixture, "Y");
    await logIn(page, fixture);
    await openManagement(page);
    const otherPage = await context.newPage();
    await openManagement(otherPage);
    await ruleSelect(otherPage, ruleX).selectOption(ignoredValue);
    await saveManagement(otherPage);
    await expectRuleCategory(prisma, ruleX, null);
    const changedX = await readRule(prisma, ruleX);
    const originalY = await readRule(prisma, ruleY);
    await otherPage.close();

    await saveManagement(page);
    expect(await readRule(prisma, ruleX)).toEqual(changedX);
    expect(await readRule(prisma, ruleY)).toEqual(originalY);
    await ruleSelect(page, ruleX).selectOption(fixture.categoryB);
    await ruleSelect(page, ruleX).selectOption(fixture.categoryA);
    await saveManagement(page);
    expect(await readRule(prisma, ruleX)).toEqual(changedX);
    expect(await readRule(prisma, ruleY)).toEqual(originalY);

    await ruleSelect(page, ruleY).selectOption(fixture.categoryB);
    await saveManagement(page);
    await expectRuleCategory(prisma, ruleY, fixture.categoryB);
    expect(await readRule(prisma, ruleX)).toEqual(changedX);
    await expect(page.getByText(conflictMessage, { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(ruleSelect(page, ruleX)).toHaveValue(ignoredValue);
    await expect(ruleSelect(page, ruleY)).toHaveValue(fixture.categoryB);
  } finally {
    await cleanFixture(prisma, fixture);
    await prisma.$disconnect();
  }
});

test("conflicting management pages cannot overwrite a rule or partially save another rule and can edit after refresh", async ({ page, context }) => {
  const prisma = createSafeTestDatabaseClient();
  const fixture = await createFixture(prisma);

  try {
    const ruleX = await createRule(prisma, fixture);
    const ruleY = await createRule(prisma, fixture, "Y");
    await logIn(page, fixture);
    await openManagement(page);
    const otherPage = await context.newPage();
    await openManagement(otherPage);
    await ruleSelect(otherPage, ruleX).selectOption(ignoredValue);
    await saveManagement(otherPage);
    await expectRuleCategory(prisma, ruleX, null);
    const changedX = await readRule(prisma, ruleX);
    const originalY = await readRule(prisma, ruleY);
    await otherPage.close();

    await ruleSelect(page, ruleX).selectOption(fixture.categoryB);
    await ruleSelect(page, ruleY).selectOption(ignoredValue);
    await saveManagement(page);
    await expect(page.getByText(conflictMessage, { exact: true })).toBeVisible();
    await expect(ruleSelect(page, ruleX)).toHaveValue(fixture.categoryB);
    await expect(ruleSelect(page, ruleY)).toHaveValue(ignoredValue);
    await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeDisabled();
    expect(await readRule(prisma, ruleX)).toEqual(changedX);
    expect(await readRule(prisma, ruleY)).toEqual(originalY);
    await refreshManagement(page);
    await expect(ruleSelect(page, ruleX)).toHaveValue(ignoredValue);
    await expect(ruleSelect(page, ruleY)).toHaveValue(fixture.categoryA);
    await ruleSelect(page, ruleX).selectOption(fixture.categoryB);
    await ruleSelect(page, ruleY).selectOption(ignoredValue);
    await saveManagement(page);
    await expectRuleCategory(prisma, ruleX, fixture.categoryB);
    await expectRuleCategory(prisma, ruleY, null);
    await expect(page.getByText(conflictMessage, { exact: true })).toHaveCount(0);
  } finally {
    await cleanFixture(prisma, fixture);
    await prisma.$disconnect();
  }
});

test("an existing draft mapping save also invalidates the old management page version", async ({ page, context }) => {
  const prisma = createSafeTestDatabaseClient();
  const fixture = await createFixture(prisma);

  try {
    const rule = await createRule(prisma, fixture);
    const draft = await createSnapshotDraft(prisma, fixture, rule);
    await prisma.importDraftRow.updateMany({
      where: { draftId: draft.id },
      data: { categoryId: null, status: ImportDraftRowStatus.NEEDS_MAPPING },
    });
    await logIn(page, fixture);
    await openManagement(page);
    const draftPage = await context.newPage();
    await draftPage.goto(`/records/import?draft=${draft.id}`);
    const draftForm = draftPage.locator("form", {
      has: draftPage.getByRole("heading", { name: "分类映射", exact: true }),
    });
    await draftForm.getByRole("combobox").selectOption(fixture.categoryB);
    await draftForm.getByRole("button", { name: "保存映射", exact: true }).click();
    await expectRuleCategory(prisma, rule, fixture.categoryB);
    await expect.poll(async () => (await prisma.importDraftRow.findFirstOrThrow({ where: { draftId: draft.id } })).categoryId).toBe(fixture.categoryB);
    const draftSavedRule = await readRule(prisma, rule);
    await draftPage.close();
    await ruleSelect(page, rule).selectOption(ignoredValue);
    await saveManagement(page);
    await expect(page.getByText(conflictMessage, { exact: true })).toBeVisible();
    expect(await readRule(prisma, rule)).toEqual(draftSavedRule);
    await refreshManagement(page);
    await expect(ruleSelect(page, rule)).toHaveValue(fixture.categoryB);
  } finally {
    await cleanFixture(prisma, fixture);
    await prisma.$disconnect();
  }
});

test("a definite validation failure preserves choices for retry without republishing an unchanged concurrent rule", async ({ page, context }) => {
  const prisma = createSafeTestDatabaseClient();
  const fixture = await createFixture(prisma);

  try {
    const ruleX = await createRule(prisma, fixture);
    const ruleY = await createRule(prisma, fixture, "Y");
    const retryCategory = await prisma.category.create({
      data: { type: CategoryType.EXPENSE, name: `${fixture.prefix}-retry`, sortOrder: 9000, isActive: true },
    });
    fixture.customCategoryIds.push(retryCategory.id);
    await logIn(page, fixture);
    await openManagement(page);
    await ruleSelect(page, ruleY).selectOption(retryCategory.id);
    await prisma.category.update({ where: { id: retryCategory.id }, data: { isActive: false } });
    const originalY = await readRule(prisma, ruleY);
    await saveManagement(page);
    await expect(page.getByText(failedMessage, { exact: true })).toBeVisible();
    await expect(ruleSelect(page, ruleY)).toHaveValue(retryCategory.id);
    await expect(ruleSelect(page, ruleX)).toHaveValue(fixture.categoryA);
    expect(await readRule(prisma, ruleY)).toEqual(originalY);

    const otherPage = await context.newPage();
    await openManagement(otherPage);
    await ruleSelect(otherPage, ruleX).selectOption(ignoredValue);
    await saveManagement(otherPage);
    await expectRuleCategory(prisma, ruleX, null);
    const changedX = await readRule(prisma, ruleX);
    await otherPage.close();
    await prisma.category.update({ where: { id: retryCategory.id }, data: { isActive: true } });
    await saveManagement(page);
    await expectRuleCategory(prisma, ruleY, retryCategory.id);
    expect(await readRule(prisma, ruleX)).toEqual(changedX);
    await expect(page.getByText(failedMessage, { exact: true })).toHaveCount(0);
    await page.reload();
    await expect(ruleSelect(page, ruleY)).toHaveValue(retryCategory.id);
    await expect(ruleSelect(page, ruleX)).toHaveValue(ignoredValue);
  } finally {
    await cleanFixture(prisma, fixture);
    await prisma.$disconnect();
  }
});

test("a committed save with a lost response remains unknown until an explicit refresh verifies it", async ({ page }) => {
  const prisma = createSafeTestDatabaseClient();
  const fixture = await createFixture(prisma);

  try {
    const rule = await createRule(prisma, fixture);
    await logIn(page, fixture);
    await openManagement(page);
    await ruleSelect(page, rule).selectOption(ignoredValue);
    let submittedActions = 0;
    const loseActionResponse = async (route: Route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
        submittedActions += 1;
        const response = await route.fetch();
        expect(response.ok()).toBe(true);
        await route.abort("failed");
      } else {
        await route.continue();
      }
    };
    await page.route("**/records/import/mappings**", loseActionResponse);
    await saveManagement(page);
    await expectRuleCategory(prisma, rule, null);
    const committed = await readRule(prisma, rule);
    await expect(page.getByText(unknownMessage, { exact: true })).toBeVisible();
    await expect(ruleSelect(page, rule)).toHaveValue(ignoredValue);
    await expect(page.getByRole("button", { name: "保存修改", exact: true })).toBeDisabled();
    await page.unroute("**/records/import/mappings**", loseActionResponse);
    await refreshManagement(page);
    await expect(ruleSelect(page, rule)).toHaveValue(ignoredValue);
    await expect(page.getByText(unknownMessage, { exact: true })).toHaveCount(0);
    expect(submittedActions).toBe(1);
    expect(await readRule(prisma, rule)).toEqual(committed);
    await ruleSelect(page, rule).selectOption(fixture.categoryB);
    await saveManagement(page);
    await expectRuleCategory(prisma, rule, fixture.categoryB);
  } finally {
    await cleanFixture(prisma, fixture);
    await prisma.$disconnect();
  }
});

test("English mapping management remains usable on a mobile viewport", async ({ page }) => {
  const prisma = createSafeTestDatabaseClient();
  const fixture = await createFixture(prisma);

  try {
    const rule = await createRule(prisma, fixture);
    await page.setViewportSize({ width: 390, height: 844 });
    await logIn(page, fixture);
    await page.goto("/records/import");
    await page.getByRole("button", { name: "更多选项", exact: true }).click();
    if (!await page.getByRole("button", { name: "切换语言", exact: true }).first().isVisible()) {
      await page.getByRole("button", { name: "更多选项", exact: true }).first().click();
    }
    await page.getByRole("button", { name: "切换语言", exact: true }).first().click();
    await page.getByRole("link", { name: "Manage category mappings", exact: true }).click();
    await expect(page.getByRole("heading", { name: "Manage category mappings", exact: true })).toBeVisible();
    await page.getByLabel("Source", { exact: true }).selectOption({ label: "Sui Shou Ji" });
    await page.getByLabel("Transaction type", { exact: true }).selectOption({ label: "Expense" });
    await page.getByLabel("Keyword", { exact: true }).fill("Dining");
    await expect(page.getByText("Showing 1 of 1 mappings", { exact: true })).toBeVisible();
    await expect(ruleSelect(page, rule).locator("option:checked")).toHaveText("Dining");
    await page.getByLabel("Keyword", { exact: true }).fill("no-matching-rule");
    await expect(page.getByText("Showing 0 of 1 mappings", { exact: true })).toBeVisible();
    await expect(page.getByText("No category mappings match these filters.", { exact: true })).toBeVisible();
    await page.getByRole("button", { name: "Clear filters", exact: true }).click();
    await expect(page.getByLabel("Keyword", { exact: true })).toHaveValue("");
    await ruleSelect(page, rule).selectOption({ label: "Ignore" });
    await saveManagement(page, "Save changes");
    await expectRuleCategory(prisma, rule, null);
    await expect(page.getByText("Mappings saved", { exact: true })).toBeVisible();
    await page.reload();
    await expect(ruleSelect(page, rule).locator("option:checked")).toHaveText("Ignore");
    const viewport = await page.evaluate(() => ({ scrollWidth: document.documentElement.scrollWidth, width: window.innerWidth }));
    expect(viewport.scrollWidth).toBeLessThanOrEqual(viewport.width);
    await page.getByRole("link", { name: "Back to import records", exact: true }).click();
    await expect(page).toHaveURL("/records/import");
  } finally {
    await cleanFixture(prisma, fixture);
    await prisma.$disconnect();
  }
});
