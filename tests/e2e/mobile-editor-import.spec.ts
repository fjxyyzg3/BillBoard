import { randomUUID } from "node:crypto";

import { ImportDraftRowStatus, ImportRowDecision, PrismaClient, TransactionType } from "@prisma/client";
import { expect, test, type Page } from "./fixtures";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function createSafeTestDatabaseClient() {
  const parsed = new URL(requireEnv("DATABASE_URL"));
  if (process.env.NODE_ENV === "production"
    || !["127.0.0.1", "localhost"].includes(parsed.hostname)
    || !/(?:dev|test)/i.test(parsed.pathname.slice(1))) {
    throw new Error("Refusing to create mobile UI fixtures in a non-dev/test database");
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

async function getFixtureContext(prisma: PrismaClient) {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: requireEnv("SEED_USER_A_EMAIL") },
    include: { householdMember: { where: { leftAt: null }, take: 1 } },
  });
  const member = user.householdMember[0];
  if (!member) throw new Error("Seeded user must belong to a household");
  const spouse = await prisma.householdMember.findFirstOrThrow({
    where: { householdId: member.householdId, id: { not: member.id } },
  });
  const category = await prisma.category.findFirstOrThrow({
    where: { name: "Dining", isActive: true, type: "EXPENSE" },
  });
  const ledger = await prisma.ledger.findFirstOrThrow({ where: { householdId: member.householdId, isDefault: true } });
  return { member, spouse, category, ledger };
}

for (const hideEntryIndices of [false, true]) {
  test(`mobile editor protects unsaved family edits and keeps save reachable${hideEntryIndices ? " without navigation entry indices" : ""}`, async ({ page }, testInfo) => {
    if (hideEntryIndices) {
      await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined }));
    }
    const prisma = createSafeTestDatabaseClient();
    try {
      const { member, spouse, category, ledger } = await getFixtureContext(prisma);
      const note = `Mobile family edit ${randomUUID()}`;
      const transaction = await prisma.transaction.create({
        data: {
          householdId: member.householdId,
          ledgerId: ledger.id,
          type: TransactionType.EXPENSE,
          amountFen: 2345,
          categoryId: category.id,
          actorMemberId: spouse.id,
          createdByMemberId: spouse.id,
          occurredAt: new Date("2026-10-13T04:30:00.000Z"),
          note,
        },
      });
      await page.emulateMedia({ reducedMotion: "reduce" });
      await page.setViewportSize({ width: 390, height: 844 });
      await logIn(page);
      await page.goto("/records?mode=all");
      await page.getByRole("link").filter({ hasText: note }).click();
      const editor = page.getByRole("dialog", { name: "编辑记录", exact: true });
      await expect(editor).toBeVisible();
      await expect(editor.getByRole("button", { name: "关闭", exact: true })).toBeFocused();
      await expect(editor.getByRole("radio", { name: spouse.memberName, exact: true })).toBeChecked();
      await expect(editor.getByLabel("时间", { exact: true })).toHaveAttribute("type", "datetime-local");
      await editor.getByLabel("金额", { exact: true }).fill("12+3");
      await expect(editor.getByText("= 15.00", { exact: true })).toBeVisible();

      for (const dismiss of [
        () => editor.getByRole("button", { name: "关闭", exact: true }).click(),
        () => page.keyboard.press("Escape"),
        () => page.goBack(),
      ]) {
        await Promise.all([
          page.waitForEvent("dialog").then(async (dialog) => {
            expect(dialog.message()).toBe("放弃未保存的修改？");
            await dialog.dismiss();
          }),
          dismiss(),
        ]);
        await expect(editor).toBeVisible();
        await expect(editor.getByLabel("金额", { exact: true })).toHaveValue("12+3");
        await expect(page).toHaveURL((url) => url.searchParams.get("record") === transaction.id);
      }

      for (const [width, height] of [[320, 740], [360, 740], [390, 420], [430, 844]]) {
        await page.setViewportSize({ width, height });
        await editor.getByLabel("备注", { exact: true }).fill(note);
        await expect(editor.getByRole("button", { name: "保存修改", exact: true })).toBeInViewport();
        expect(await editor.evaluate((element) => element.scrollWidth <= element.clientWidth)).toBe(true);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await page.screenshot({ path: testInfo.outputPath("mobile-editor.png") });
      await editor.getByRole("radio", { name: member.memberName, exact: true }).check();
      await editor.getByRole("button", { name: "保存修改", exact: true }).click();
      await expect(editor).toBeHidden();
      await expect(page).toHaveURL((url) => !url.searchParams.has("record") && url.searchParams.get("mode") === "all");
      await expect.poll(async () => (await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } })).amountFen).toBe(1500);
      expect((await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } })).actorMemberId).toBe(member.id);

      await page.getByRole("link").filter({ hasText: note }).click();
      await editor.getByLabel("金额", { exact: true }).fill("99");
      await Promise.all([
        page.waitForEvent("dialog").then((dialog) => dialog.accept()),
        editor.getByRole("button", { name: "关闭", exact: true }).click(),
      ]);
      await expect(editor).toBeHidden();
      expect((await prisma.transaction.findUniqueOrThrow({ where: { id: transaction.id } })).amountFen).toBe(1500);
      expect(await page.evaluate(() => document.body.style.position)).not.toBe("fixed");
    } finally {
      await prisma.$disconnect();
    }
  });
}

test("mobile import keeps actions visible while details and processed mappings stay compact", async ({ page }, testInfo) => {
  const prisma = createSafeTestDatabaseClient();
  try {
    const { member, category, ledger } = await getFixtureContext(prisma);
    const key = `mobile-review-${randomUUID()}`;
    const draft = await prisma.importDraft.create({
      data: { householdId: member.householdId, ledgerId: ledger.id, source: "sui_shou_ji", createdByMemberId: member.id, fileName: "mobile-review.xlsx" },
    });
    const rowIds = Array.from({ length: 56 }, () => randomUUID());
    await prisma.importCategoryMapping.create({
      data: {
        householdId: member.householdId, source: "sui_shou_ji", transactionType: TransactionType.EXPENSE,
        primaryCategory: key, secondaryCategory: "Saved", categoryId: null,
      },
    });
    await prisma.importDraftRow.createMany({
      data: rowIds.map((id, index) => ({
        id, draftId: draft.id, rowNumber: index + 1, transactionType: TransactionType.EXPENSE,
        occurredAt: new Date("2026-10-13T04:30:00.000Z"), occurredDate: "2026-10-13",
        amountFen: 2345, actorMemberId: member.id, createdByMemberId: member.id,
        categoryId: index < 2 || index === 55 ? null : category.id,
        primaryCategory: key, secondaryCategory: index < 2 ? "Pending" : index === 55 ? "Saved" : "Dining",
        mappingKey: `sui_shou_ji|EXPENSE|${key}|${index < 2 ? "Pending" : index === 55 ? "Saved" : "Dining"}`,
        sourceFingerprint: `${key}-${index}`, note: `Mobile row ${index + 1} ${key}`,
        status: index < 2 ? ImportDraftRowStatus.NEEDS_MAPPING : index === 55 ? ImportDraftRowStatus.USER_SKIPPED : ImportDraftRowStatus.READY,
        userDecision: index === 55 ? ImportRowDecision.SKIP : ImportRowDecision.KEEP,
        skipReason: index === 55 ? "CATEGORY_MAPPING_IGNORED" : null,
        duplicateCandidates: [],
      })),
    });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.setViewportSize({ width: 390, height: 844 });
    await logIn(page);
    await page.goto(`/records/import?draft=${draft.id}`);
    const actions = page.getByTestId("import-review-actions");
    const confirm = actions.getByRole("button", { name: "确认导入", exact: true });
    const firstRow = page.getByTestId("import-review-row").first();
    const rowDetails = firstRow.getByTestId("import-row-details");
    const processed = page.getByTestId("import-processed-mappings");
    await expect(processed).not.toHaveAttribute("open");
    await expect(rowDetails).not.toHaveAttribute("open");
    await expect(confirm).toBeDisabled();
    await actions.getByRole("link", { name: "还有分类未映射，暂不能确认导入。", exact: true }).click();
    await expect(page.locator("#import-mappings")).toBeInViewport();
    const pending = page.locator("#import-mappings").locator("label", { hasText: "Pending" }).getByRole("combobox");
    await pending.selectOption(category.id);
    await expect(page.locator("#import-mappings").getByText("1 组选择待保存", { exact: true })).toBeVisible();
    await expect(confirm).toBeDisabled();
    await page.locator("#import-mappings").getByRole("button", { name: "保存映射", exact: true }).click();
    await expect(confirm).toBeEnabled();
    await expect.poll(async () => (await prisma.importDraftRow.findUniqueOrThrow({ where: { id: rowIds[0] } })).status).toBe(ImportDraftRowStatus.READY);
    await expect(processed).not.toHaveAttribute("open");
    await firstRow.scrollIntoViewIfNeeded();
    await rowDetails.locator("summary").click();
    await expect(firstRow.getByText(`备注: Mobile row 1 ${key}`, { exact: true })).toBeVisible();
    await rowDetails.locator("summary").click();
    await firstRow.getByLabel("不导入", { exact: true }).check();
    await expect(actions.getByRole("status")).toHaveText("有未保存的选择");

    for (const width of [320, 360, 390, 430]) {
      await page.setViewportSize({ width, height: 844 });
      await page.evaluate(() => window.scrollTo(0, 0));
      await expect(actions.getByRole("button", { name: "保存选择", exact: true })).toBeInViewport();
      await expect(confirm).toBeInViewport();
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    }
    await page.setViewportSize({ width: 390, height: 844 });
    await firstRow.scrollIntoViewIfNeeded();
    await page.screenshot({ path: testInfo.outputPath("mobile-import-review.png") });
    await page.getByRole("button", { name: "下一页", exact: true }).first().click();
    await expect(firstRow).toContainText("明细 #51");
    await expect.poll(async () => (await prisma.importDraftRow.findUniqueOrThrow({ where: { id: rowIds[0] } })).userDecision).toBe(ImportRowDecision.SKIP);
    await expect(actions.getByRole("status")).toHaveText("选择已保存");
  } finally {
    await prisma.$disconnect();
  }
});
