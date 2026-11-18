import { randomUUID } from "node:crypto";

import { ImportDraftRowStatus, ImportRowDecision, PrismaClient, TransactionType } from "@prisma/client";
import { expect, test, type Page } from "./fixtures";

type Source = "sui_shou_ji" | "wechat_pay" | "alipay" | "cmb";
type Group = {
  mappingKey: string;
  marker: string;
  primaryCategory: string;
  rowId: string;
  secondaryCategory: string;
};
type Fixture = {
  categoryId: string;
  draftId: string;
  groups: Group[];
  householdId: string;
  manualCategoryId: string;
  prefix: string;
  source: Source;
};

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function createSafeTestDatabaseClient() {
  const databaseUrl = new URL(requireEnv("DATABASE_URL"));
  if (process.env.NODE_ENV === "production" ||
      !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) ||
      !/(?:dev|test)/i.test(databaseUrl.pathname.replace(/^\//, ""))) {
    throw new Error("Agent suggestion fixtures require a local dev/test database");
  }
  return new PrismaClient();
}

async function createFixture(prisma: PrismaClient, source: Source, markers: string[]): Promise<Fixture> {
  const user = await prisma.user.findUniqueOrThrow({
    where: { email: requireEnv("SEED_USER_A_EMAIL") },
    include: { householdMember: true },
  });
  const member = user.householdMember.find((entry) => entry.leftAt === null);
  if (!member) throw new Error("Seeded user must belong to a household");
  const ledger = await prisma.ledger.findFirstOrThrow({ where: { householdId: member.householdId, isDefault: true, archivedAt: null } });
  const [category, manualCategory] = await Promise.all([
    prisma.category.findFirstOrThrow({ where: { type: "EXPENSE", name: "Dining", isActive: true } }),
    prisma.category.findFirstOrThrow({ where: { type: "EXPENSE", name: "Transport", isActive: true } }),
  ]);
  const prefix = `agent-e2e-${randomUUID()}`;
  const draft = await prisma.importDraft.create({
    data: { householdId: member.householdId, ledgerId: ledger.id, createdByMemberId: member.id, source, fileName: `${source}.fixture` },
  });
  const groups = markers.map((marker) => {
    const primaryCategory = source === "alipay" ? `${prefix}-${marker}` : prefix;
    const secondaryCategory = source === "alipay" ? "" : marker;
    return {
      marker,
      primaryCategory,
      secondaryCategory,
      mappingKey: [source, TransactionType.EXPENSE, primaryCategory, secondaryCategory].join("|"),
      rowId: randomUUID(),
    };
  });
  await prisma.importDraftRow.createMany({
    data: groups.map((group, index) => {
      const ignored = group.marker === "existing-ignore";
      const saved = group.marker === "existing-saved";
      return {
        id: group.rowId,
        draftId: draft.id,
        rowNumber: index + 1,
        transactionType: TransactionType.EXPENSE,
        occurredAt: new Date("2024-02-03T04:30:00.000Z"),
        occurredDate: "2024-02-03",
        amountFen: 1234 + index,
        actorMemberId: member.id,
        createdByMemberId: member.id,
        categoryId: saved ? manualCategory.id : null,
        primaryCategory: group.primaryCategory,
        secondaryCategory: group.secondaryCategory,
        mappingKey: group.mappingKey,
        sourceFingerprint: `${prefix}-${index}`,
        note: "商品：早餐",
        status: ignored ? ImportDraftRowStatus.USER_SKIPPED : saved ? ImportDraftRowStatus.READY : ImportDraftRowStatus.NEEDS_MAPPING,
        userDecision: ignored ? ImportRowDecision.SKIP : ImportRowDecision.KEEP,
        skipReason: ignored ? "CATEGORY_MAPPING_IGNORED" : null,
        duplicateCandidates: [],
      };
    }),
  });
  const existingGroups = groups.filter((group) => ["existing-ignore", "existing-saved"].includes(group.marker));
  if (existingGroups.length > 0) {
    await prisma.importCategoryMapping.createMany({
      data: existingGroups.map((group) => ({
        source,
        householdId: member.householdId,
        transactionType: TransactionType.EXPENSE,
        primaryCategory: group.primaryCategory,
        secondaryCategory: group.secondaryCategory,
        categoryId: group.marker === "existing-saved" ? manualCategory.id : null,
      })),
    });
  }
  return {
    categoryId: category.id,
    draftId: draft.id,
    groups,
    householdId: member.householdId,
    manualCategoryId: manualCategory.id,
    prefix,
    source,
  };
}

async function logInAndOpen(page: Page, fixture: Fixture) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
  await page.goto(`/records/import?draft=${fixture.draftId}`);
  await expect(page.getByRole("heading", { name: "导入复核", exact: true })).toBeVisible();
}

function groupSelect(page: Page, fixture: Fixture, marker: string) {
  const group = fixture.groups.find((candidate) => candidate.marker === marker);
  if (!group) throw new Error(`Unknown fixture group: ${marker}`);
  return page.locator("#import-mappings").locator(`select[name="mapping:${group.mappingKey}"]`);
}

async function snapshot(prisma: PrismaClient, fixture: Fixture) {
  return {
    draft: await prisma.importDraft.findUniqueOrThrow({ where: { id: fixture.draftId } }),
    rows: await prisma.importDraftRow.findMany({ where: { draftId: fixture.draftId }, orderBy: { id: "asc" } }),
    rules: await prisma.importCategoryMapping.findMany({
      where: { householdId: fixture.householdId, source: fixture.source, primaryCategory: { startsWith: fixture.prefix } },
      orderBy: { id: "asc" },
    }),
    transactions: await prisma.transaction.findMany({
      where: { householdId: fixture.householdId, sourceFingerprint: { startsWith: fixture.prefix }, deletedAt: null },
      orderBy: { id: "asc" },
    }),
  };
}

for (const source of ["sui_shou_ji", "wechat_pay", "alipay", "cmb"] as const) {
  test(`${source} suggestions prefill category and ignore without saving or replacing existing choices`, async ({ page }) => {
    const prisma = createSafeTestDatabaseClient();
    try {
      const fixture = await createFixture(prisma, source, [
        "__agent_map_food__", "__agent_ignore__", "__agent_uncertain__", "manual", "existing-ignore", "existing-saved",
      ]);
      await page.setViewportSize({ width: 390, height: 844 });
      await logInAndOpen(page, fixture);
      await groupSelect(page, fixture, "manual").selectOption(fixture.manualCategoryId);
      const before = await snapshot(prisma, fixture);
      await page.getByRole("button", { name: "智能推荐", exact: true }).click();
      await expect(groupSelect(page, fixture, "__agent_map_food__")).toHaveValue(fixture.categoryId);
      await expect(groupSelect(page, fixture, "__agent_ignore__").locator("option:checked")).toHaveText("忽略");
      await expect(groupSelect(page, fixture, "__agent_uncertain__")).toHaveValue("");
      await expect(groupSelect(page, fixture, "manual")).toHaveValue(fixture.manualCategoryId);
      await expect(groupSelect(page, fixture, "existing-ignore").locator("option:checked")).toHaveText("忽略");
      await expect(groupSelect(page, fixture, "existing-saved")).toHaveCount(0);
      await expect(page.getByText("建议已预填，仍有 1 组需手动选择。请检查后保存映射。", { exact: true })).toBeVisible();
      expect(await snapshot(prisma, fixture)).toEqual(before);

      await page.getByRole("button", { name: "保存映射", exact: true }).click();
      await expect.poll(async () => {
        const current = await snapshot(prisma, fixture);
        return current.rules.length;
      }).toBe(5);
      const after = await snapshot(prisma, fixture);
      expect(after.rows.find((row) => row.mappingKey === fixture.groups[0].mappingKey)).toMatchObject({
        categoryId: fixture.categoryId, status: ImportDraftRowStatus.READY, userDecision: ImportRowDecision.KEEP,
      });
      expect(after.rows.find((row) => row.mappingKey === fixture.groups[1].mappingKey)).toMatchObject({
        categoryId: null, status: ImportDraftRowStatus.USER_SKIPPED, userDecision: ImportRowDecision.SKIP,
        skipReason: "CATEGORY_MAPPING_IGNORED",
      });
      expect(after.rows.find((row) => row.mappingKey === fixture.groups[2].mappingKey)).toMatchObject({
        categoryId: null, status: ImportDraftRowStatus.NEEDS_MAPPING,
      });
      for (const existingRule of before.rules) {
        expect(after.rules.find((rule) => rule.id === existingRule.id)).toEqual(existingRule);
      }
      expect(after.transactions).toEqual([]);
      await expect(groupSelect(page, fixture, "__agent_uncertain__")).toHaveValue("");
      await expect(page.getByRole("button", { name: "确认导入", exact: true })).toBeDisabled();
    } finally {
      await prisma.$disconnect();
    }
  });
}

test("late suggestions preserve a manual selection and a selection changed back to empty", async ({ page }) => {
  const prisma = createSafeTestDatabaseClient();
  try {
    const fixture = await createFixture(prisma, "sui_shou_ji", [
      "__agent_delayed__keep", "__agent_delayed__clear", "__agent_map_food__",
    ]);
    await logInAndOpen(page, fixture);
    const before = await snapshot(prisma, fixture);
    await page.getByRole("button", { name: "智能推荐", exact: true }).click();
    await expect(page.getByRole("button", { name: "正在推荐…", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "保存映射", exact: true })).toBeDisabled();
    await expect(groupSelect(page, fixture, "__agent_delayed__keep")).toBeEnabled();
    await groupSelect(page, fixture, "__agent_delayed__keep").selectOption(fixture.manualCategoryId);
    await groupSelect(page, fixture, "__agent_delayed__clear").selectOption(fixture.manualCategoryId);
    await groupSelect(page, fixture, "__agent_delayed__clear").selectOption("");
    await expect(groupSelect(page, fixture, "__agent_map_food__")).toHaveValue(fixture.categoryId);
    await expect(groupSelect(page, fixture, "__agent_delayed__keep")).toHaveValue(fixture.manualCategoryId);
    await expect(groupSelect(page, fixture, "__agent_delayed__clear")).toHaveValue("");
    await expect(page.getByRole("button", { name: "保存映射", exact: true })).toBeEnabled();
    expect(await snapshot(prisma, fixture)).toEqual(before);
  } finally {
    await prisma.$disconnect();
  }
});

test("a later batch failure preserves earlier suggestions and retry only fills the remaining group", async ({ page }) => {
  const prisma = createSafeTestDatabaseClient();
  try {
    const firstBatch = Array.from({ length: 25 }, (_, index) => `${String(index).padStart(2, "0")}__agent_map_food__`);
    const fixture = await createFixture(prisma, "sui_shou_ji", [...firstBatch, "99__agent_fail_once__"]);
    await logInAndOpen(page, fixture);
    const before = await snapshot(prisma, fixture);
    await page.getByRole("button", { name: "智能推荐", exact: true }).click();
    await expect(page.locator("#import-mappings").getByRole("alert")).toContainText("已有选择和建议已保留");
    for (const marker of firstBatch) {
      await expect(groupSelect(page, fixture, marker)).toHaveValue(fixture.categoryId);
    }
    await expect(groupSelect(page, fixture, "99__agent_fail_once__")).toHaveValue("");
    expect(await snapshot(prisma, fixture)).toEqual(before);

    await groupSelect(page, fixture, firstBatch[0]).selectOption(fixture.manualCategoryId);
    await page.getByRole("button", { name: "智能推荐", exact: true }).click();
    await expect(groupSelect(page, fixture, "99__agent_fail_once__")).toHaveValue(fixture.categoryId);
    await expect(groupSelect(page, fixture, firstBatch[0])).toHaveValue(fixture.manualCategoryId);
    await expect(page.getByText("建议已预填，请检查后保存映射。", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "智能推荐", exact: true })).toBeDisabled();
    expect(await snapshot(prisma, fixture)).toEqual(before);
  } finally {
    await prisma.$disconnect();
  }
});

test("English suggestions disclose the model service and preserve manual choices after failure", async ({ page }) => {
  const prisma = createSafeTestDatabaseClient();
  try {
    const fixture = await createFixture(prisma, "alipay", ["__agent_fail__", "manual"]);
    await logInAndOpen(page, fixture);
    if (!await page.getByRole("button", { name: "切换语言", exact: true }).first().isVisible()) {
      await page.getByRole("button", { name: "更多选项", exact: true }).first().click();
    }
    await page.getByRole("button", { name: "切换语言", exact: true }).first().click();
    await expect(page.getByRole("heading", { name: "Category mappings", exact: true })).toBeVisible();
    await expect(page.locator("#import-mappings")).toContainText("WheelMaker Hub (Codex)");
    await groupSelect(page, fixture, "manual").selectOption(fixture.manualCategoryId);
    const before = await snapshot(prisma, fixture);
    await page.getByRole("button", { name: "Suggest categories", exact: true }).click();
    await expect(page.locator("#import-mappings").getByRole("alert")).toContainText("Your choices and suggestions are preserved");
    await expect(groupSelect(page, fixture, "manual")).toHaveValue(fixture.manualCategoryId);
    await expect(groupSelect(page, fixture, "__agent_fail__")).toHaveValue("");
    await expect(page.getByRole("button", { name: "Save mappings", exact: true })).toBeEnabled();
    expect(await snapshot(prisma, fixture)).toEqual(before);
  } finally {
    await prisma.$disconnect();
  }
});
