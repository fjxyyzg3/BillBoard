import { randomUUID } from "node:crypto";

import {
  CategoryType,
  ImportDraftRowStatus,
  ImportRowDecision,
  PrismaClient,
  TransactionType,
} from "@prisma/client";
import { expect, test, type Page, type Route } from "./fixtures";
import ExcelJS from "exceljs";

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

function createSafeTestDatabaseClient() {
  if (process.env.NODE_ENV === "production") {
    throw new Error("Import review fixtures must not run with NODE_ENV=production");
  }

  const parsedUrl = new URL(requireEnv("DATABASE_URL"));
  const databaseName = parsedUrl.pathname.replace(/^\//, "");
  const hostIsLocal = parsedUrl.hostname === "127.0.0.1" || parsedUrl.hostname === "localhost";

  if (!hostIsLocal || !/(?:dev|test)/i.test(databaseName)) {
    throw new Error("Refusing to create import review fixtures in a non-dev/test database");
  }

  return new PrismaClient();
}

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function createReviewFixture(
  prisma: PrismaClient,
  { readyCount = 105, duplicateCount = 55, includeReadOnly = true } = {},
) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: requireEnv("SEED_USER_A_EMAIL") },
    include: { householdMember: true },
  });
  const member = user.householdMember.find((entry) => entry.leftAt === null);

  if (!member) {
    throw new Error("Seeded user must belong to a household");
  }
  const ledger = await prisma.ledger.findFirstOrThrow({ where: { householdId: member.householdId, isDefault: true, archivedAt: null } });

  const spouse = await prisma.householdMember.findFirstOrThrow({
    where: { householdId: member.householdId, id: { not: member.id } },
  });
  const category = await prisma.category.findFirstOrThrow({
    where: { type: CategoryType.EXPENSE, name: "Dining", isActive: true },
  });
  const fixtureKey = `review-e2e-${randomUUID()}`;
  const oldDate = new Date("2024-05-06T04:30:00.000Z");
  const candidateIds = Array.from({ length: 4 }, () => randomUUID());

  if (duplicateCount > 0) {
    await prisma.transaction.createMany({
      data: candidateIds.map((id, index) => ({
        id,
        householdId: member.householdId,
        ledgerId: ledger.id,
        type: TransactionType.EXPENSE,
        actorMemberId: spouse.id,
        createdByMemberId: member.id,
        categoryId: category.id,
        amountFen: 2537,
        occurredAt: oldDate,
        note: `Original candidate ${index + 1} ${fixtureKey}`,
      })),
    });
  }

  const draft = await prisma.importDraft.create({
    data: {
      householdId: member.householdId,
      ledgerId: ledger.id,
      source: "sui_shou_ji",
      fileName: "sui_shou_ji.xlsx",
      createdByMemberId: member.id,
    },
  });
  const totalCount = readyCount + duplicateCount + (includeReadOnly ? 3 : 0);
  const rowIds = Array.from({ length: totalCount }, () => randomUUID());

  await prisma.importDraftRow.createMany({
    data: rowIds.map((id, index) => {
      const isDuplicate = index >= readyCount && index < readyCount + duplicateCount;
      const readOnlyIndex = index - readyCount - duplicateCount;
      const status = isDuplicate
        ? ImportDraftRowStatus.POSSIBLE_DUPLICATE
        : readOnlyIndex === 0
          ? ImportDraftRowStatus.SOURCE_DUPLICATE
          : readOnlyIndex === 1
            ? ImportDraftRowStatus.INVALID
            : readOnlyIndex === 2
              ? ImportDraftRowStatus.USER_SKIPPED
              : ImportDraftRowStatus.READY;
      const isReadOnly = includeReadOnly && readOnlyIndex >= 0;

      return {
        id,
        draftId: draft.id,
        rowNumber: index + 1,
        transactionType: TransactionType.EXPENSE,
        occurredAt: isDuplicate ? oldDate : new Date(),
        occurredDate: isDuplicate ? "2024-05-06" : new Intl.DateTimeFormat("en-CA", {
          timeZone: "Asia/Shanghai", year: "numeric", month: "2-digit", day: "2-digit",
        }).format(new Date()),
        amountFen: 2537,
        actorMemberId: member.id,
        createdByMemberId: member.id,
        categoryId: category.id,
        primaryCategory: "餐饮",
        secondaryCategory: "复核示例商户",
        note: `Imported row ${index + 1} ${fixtureKey}`,
        sourceFingerprint: `${fixtureKey}-${index + 1}`,
        status,
        userDecision: isDuplicate || isReadOnly ? ImportRowDecision.SKIP : ImportRowDecision.KEEP,
        skipReason: isReadOnly
          ? readOnlyIndex === 0
            ? "Source duplicate"
            : readOnlyIndex === 1
              ? "Invalid amount"
              : "ALIPAY_FULLY_REFUNDED"
          : null,
        duplicateCandidates: isDuplicate ? candidateIds.map((candidateId) => ({
          id: candidateId,
          amountFen: 2537,
          categoryId: category.id,
          occurredAt: oldDate.toISOString(),
          source: null,
          type: TransactionType.EXPENSE,
        })) : [],
      };
    }),
  });

  return { draft, rowIds, candidateIds, member, spouse, fixtureKey };
}

test("long imported notes wrap without widening mobile review cards", async ({ page }, testInfo) => {
  const prisma = createSafeTestDatabaseClient();

  try {
    const fixture = await createReviewFixture(prisma, { readyCount: 1, duplicateCount: 1 });
    const note = `交易对方：示例商户；商品：${"DemoPaymentOrder0123456789".repeat(6)}\n第二行备注`;
    await prisma.importDraftRow.update({
      where: { id: fixture.rowIds[0] },
      data: { note },
    });
    await page.setViewportSize({ width: 390, height: 844 });
    await logIn(page);
    await page.goto(`/records/import?draft=${fixture.draft.id}`);
    const review = page.getByTestId("import-review-form");
    const rows = review.getByTestId("import-review-row");
    await expect(review).toBeVisible();
    await expect(rows).toHaveCount(5);
    await expect(rows.first().getByTestId("import-row-details")).not.toHaveAttribute("open");
    await rows.first().getByTestId("import-row-details").locator("summary").click();
    await expect(rows.first().locator(".whitespace-pre-wrap")).toHaveText(`备注: ${note}`);

    for (const width of [390, 320]) {
      await page.setViewportSize({ width, height: 844 });
      const layout = await review.evaluate((form) => {
        const bounds = form.getBoundingClientRect();
        const style = getComputedStyle(form);
        return {
          documentWidth: document.documentElement.scrollWidth,
          contentLeft: bounds.left + parseFloat(style.borderLeftWidth) + parseFloat(style.paddingLeft),
          contentRight: bounds.right - parseFloat(style.borderRightWidth) - parseFloat(style.paddingRight),
          rows: Array.from(form.querySelectorAll('[data-testid="import-review-row"]')).map((row) => ({
            left: row.getBoundingClientRect().left,
            right: row.getBoundingClientRect().right,
            clientWidth: row.clientWidth,
            scrollWidth: row.scrollWidth,
          })),
        };
      });
      expect(layout.documentWidth).toBeLessThanOrEqual(width);
      for (const row of layout.rows) {
        expect(row.left).toBeGreaterThanOrEqual(layout.contentLeft - 1);
        expect(row.right).toBeLessThanOrEqual(layout.contentRight + 1);
        expect(row.scrollWidth).toBeLessThanOrEqual(row.clientWidth + 1);
      }
      await rows.first().scrollIntoViewIfNeeded();
      await page.screenshot({ path: testInfo.outputPath(`import-long-note-${width}.png`) });
    }
  } finally {
    await prisma.$disconnect();
  }
});

test("review progress and action summaries preserve unsaved choices before opening duplicate rows", async ({ page }, testInfo) => {
  const prisma = createSafeTestDatabaseClient();

  try {
    const fixture = await createReviewFixture(prisma, { readyCount: 1, duplicateCount: 1, includeReadOnly: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await logIn(page);
    await page.goto(`/records/import?draft=${fixture.draft.id}`);

    const progress = page.getByRole("navigation", { name: "导入进度", exact: true });
    await expect(progress.getByRole("listitem")).toHaveCount(4);
    await expect(progress.getByRole("listitem").filter({ hasText: "核对记录" })).toHaveAttribute("aria-current", "step");
    const review = page.getByTestId("import-review-form");
    await expect(review.getByRole("status")).toHaveText("选择已保存");
    await expect(review.getByRole("button", { name: "保存选择", exact: true })).toBeDisabled();

    const firstRow = page.getByTestId("import-review-row").first();
    await firstRow.getByLabel("不导入", { exact: true }).check();
    await expect(review.getByRole("status")).toHaveText("有未保存的选择");
    await expect(review.getByRole("button", { name: "保存选择", exact: true })).toBeEnabled();
    await page.getByRole("link", { name: "待映射 0", exact: true }).click();
    await expect(review.getByRole("status")).toHaveText("选择已保存");
    await expect.poll(async () => (await prisma.importDraftRow.findUniqueOrThrow({
      where: { id: fixture.rowIds[0] },
    })).userDecision).toBe(ImportRowDecision.SKIP);
    await firstRow.getByLabel("导入", { exact: true }).check();
    await expect(review.getByRole("status")).toHaveText("有未保存的选择");
    await page.getByRole("link", { name: /疑似重复 1/ }).click();

    await expect(page).toHaveURL((url) => url.searchParams.get("status") === "POSSIBLE_DUPLICATE");
    await expect(page.getByRole("combobox", { name: "处理状态" })).toHaveValue("POSSIBLE_DUPLICATE");
    await expect(page.getByTestId("import-review-row")).toHaveCount(1);
    await expect(page.getByTestId("import-review-row")).toContainText("明细 #2");
    await expect.poll(async () => (await prisma.importDraftRow.findUniqueOrThrow({
      where: { id: fixture.rowIds[0] },
    })).userDecision).toBe(ImportRowDecision.KEEP);
    await expect(review.getByRole("status")).toHaveText("选择已保存");
    await expect(page.getByTestId("import-review-row").getByLabel("不导入", { exact: true })).toBeChecked();
    await page.screenshot({ path: testInfo.outputPath("import-action-summary-mobile.png"), fullPage: true });
  } finally {
    await prisma.$disconnect();
  }
});

test("every row in a large draft is reachable and navigation saves choices before filtering", async ({ page }, testInfo) => {
  const prisma = createSafeTestDatabaseClient();

  try {
    const fixture = await createReviewFixture(prisma);
    await page.setViewportSize({ width: 390, height: 844 });
    await logIn(page);
    await page.goto(`/records/import?draft=${fixture.draft.id}`);
    await expect(page.getByRole("heading", { name: "导入复核" })).toBeVisible();
    const firstRow = page.getByTestId("import-review-row").first();
    await firstRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("import-review-mobile.png") });
    await firstRow.getByLabel("不导入", { exact: true }).check();
    await page.getByRole("button", { name: "下一页", exact: true }).first().click();
    await expect(page.getByTestId("import-review-row").first()).toContainText("明细 #51");
    await expect.poll(async () => (await prisma.importDraftRow.findUniqueOrThrow({
      where: { id: fixture.rowIds[0] },
    })).userDecision).toBe(ImportRowDecision.SKIP);
    await page.getByRole("button", { name: "上一页", exact: true }).first().click();
    await expect(firstRow.getByLabel("不导入", { exact: true })).toBeChecked();

    const visitedIds: string[] = [];
    for (let pageNumber = 1; pageNumber <= 4; pageNumber += 1) {
      await expect(page.getByTestId("import-review-row").first()).toContainText(`明细 #${(pageNumber - 1) * 50 + 1}`);
      visitedIds.push(...await page.getByTestId("import-review-row").evaluateAll((elements) =>
        elements.map((element) => element.getAttribute("data-row-id") ?? ""),
      ));

      if (pageNumber < 4) {
        await page.getByRole("button", { name: "下一页", exact: true }).first().click();
      }
    }
    expect(visitedIds).toHaveLength(163);
    expect(new Set(visitedIds).size).toBe(163);
    expect(new Set(visitedIds)).toEqual(new Set(fixture.rowIds));
    await expect(page.getByRole("button", { name: "下一页", exact: true }).first()).toBeDisabled();

    const statusFilter = page.getByRole("combobox", { name: "处理状态" });
    await statusFilter.selectOption("POSSIBLE_DUPLICATE");
    await expect(page.getByTestId("import-review-row")).toHaveCount(50);
    await expect(page.getByTestId("import-review-row").first()).toContainText("明细 #106");
    await page.getByRole("button", { name: "下一页", exact: true }).first().click();
    await expect(page.getByTestId("import-review-row")).toHaveCount(5);
    const lastDuplicate = page.getByTestId("import-review-row").last();
    await expect(lastDuplicate).toContainText("明细 #160");
    await expect(lastDuplicate).toContainText("Imported row 160");
    await expect(lastDuplicate).toContainText(fixture.member.memberName);
    await lastDuplicate.getByLabel("导入", { exact: true }).check();
    await statusFilter.selectOption("SOURCE_DUPLICATE");
    await expect.poll(async () => (await prisma.importDraftRow.findUniqueOrThrow({
      where: { id: fixture.rowIds[159] },
    })).userDecision).toBe(ImportRowDecision.KEEP);
    await expect(page.getByTestId("import-review-row")).toHaveCount(1);
    await expect(page.getByTestId("import-review-row").locator('input[name^="decision:"]')).toHaveCount(0);
    await statusFilter.selectOption("INVALID");
    await expect(page.getByTestId("import-review-row")).toHaveCount(1);
    await expect(page.getByTestId("import-review-row")).toContainText("金额无效");
    await expect(page.getByTestId("import-review-row").locator('input[name^="decision:"]')).toHaveCount(0);
    await page.reload();
    await expect(statusFilter).toHaveValue("INVALID");
    await expect(page.getByTestId("import-review-row")).toHaveCount(1);
  } finally {
    await prisma.$disconnect();
  }
});

test("all duplicate candidates open read-only old records and unavailable candidates preserve the choice", async ({ page }, testInfo) => {
  const prisma = createSafeTestDatabaseClient();

  try {
    const fixture = await createReviewFixture(prisma, { readyCount: 0, duplicateCount: 1, includeReadOnly: false });
    await page.setViewportSize({ width: 390, height: 844 });
    await logIn(page);
    await page.goto(`/records/import?draft=${fixture.draft.id}`);
    const row = page.getByTestId("import-review-row");
    await row.getByLabel("导入", { exact: true }).check();
    await expect(row.getByRole("button", { name: "查看原记录", exact: true })).toHaveCount(0);
    await row.getByTestId("import-row-details").locator("summary").first().click();
    await expect(row.getByRole("button", { name: "查看原记录", exact: true })).toHaveCount(3);
    await row.getByText("展开其余 1 个候选", { exact: true }).click();
    await expect(row.getByRole("button", { name: "查看原记录", exact: true })).toHaveCount(4);
    await row.getByRole("button", { name: "查看原记录", exact: true }).nth(3).click();
    const detail = page.getByRole("dialog", { name: /原记录/ });
    await expect(detail).toBeVisible();
    await expect(detail).toContainText("2024");
    await expect(detail).toContainText("25.37");
    await expect(detail).toContainText("支出");
    await expect(detail).toContainText("餐饮");
    await expect(detail).toContainText(fixture.spouse.memberName);
    await expect(detail).toContainText(fixture.member.memberName);
    await expect(detail).toContainText("Original candidate 4");
    await expect(detail.locator("input, select, textarea")).toHaveCount(0);
    await expect(detail.getByRole("button", { name: /保存修改|删除记录/ })).toHaveCount(0);
    await page.screenshot({ path: testInfo.outputPath("import-review-original-mobile.png") });
    await detail.getByRole("button", { name: "关闭", exact: true }).click();
    await expect(detail).toHaveCount(0);
    await expect(row.getByRole("button", { name: "查看原记录", exact: true }).nth(3)).toBeFocused();
    await expect(row.getByLabel("导入", { exact: true })).toBeChecked();
    expect((await prisma.importDraftRow.findUniqueOrThrow({
      where: { id: fixture.rowIds[0] },
    })).userDecision).toBe(ImportRowDecision.SKIP);

    await prisma.transaction.update({
      where: { id: fixture.candidateIds[3] },
      data: { deletedAt: new Date() },
    });
    await row.getByRole("button", { name: "查看原记录", exact: true }).nth(3).click();
    await expect(page.getByText(/原记录.*(?:不可用|不存在|无法|已删除)/)).toBeVisible();
    await expect(page.getByText("Original candidate 4", { exact: false })).toHaveCount(0);
    await expect(row.getByLabel("导入", { exact: true })).toBeChecked();
  } finally {
    await prisma.$disconnect();
  }
});

for (const hideEntryIndices of [false, true]) {
test(`browser history saves pending choices before going back and preserves them when going forward${hideEntryIndices ? " without entry indices" : ""}`, async ({ page }) => {
  if (hideEntryIndices) {
    await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined }));
  }
  const prisma = createSafeTestDatabaseClient();

  try {
    const fixture = await createReviewFixture(prisma, { readyCount: 60, duplicateCount: 0, includeReadOnly: false });
    await logIn(page);
    await page.goto(`/records/import?draft=${fixture.draft.id}`);
    await page.getByRole("button", { name: "下一页", exact: true }).first().click();
    const firstRow = page.getByTestId("import-review-row").first();
    await expect(firstRow).toContainText("明细 #51");
    await firstRow.getByLabel("不导入", { exact: true }).check();

    await page.goBack();
    await expect(firstRow).toContainText("明细 #1");
    await expect.poll(async () => (await prisma.importDraftRow.findUniqueOrThrow({
      where: { id: fixture.rowIds[50] },
    })).userDecision).toBe(ImportRowDecision.SKIP);
    await expect(page).toHaveURL((url) => url.searchParams.get("draft") === fixture.draft.id && !url.searchParams.has("page"));
    await page.goForward();
    await expect(firstRow).toContainText("明细 #51");
    await expect(firstRow.getByLabel("不导入", { exact: true })).toBeChecked();
  } finally {
    await prisma.$disconnect();
  }
});

test(`browser history save failure keeps the current URL, page, and pending choices${hideEntryIndices ? " without entry indices" : ""}`, async ({ page }) => {
  if (hideEntryIndices) {
    await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined }));
  }
  const prisma = createSafeTestDatabaseClient();

  try {
    const fixture = await createReviewFixture(prisma, { readyCount: 60, duplicateCount: 0, includeReadOnly: false });
    await logIn(page);
    await page.goto(`/records/import?draft=${fixture.draft.id}`);
    await page.getByRole("button", { name: "下一页", exact: true }).first().click();
    const firstRow = page.getByTestId("import-review-row").first();
    await expect(firstRow).toContainText("明细 #51");
    await firstRow.getByLabel("不导入", { exact: true }).check();
    const originalUrl = page.url();
    const abortServerAction = async (route: Route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
        await route.abort("failed");
      } else {
        await route.continue();
      }
    };
    await page.route("**/records/import**", abortServerAction);

    await page.goBack();
    await expect(page.getByText("保存失败，选择已保留，请重试。")).toBeVisible();
    await expect(page).toHaveURL(originalUrl);
    await expect(firstRow).toContainText("明细 #51");
    await expect(firstRow.getByLabel("不导入", { exact: true })).toBeChecked();
    expect((await prisma.importDraftRow.findUniqueOrThrow({
      where: { id: fixture.rowIds[50] },
    })).userDecision).toBe(ImportRowDecision.KEEP);

    await page.unroute("**/records/import**", abortServerAction);
    await page.goBack();
    await expect(firstRow).toContainText("明细 #1");
    await expect.poll(async () => (await prisma.importDraftRow.findUniqueOrThrow({
      where: { id: fixture.rowIds[50] },
    })).userDecision).toBe(ImportRowDecision.SKIP);
  } finally {
    await prisma.$disconnect();
  }
});

test(`browser history keeps choices on failure when leaving review for an earlier page${hideEntryIndices ? " without entry indices" : ""}`, async ({ page }) => {
  if (hideEntryIndices) {
    await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined }));
  }
  const prisma = createSafeTestDatabaseClient();

  try {
    const workbook = new ExcelJS.Workbook();
    const headers = ["交易类型", "日期", "一级分类", "二级分类", "账户1", "账户2", "账户币种", "金额", "成员", "商家", "项目分类", "项目", "记账人", "备注"];
    workbook.addWorksheet("支出").addRows([
      headers,
      ["支出", "2024-01-02 12:00:00", "餐饮", "三餐", "现金", "", "CNY", "12.34", "老婆", "小店", "", "", "老婆", `History review ${randomUUID()}`],
    ]);
    workbook.addWorksheet("收入").addRows([headers]);
    await logIn(page);
    await page.getByRole("link", { name: "记录", exact: true }).first().click();
    await expect(page).toHaveURL((url) => url.pathname === "/records");
    const recordsUrl = page.url();
    await page.getByRole("link", { name: "导入", exact: true }).click();
    await page.getByLabel("随手记", { exact: true }).check();
    await page.getByLabel("文件", { exact: true }).setInputFiles({
      name: "history-review.xlsx",
      mimeType: "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      buffer: Buffer.from(await workbook.xlsx.writeBuffer()),
    });
    await page.getByRole("button", { name: "上传并解析", exact: true }).click();
    await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("draft")));
    const draftId = new URL(page.url()).searchParams.get("draft")!;
    const draftRow = await prisma.importDraftRow.findFirstOrThrow({ where: { draftId } });
    expect(draftRow.userDecision).toBe(ImportRowDecision.KEEP);
    const firstRow = page.getByTestId("import-review-row").first();
    await firstRow.getByLabel("不导入", { exact: true }).check();
    const originalUrl = page.url();
    const abortServerAction = async (route: Route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
        await route.abort("failed");
      } else {
        await route.continue();
      }
    };
    await page.route("**/records/import**", abortServerAction);

    await page.evaluate(() => window.history.go(-2));
    await expect(page.getByText("保存失败，选择已保留，请重试。")).toBeVisible();
    await expect(page).toHaveURL(originalUrl);
    await expect(firstRow.getByLabel("不导入", { exact: true })).toBeChecked();
    expect((await prisma.importDraftRow.findUniqueOrThrow({
      where: { id: draftRow.id },
    })).userDecision).toBe(ImportRowDecision.KEEP);

    await page.unroute("**/records/import**", abortServerAction);
    await page.evaluate(() => window.history.go(-2));
    await expect(page).toHaveURL(recordsUrl);
    await expect.poll(async () => (await prisma.importDraftRow.findUniqueOrThrow({
      where: { id: draftRow.id },
    })).userDecision).toBe(ImportRowDecision.SKIP);
  } finally {
    await prisma.$disconnect();
  }
});

}

test("failed saves keep the current page and choices, and confirmation saves outstanding choices", async ({ page }) => {
  const prisma = createSafeTestDatabaseClient();

  try {
    const fixture = await createReviewFixture(prisma, { readyCount: 51, duplicateCount: 0, includeReadOnly: false });
    await logIn(page);
    await page.goto(`/records/import?draft=${fixture.draft.id}`);
    const firstRow = page.getByTestId("import-review-row").first();
    await firstRow.getByLabel("不导入", { exact: true }).check();
    const abortServerAction = async (route: Route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) {
        await route.abort("failed");
      } else {
        await route.continue();
      }
    };
    await page.route("**/records/import**", abortServerAction);
    await page.getByRole("button", { name: "下一页", exact: true }).first().click();
    await expect(page.getByText("保存失败，选择已保留，请重试。")).toBeVisible();
    await expect(firstRow).toContainText("明细 #1");
    await expect(firstRow.getByLabel("不导入", { exact: true })).toBeChecked();
    expect((await prisma.importDraftRow.findUniqueOrThrow({
      where: { id: fixture.rowIds[0] },
    })).userDecision).toBe(ImportRowDecision.KEEP);
    await page.getByRole("combobox", { name: "处理状态" }).selectOption("USER_SKIPPED");
    await expect(page.getByRole("combobox", { name: "处理状态" })).toHaveValue("all");
    await expect(firstRow.getByLabel("不导入", { exact: true })).toBeChecked();
    await page.unroute("**/records/import**", abortServerAction);

    await page.getByRole("button", { name: "下一页", exact: true }).first().click();
    await expect(page.getByTestId("import-review-row")).toHaveCount(1);
    await page.getByTestId("import-review-row").getByLabel("不导入", { exact: true }).check();
    await page.getByRole("button", { name: "确认导入", exact: true }).click();
    await expect(page.getByRole("heading", { name: "导入已完成" })).toBeVisible();
    expect(await prisma.transaction.count({
      where: {
        householdId: fixture.member.householdId,
        source: "sui_shou_ji",
        sourceFingerprint: { startsWith: fixture.fixtureKey },
        deletedAt: null,
      },
    })).toBe(49);
    expect((await prisma.importDraftRow.findUniqueOrThrow({
      where: { id: fixture.rowIds[50] },
    })).userDecision).toBe(ImportRowDecision.SKIP);
  } finally {
    await prisma.$disconnect();
  }
});
