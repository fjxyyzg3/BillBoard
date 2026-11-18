import { randomUUID } from "node:crypto";

import {
  CategoryType,
  ImportDraftRowStatus,
  ImportDraftStatus,
  ImportRowDecision,
  PrismaClient,
  TransactionType,
} from "@prisma/client";
import { expect, test, type Page, type Route } from "./fixtures";
import ExcelJS from "exceljs";

const source = "sui_shou_ji";
const ignoredReason = "CATEGORY_MAPPING_IGNORED";
const headers = [
  "交易类型", "日期", "一级分类", "二级分类", "账户1", "账户2", "账户币种", "金额",
  "成员", "商家", "项目分类", "项目", "记账人", "备注",
];

type MappingGroup = { primaryCategory: string; secondaryCategory: string };
type Fixture = {
  categoryId: string;
  externalName: string;
  groupX: MappingGroup;
  groupY: MappingGroup;
  householdId: string;
  ledgerId: string;
  memberId: string;
  prefix: string;
};

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

function createSafeTestDatabaseClient() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Import category fixtures must not run with NODE_ENV=production");
  }

  const parsedUrl = new URL(requireEnv("DATABASE_URL"));
  const databaseName = parsedUrl.pathname.replace(/^\//, "");
  const hostIsLocal = parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost";

  if (!hostIsLocal || !/(?:dev|test)/i.test(databaseName)) {
    throw new Error("Refusing to create import category fixtures in a non-dev/test database");
  }

  return new PrismaClient();
}

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function createFixture(prisma: PrismaClient): Promise<Fixture> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: requireEnv("SEED_USER_A_EMAIL") },
    include: { householdMember: true },
  });
  const member = user.householdMember.find((entry) => entry.leftAt === null);

  if (!member) {
    throw new Error("Seeded user must belong to a household");
  }
  const ledger = await prisma.ledger.findFirstOrThrow({ where: { householdId: member.householdId, isDefault: true, archivedAt: null } });

  const category = await prisma.category.findFirstOrThrow({
    where: { type: CategoryType.EXPENSE, name: "Dining", isActive: true },
  });
  const prefix = `ignore-e2e-${randomUUID()}`;
  const externalName = `${prefix}-member`;
  await prisma.importMemberMapping.create({
    data: { externalName, householdId: member.householdId, memberId: member.id, source },
  });

  return {
    categoryId: category.id,
    externalName,
    groupX: { primaryCategory: prefix, secondaryCategory: "X" },
    groupY: { primaryCategory: prefix, secondaryCategory: "Y" },
    householdId: member.householdId,
    ledgerId: ledger.id,
    memberId: member.id,
    prefix,
  };
}

async function createDraft(
  prisma: PrismaClient,
  fixture: Fixture,
  { xCount = 1, yCount = 0, ignoredX = false, manualSkip = false, unresolvedX = false } = {},
) {
  const draft = await prisma.importDraft.create({
    data: { householdId: fixture.householdId, ledgerId: fixture.ledgerId, createdByMemberId: fixture.memberId, source, fileName: "sui_shou_ji.xlsx" },
  });
  const rowIds = Array.from({ length: xCount + yCount + Number(manualSkip) }, () => randomUUID());
  await prisma.importDraftRow.createMany({
    data: rowIds.map((id, index) => {
      const isManualSkip = manualSkip && index === rowIds.length - 1;
      const isX = index < xCount || isManualSkip;
      const group = isX ? fixture.groupX : fixture.groupY;
      const isIgnored = isX && ignoredX && !isManualSkip;

      return {
        id,
        draftId: draft.id,
        rowNumber: index + 1,
        transactionType: TransactionType.EXPENSE,
        occurredAt: new Date("2024-02-03T04:30:00.000Z"),
        occurredDate: "2024-02-03",
        amountFen: 1234 + index,
        actorMemberId: fixture.memberId,
        createdByMemberId: fixture.memberId,
        actorExternalName: unresolvedX && isX ? `${fixture.prefix}-unresolved` : null,
        actorFallbackApplied: unresolvedX && isX,
        categoryId: isManualSkip ? fixture.categoryId : null,
        ...group,
        mappingKey: [source, TransactionType.EXPENSE, group.primaryCategory, group.secondaryCategory].join("|"),
        sourceFingerprint: `${fixture.prefix}-${draft.id}-${index}`,
        note: `Ignore fixture ${index + 1}`,
        status: isIgnored || isManualSkip ? ImportDraftRowStatus.USER_SKIPPED : ImportDraftRowStatus.NEEDS_MAPPING,
        userDecision: isIgnored || isManualSkip ? ImportRowDecision.SKIP : ImportRowDecision.KEEP,
        skipReason: isManualSkip ? "User skipped" : isIgnored ? ignoredReason : null,
        duplicateCandidates: [],
      };
    }),
  });

  return { draftId: draft.id, rowIds };
}

async function createIgnoredRule(prisma: PrismaClient, fixture: Fixture) {
  await prisma.importCategoryMapping.create({
    data: { ...fixture.groupX, householdId: fixture.householdId, source, transactionType: TransactionType.EXPENSE, categoryId: null },
  });
}

function ruleWhere(fixture: Fixture, group: MappingGroup) {
  return { ...group, householdId: fixture.householdId, source, transactionType: TransactionType.EXPENSE };
}

function mappingForm(page: Page, heading = "分类映射") {
  return page.locator("form", { has: page.getByRole("heading", { name: heading, exact: true }) });
}

function groupSelect(page: Page, group: MappingGroup, heading = "分类映射") {
  return mappingForm(page, heading).locator("label", {
    hasText: `${group.primaryCategory} / ${group.secondaryCategory}`,
  }).getByRole("combobox", { includeHidden: true });
}

async function openProcessedMappings(page: Page) {
  const processed = page.getByTestId("import-processed-mappings");
  if (await processed.count() > 0 && !await processed.evaluate((element) => element.hasAttribute("open"))) {
    await processed.locator("summary").click();
  }
}

async function openDraft(page: Page, draftId: string) {
  await page.goto(`/records/import?draft=${draftId}`);
  await expect(page.getByRole("heading", { name: "导入复核", exact: true })).toBeVisible();
  await openProcessedMappings(page);
}

async function saveMappings(page: Page) {
  await mappingForm(page).getByRole("button", { name: "保存映射", exact: true }).click();
}

async function expectIgnoredRows(prisma: PrismaClient, rowIds: string[]) {
  await expect.poll(async () => {
    const rows = await prisma.importDraftRow.findMany({ where: { id: { in: rowIds } } });
    return rows.length === rowIds.length && rows.every((row) =>
      row.status === ImportDraftRowStatus.USER_SKIPPED &&
      row.userDecision === ImportRowDecision.SKIP && row.skipReason === ignoredReason && row.categoryId === null,
    );
  }).toBe(true);
}

async function uploadFutureDraft(page: Page, fixture: Fixture) {
  const workbook = new ExcelJS.Workbook();
  workbook.addWorksheet("支出").addRows([
    headers,
    ["支出", "2024-03-04 12:00:00", fixture.groupX.primaryCategory, fixture.groupX.secondaryCategory,
      "现金", "", "CNY", "67.89", fixture.externalName, "小店", "", "", fixture.externalName, randomUUID()],
  ]);
  workbook.addWorksheet("收入").addRows([headers]);
  await page.goto("/records/import");
  await page.getByLabel("随手记", { exact: true }).check();
  await page.getByLabel("文件", { exact: true }).setInputFiles({
    name: "category-ignore.xlsx",
    mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
    buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
  });
  await page.getByRole("button", { name: "上传并解析", exact: true }).click();
  await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("draft")));
  return new URL(page.url()).searchParams.get("draft")!;
}

for (const reopenB of [false, true]) {
  test(`an unchanged ignored group cannot overwrite a revoked household rule in ${reopenB ? "a reopened" : "an already open"} draft`, async ({ page, context }) => {
    const prisma = createSafeTestDatabaseClient();

    try {
      const fixture = await createFixture(prisma);
      await createIgnoredRule(prisma, fixture);
      const draftA = await createDraft(prisma, fixture, { ignoredX: true });
      const draftB = await createDraft(prisma, fixture, { ignoredX: true, yCount: 1 });
      await logIn(page);
      await openDraft(page, draftB.draftId);
      const initialIgnoredValue = await groupSelect(page, fixture.groupX).inputValue();
      const unchangedRow = await prisma.importDraftRow.findUniqueOrThrow({ where: { id: draftB.rowIds[0] } });
      const pageA = await context.newPage();
      await openDraft(pageA, draftA.draftId);
      await groupSelect(pageA, fixture.groupX).selectOption(fixture.categoryId);
      await saveMappings(pageA);
      await expect.poll(async () => (await prisma.importCategoryMapping.findFirstOrThrow({
        where: ruleWhere(fixture, fixture.groupX),
      })).categoryId).toBe(fixture.categoryId);
      const revokedRule = await prisma.importCategoryMapping.findFirstOrThrow({ where: ruleWhere(fixture, fixture.groupX) });
      await pageA.close();

      if (reopenB) {
        await page.reload();
      }

      await expect(groupSelect(page, fixture.groupX)).toHaveValue(initialIgnoredValue);
      await expect(groupSelect(page, fixture.groupX).locator("option:checked")).toHaveText("忽略");
      await expect(mappingForm(page).getByRole("button", { name: "保存映射", exact: true })).toBeDisabled();
      expect((await prisma.importCategoryMapping.findFirstOrThrow({ where: ruleWhere(fixture, fixture.groupX) })).updatedAt).toEqual(revokedRule.updatedAt);
      await openProcessedMappings(page);
      await groupSelect(page, fixture.groupX).selectOption(fixture.categoryId);
      await groupSelect(page, fixture.groupX).selectOption({ label: "忽略" });
      await groupSelect(page, fixture.groupY).selectOption(fixture.categoryId);
      await saveMappings(page);
      await expect.poll(async () => (await prisma.importDraftRow.findUniqueOrThrow({
        where: { id: draftB.rowIds[1] },
      })).status).toBe(ImportDraftRowStatus.READY);

      const householdRule = await prisma.importCategoryMapping.findFirstOrThrow({ where: ruleWhere(fixture, fixture.groupX) });
      expect(householdRule.categoryId).toBe(fixture.categoryId);
      expect(householdRule.updatedAt).toEqual(revokedRule.updatedAt);
      await expectIgnoredRows(prisma, [draftB.rowIds[0]]);
      expect((await prisma.importDraftRow.findUniqueOrThrow({ where: { id: draftB.rowIds[0] } })).updatedAt).toEqual(unchangedRow.updatedAt);
      const savedYRule = await prisma.importCategoryMapping.findFirstOrThrow({ where: ruleWhere(fixture, fixture.groupY) });
      await expect(groupSelect(page, fixture.groupY)).toHaveCount(0);
      await expect(mappingForm(page).getByRole("button", { name: "保存映射", exact: true })).toBeDisabled();
      expect((await prisma.importCategoryMapping.findFirstOrThrow({ where: ruleWhere(fixture, fixture.groupY) })).updatedAt).toEqual(savedYRule.updatedAt);
      expect((await prisma.importCategoryMapping.findFirstOrThrow({ where: ruleWhere(fixture, fixture.groupX) })).updatedAt).toEqual(revokedRule.updatedAt);

      const futureDraftId = await uploadFutureDraft(page, fixture);
      const futureRow = await prisma.importDraftRow.findFirstOrThrow({ where: { draftId: futureDraftId } });
      expect(futureRow.categoryId).toBe(fixture.categoryId);
      expect(futureRow.status).toBe(ImportDraftRowStatus.READY);
      expect(futureRow.userDecision).toBe(ImportRowDecision.KEEP);
      expect(futureRow.skipReason).toBeNull();
    } finally {
      await prisma.$disconnect();
    }
  });
}

for (const ignoreY of [false, true]) {
  test(`ignoring a paginated category group ${ignoreY ? "can complete with zero transactions" : "preserves another mapped group"}`, async ({ page }) => {
    const prisma = createSafeTestDatabaseClient();

    try {
      const fixture = await createFixture(prisma);
      const draft = await createDraft(prisma, fixture, { xCount: 51, yCount: 1, unresolvedX: true });
      await page.setViewportSize({ width: 390, height: 844 });
      await logIn(page);
      await openDraft(page, draft.draftId);
      await expect(page.getByRole("button", { name: "确认导入", exact: true })).toBeDisabled();
      await groupSelect(page, fixture.groupX).selectOption({ label: "忽略" });
      await groupSelect(page, fixture.groupY).selectOption(ignoreY ? { label: "忽略" } : fixture.categoryId);
      await saveMappings(page);
      await expectIgnoredRows(prisma, draft.rowIds.slice(0, ignoreY ? 52 : 51));
      await expect(page.getByRole("link", { name: "待映射 0", exact: true })).toBeVisible();
      await expect(page.getByRole("heading", { name: "成员映射", exact: true })).toHaveCount(0);
      await expect(page.getByRole("button", { name: "确认导入", exact: true })).toBeEnabled();
      await page.getByRole("combobox", { name: "处理状态", exact: true }).selectOption("USER_SKIPPED");
      await expect(page.getByTestId("import-review-row")).toHaveCount(50);
      await expect(page.getByTestId("import-review-row").first()).toContainText("分类映射已忽略");
      await page.getByRole("button", { name: "下一页", exact: true }).first().click();
      await expect(page.getByTestId("import-review-row")).toHaveCount(ignoreY ? 2 : 1);
      await expect(page.getByTestId("import-review-row").first()).toContainText("明细 #51");
      await expect(page.getByTestId("import-review-row").first()).toContainText("分类映射已忽略");
      await page.getByRole("button", { name: "确认导入", exact: true }).click();
      await expect(page.getByRole("heading", { name: "导入已完成", exact: true })).toBeVisible();
      const completed = page.locator(".ios-panel", { has: page.getByRole("heading", { name: "导入已完成", exact: true }) });
      await expect(completed.getByText("已跳过", { exact: true }).locator("..")).toContainText(ignoreY ? "52" : "51");
      expect((await prisma.importDraft.findUniqueOrThrow({ where: { id: draft.draftId } })).status).toBe(ImportDraftStatus.COMPLETED);
      expect(await prisma.transaction.count({ where: {
        householdId: fixture.householdId, source, sourceFingerprint: { startsWith: fixture.prefix }, deletedAt: null,
      } })).toBe(ignoreY ? 0 : 1);
      expect(await prisma.importCategoryMapping.count({ where: {
        householdId: fixture.householdId, primaryCategory: fixture.prefix, categoryId: null,
      } })).toBe(ignoreY ? 2 : 1);
      if (ignoreY) {
        const futureDraftId = await uploadFutureDraft(page, fixture);
        const futureRow = await prisma.importDraftRow.findFirstOrThrow({ where: { draftId: futureDraftId } });
        await expectIgnoredRows(prisma, [futureRow.id]);
        await expect(groupSelect(page, fixture.groupX).locator("option:checked")).toHaveText("忽略");
      }
    } finally {
      await prisma.$disconnect();
    }
  });
}

test("restoring a row makes a mixed group editable and revoking ignore preserves manual skips", async ({ page }) => {
  const prisma = createSafeTestDatabaseClient();

  try {
    const fixture = await createFixture(prisma);
    await createIgnoredRule(prisma, fixture);
    const draft = await createDraft(prisma, fixture, { xCount: 2, ignoredX: true, manualSkip: true });
    await logIn(page);
    await openDraft(page, draft.draftId);
    const firstRow = page.getByTestId("import-review-row").first();
    await firstRow.getByLabel("导入", { exact: true }).check();
    await page.getByRole("button", { name: "保存选择", exact: true }).click();
    await expect.poll(async () => (await prisma.importDraftRow.findUniqueOrThrow({
      where: { id: draft.rowIds[0] },
    })).status).toBe(ImportDraftRowStatus.NEEDS_MAPPING);
    await expect(groupSelect(page, fixture.groupX)).toHaveValue("");
    await expect(page.getByRole("button", { name: "确认导入", exact: true })).toBeDisabled();
    expect((await prisma.importCategoryMapping.findFirstOrThrow({ where: ruleWhere(fixture, fixture.groupX) })).categoryId).toBeNull();
    await groupSelect(page, fixture.groupX).selectOption({ label: "忽略" });
    await saveMappings(page);
    await expectIgnoredRows(prisma, draft.rowIds.slice(0, 2));
    await expect(groupSelect(page, fixture.groupX).locator("option:checked")).toHaveText("忽略");
    await expect(page.getByTestId("import-processed-mappings")).toHaveAttribute("open");
    await openProcessedMappings(page);
    await groupSelect(page, fixture.groupX).selectOption(fixture.categoryId);
    await saveMappings(page);
    await expect.poll(async () => await prisma.importDraftRow.count({ where: {
      id: { in: draft.rowIds.slice(0, 2) }, status: ImportDraftRowStatus.READY,
      userDecision: ImportRowDecision.KEEP, categoryId: fixture.categoryId, skipReason: null,
    } })).toBe(2);
    const manualRow = await prisma.importDraftRow.findUniqueOrThrow({ where: { id: draft.rowIds[2] } });
    expect(manualRow.status).toBe(ImportDraftRowStatus.USER_SKIPPED);
    expect(manualRow.userDecision).toBe(ImportRowDecision.SKIP);
    expect(manualRow.skipReason).toBe("User skipped");
    await page.getByRole("button", { name: "确认导入", exact: true }).click();
    await expect(page.getByRole("heading", { name: "导入已完成", exact: true })).toBeVisible();
    expect(await prisma.transaction.count({ where: {
      householdId: fixture.householdId, source, sourceFingerprint: { startsWith: fixture.prefix }, deletedAt: null,
    } })).toBe(2);
  } finally {
    await prisma.$disconnect();
  }
});

test("a failed mapping save preserves the changed group for retry without republishing an old ignored group", async ({ page, context }) => {
  const prisma = createSafeTestDatabaseClient();

  try {
    const fixture = await createFixture(prisma);
    await createIgnoredRule(prisma, fixture);
    const draftA = await createDraft(prisma, fixture, { ignoredX: true });
    const draftB = await createDraft(prisma, fixture, { ignoredX: true, yCount: 1 });
    await logIn(page);
    await openDraft(page, draftB.draftId);
    await groupSelect(page, fixture.groupY).selectOption(fixture.categoryId);
    const abortServerAction = async (route: Route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
        await route.abort("failed");
      } else {
        await route.continue();
      }
    };
    await page.route("**/records/import**", abortServerAction);
    await saveMappings(page);
    await expect(page.getByText("保存失败，映射选择已保留，请重试。", { exact: true })).toBeVisible();
    await expect(groupSelect(page, fixture.groupY)).toHaveValue(fixture.categoryId);
    await expect(groupSelect(page, fixture.groupX).locator("option:checked")).toHaveText("忽略");
    expect(await prisma.importCategoryMapping.count({ where: ruleWhere(fixture, fixture.groupY) })).toBe(0);
    expect((await prisma.importDraftRow.findUniqueOrThrow({ where: { id: draftB.rowIds[1] } })).status).toBe(ImportDraftRowStatus.NEEDS_MAPPING);

    const pageA = await context.newPage();
    await openDraft(pageA, draftA.draftId);
    await groupSelect(pageA, fixture.groupX).selectOption(fixture.categoryId);
    await saveMappings(pageA);
    await expect.poll(async () => (await prisma.importCategoryMapping.findFirstOrThrow({
      where: ruleWhere(fixture, fixture.groupX),
    })).categoryId).toBe(fixture.categoryId);
    const revokedRule = await prisma.importCategoryMapping.findFirstOrThrow({ where: ruleWhere(fixture, fixture.groupX) });
    await pageA.close();
    await page.unroute("**/records/import**", abortServerAction);
    await saveMappings(page);
    await expect.poll(async () => (await prisma.importDraftRow.findUniqueOrThrow({
      where: { id: draftB.rowIds[1] },
    })).status).toBe(ImportDraftRowStatus.READY);
    await expect(page.getByText("保存失败，映射选择已保留，请重试。", { exact: true })).toHaveCount(0);
    await expectIgnoredRows(prisma, [draftB.rowIds[0]]);
    const householdRule = await prisma.importCategoryMapping.findFirstOrThrow({ where: ruleWhere(fixture, fixture.groupX) });
    expect(householdRule.categoryId).toBe(fixture.categoryId);
    expect(householdRule.updatedAt).toEqual(revokedRule.updatedAt);
  } finally {
    await prisma.$disconnect();
  }
});

test("English category mappings offer Ignore and display the translated skip reason", async ({ page }) => {
  const prisma = createSafeTestDatabaseClient();

  try {
    const fixture = await createFixture(prisma);
    const draft = await createDraft(prisma, fixture);
    await logIn(page);
    await openDraft(page, draft.draftId);
    if (!await page.getByRole("button", { name: "切换语言", exact: true }).first().isVisible()) {
      await page.getByRole("button", { name: "更多选项", exact: true }).first().click();
    }
    await page.getByRole("button", { name: "切换语言", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Category mappings", exact: true })).toBeVisible();
    await groupSelect(page, fixture.groupX, "Category mappings").selectOption({ label: "Ignore" });
    await mappingForm(page, "Category mappings").getByRole("button", { name: "Save mappings", exact: true }).click();
    await expectIgnoredRows(prisma, draft.rowIds);
    await expect(page.getByTestId("import-review-row")).toContainText("Category mapping ignored");
    await expect(groupSelect(page, fixture.groupX, "Category mappings").locator("option:checked")).toHaveText("Ignore");
    await expect(page.getByRole("button", { name: "Confirm import", exact: true })).toBeEnabled();
  } finally {
    await prisma.$disconnect();
  }
});
