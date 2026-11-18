import { randomUUID } from "node:crypto";
import { ImportDraftRowStatus, ImportRowDecision, PrismaClient, TransactionType } from "@prisma/client";
import { hash } from "argon2";
import { expect, test, type Page } from "./fixtures";
import { createHouseholdCode, createKeyRing, encodeHouseholdCode, sealKeyRing } from "../../src/lib/encryption/crypto";
import { encryptRow } from "../../src/lib/encryption/protected-models";
import { getMessages } from "../../src/lib/i18n";

const labels = getMessages("zh-CN");
const password = "synthetic-records-ui-review-password";
const owned: Array<{ userId: string; householdId?: string }> = [];

function database() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Records UI fixtures require a local development/test database");
  }
  return new PrismaClient();
}

async function fixture(prisma: PrismaClient) {
  const user = await prisma.user.create({ data: { email: `records-ui-${randomUUID()}@example.test`, displayName: "Records UI owner", passwordHash: await hash(password) } });
  const item: typeof owned[number] = { userId: user.id };
  owned.push(item);
  const household = await prisma.household.create({
    data: {
      name: "Records UI household",
      members: { create: { userId: user.id, memberName: "Records UI owner", role: "OWNER" } },
      ledgers: { create: { name: "Default", isDefault: true, acceptsLegacyDrafts: true } },
    },
    include: { members: true, ledgers: true },
  });
  item.householdId = household.id;
  const categoryA = await prisma.category.findFirstOrThrow({ where: { name: "Dining", type: "EXPENSE", isActive: true } });
  const categoryB = await prisma.category.findFirstOrThrow({ where: { name: "Transport", type: "EXPENSE", isActive: true } });
  return { user, household, member: household.members[0], ledger: household.ledgers[0], categoryA, categoryB };
}

async function login(page: Page, email: string) {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function confirmNavigation(page: Page, accept: boolean, navigate: () => Promise<unknown>) {
  await Promise.all([
    page.waitForEvent("dialog").then(async (dialog) => {
      expect(dialog.type()).toBe("confirm");
      expect(dialog.message()).toBe(labels.import.unsavedMappingsConfirm);
      if (accept) await dialog.accept();
      else await dialog.dismiss();
    }),
    navigate(),
  ]);
}

test.afterEach(async () => {
  const prisma = database();
  try {
    for (const item of owned.splice(0)) {
      if (item.householdId) {
        await prisma.appEvent.deleteMany({ where: { householdId: item.householdId } });
        await prisma.household.deleteMany({ where: { id: item.householdId } });
      }
      await prisma.user.deleteMany({ where: { id: item.userId } });
    }
  } finally { await prisma.$disconnect(); }
});

test("encrypted top-bar search succeeds and failed filters keep feedback inside their dialog", async ({ page }) => {
  const prisma = database();
  try {
    const data = await fixture(prisma);
    const note = `Private search record ${randomUUID()}`;
    const record = await prisma.transaction.create({ data: {
      householdId: data.household.id, ledgerId: data.ledger.id, actorMemberId: data.member.id, createdByMemberId: data.member.id,
      categoryId: data.categoryA.id, type: "EXPENSE", amountFen: 1234, occurredAt: new Date(), note,
    } });
    const code = createHouseholdCode(data.household.id), ring = createKeyRing(code), encoded = encodeHouseholdCode(code);
    const protectedLedger = await encryptRow("ledger", data.ledger, ring, data.household.id, data.categoryA.id);
    const protectedRecord = await encryptRow("transaction", record, ring, data.household.id, data.categoryA.id, data.ledger.id);
    await prisma.ledger.update({ where: { id: data.ledger.id }, data: {
      name: String(protectedLedger.name), encryptedPayload: String(protectedLedger.encryptedPayload), encryptionRevision: String(protectedLedger.encryptionRevision),
    } });
    await prisma.transaction.update({ where: { id: record.id }, data: {
      amountFen: 0, occurredAt: new Date(0), note: null, source: "encrypted", sourceFingerprint: String(protectedRecord.sourceFingerprint),
      encryptedPayload: String(protectedRecord.encryptedPayload), encryptionRevision: String(protectedRecord.encryptionRevision),
    } });
    await prisma.householdEncryption.create({ data: {
      householdId: data.household.id, mode: "ENCRYPTED", revision: 1, generation: code.generation, keyVersion: code.keyVersion,
      sealedKeyRing: await sealKeyRing(code, ring),
    } });
    await login(page, data.user.email);
    await page.getByLabel("家庭解锁码", { exact: true }).fill(encoded);
    await page.getByRole("button", { name: "导入并解锁", exact: true }).click();
    await expect(page.getByRole("heading", { name: "首页", exact: true })).toBeVisible();
    await page.goto("/records?mode=all");
    const search = page.getByLabel(labels.common.search, { exact: true });
    await search.fill(note);
    const admitted = page.waitForRequest((request) => request.method() === "POST" && new URL(request.url()).pathname === "/records/search");
    await search.press("Enter");
    const request = await admitted;
    expect(request.postData()).toContain(encoded);
    expect(request.url()).not.toContain(encoded);
    expect(JSON.stringify(request.headers())).not.toContain(encoded);
    await expect(page).toHaveURL((url) => url.pathname === "/records" && Boolean(url.searchParams.get("search")));
    await expect(page.getByRole("link").filter({ hasText: note })).toBeVisible();
    await expect(search).toHaveValue(note);

    await page.getByRole("button", { name: labels.ui.filters, exact: true }).click();
    const dialog = page.getByRole("dialog", { name: labels.ui.filters, exact: true });
    await dialog.getByLabel(labels.common.amountFilter, { exact: true }).selectOption("exact");
    await dialog.getByLabel(labels.common.amountExactYuan, { exact: true }).fill("12.34");
    const originalUrl = page.url();
    await page.route("**/records/search", (route) => route.abort("failed"));
    await dialog.getByRole("button", { name: labels.ui.applyFilters, exact: true }).click();
    await expect(dialog.getByRole("alert")).toHaveText(labels.common.searchFailed);
    await expect(dialog.getByLabel(labels.common.amountExactYuan, { exact: true })).toHaveValue("12.34");
    await expect(dialog.getByRole("button", { name: labels.ui.applyFilters, exact: true })).toBeEnabled();
    await expect(page).toHaveURL(originalUrl);
    await page.unroute("**/records/search");
    await dialog.getByRole("button", { name: labels.ui.applyFilters, exact: true }).click();
    await expect(dialog).toBeHidden();
    await expect(page).toHaveURL((url) => Boolean(url.searchParams.get("amount")));
    await expect(page.getByRole("link").filter({ hasText: note })).toBeVisible();
  } finally { await prisma.$disconnect(); }
});

test("mapping management cancels or confirms a link without silently saving discarded choices", async ({ page }) => {
  const prisma = database();
  try {
    const data = await fixture(prisma);
    const rule = await prisma.importCategoryMapping.create({ data: {
      householdId: data.household.id, source: "sui_shou_ji", transactionType: "EXPENSE", primaryCategory: "UI category", secondaryCategory: "Link", categoryId: data.categoryA.id,
    } });
    await login(page, data.user.email);
    await page.goto("/records/import/mappings");
    const select = page.locator(`select[name="managed-mapping:${rule.id}"]`);
    await select.selectOption(data.categoryB.id);
    await confirmNavigation(page, false, () => page.getByRole("link", { name: labels.import.backToImport, exact: true }).click());
    await expect(page).toHaveURL(/\/records\/import\/mappings$/);
    await expect(select).toHaveValue(data.categoryB.id);
    await confirmNavigation(page, true, () => page.getByRole("link", { name: labels.import.backToImport, exact: true }).click());
    await expect(page).toHaveURL(/\/records\/import$/);
    expect((await prisma.importCategoryMapping.findUniqueOrThrow({ where: { id: rule.id } })).categoryId).toBe(data.categoryA.id);
  } finally { await prisma.$disconnect(); }
});

test("same-page mapping anchors confirm before saving review choices can remount the mapping form", async ({ page }) => {
  const prisma = database();
  try {
    const data = await fixture(prisma);
    const primaryCategory = `Anchor category ${randomUUID()}`;
    const draft = await prisma.importDraft.create({ data: {
      householdId: data.household.id, ledgerId: data.ledger.id, createdByMemberId: data.member.id, source: "sui_shou_ji", fileName: "ui-anchor-review.xlsx",
    } });
    const rowIds = [randomUUID(), randomUUID()];
    await prisma.importDraftRow.createMany({ data: rowIds.map((id, index) => ({
      id, draftId: draft.id, rowNumber: index + 1, transactionType: TransactionType.EXPENSE,
      occurredAt: new Date("2026-10-13T04:30:00.000Z"), occurredDate: "2026-10-13", amountFen: 1234,
      actorMemberId: data.member.id, createdByMemberId: data.member.id, primaryCategory,
      secondaryCategory: index === 0 ? "A" : "B", mappingKey: `sui_shou_ji|EXPENSE|${primaryCategory}|${index === 0 ? "A" : "B"}`,
      sourceFingerprint: `anchor-review-${id}`, note: `Anchor row ${index === 0 ? "A" : "B"}`,
      status: ImportDraftRowStatus.NEEDS_MAPPING, userDecision: ImportRowDecision.KEEP, duplicateCandidates: [],
    })) });
    await login(page, data.user.email);
    await page.goto(`/records/import?draft=${draft.id}`);
    const selectA = page.locator("#import-mappings select").first();
    const rowB = page.getByTestId("import-review-row").filter({ hasText: "Anchor row B" });
    await selectA.selectOption(data.categoryB.id);
    await rowB.getByLabel(labels.import.skip, { exact: true }).check();
    const originalUrl = page.url();
    const anchor = page.getByTestId("import-review-actions").getByRole("link", { name: labels.import.confirmDisabled, exact: true });
    let confirmations = 0;
    page.on("dialog", () => { confirmations += 1; });
    await confirmNavigation(page, false, () => anchor.click());
    await expect(page).toHaveURL(originalUrl);
    await expect(selectA).toHaveValue(data.categoryB.id);
    await expect(rowB.getByLabel(labels.import.skip, { exact: true })).toBeChecked();
    expect((await prisma.importDraftRow.findUniqueOrThrow({ where: { id: rowIds[1] } })).userDecision).toBe("KEEP");

    await confirmNavigation(page, true, () => anchor.click());
    await expect.poll(async () => (await prisma.importDraftRow.findUniqueOrThrow({ where: { id: rowIds[1] } })).userDecision).toBe("SKIP");
    await expect(page).toHaveURL((url) => url.searchParams.get("draft") === draft.id && url.hash === "#import-mappings");
    await expect(page.locator("#import-mappings select")).toHaveCount(1);
    await expect(selectA).toHaveValue("");
    expect((await prisma.importDraftRow.findUniqueOrThrow({ where: { id: rowIds[0] } })).categoryId).toBeNull();
    expect(confirmations).toBe(2);
  } finally { await prisma.$disconnect(); }
});

for (const hideEntryIndices of [false, true]) {
  const suffix = hideEntryIndices ? " without Navigation API entry indices" : "";
  test(`mapping management preserves its URL and selection when Back is cancelled${suffix}`, async ({ page }) => {
    if (hideEntryIndices) await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined }));
    const prisma = database();
    try {
      const data = await fixture(prisma);
      const rule = await prisma.importCategoryMapping.create({ data: {
        householdId: data.household.id, source: "sui_shou_ji", transactionType: "EXPENSE", primaryCategory: "UI category", secondaryCategory: "Back", categoryId: data.categoryA.id,
      } });
      await login(page, data.user.email);
      await page.goto("/records/import");
      await page.getByRole("link", { name: labels.import.manageMappings, exact: true }).click();
      const select = page.locator(`select[name="managed-mapping:${rule.id}"]`);
      await select.selectOption(data.categoryB.id);
      const originalUrl = page.url();
      await confirmNavigation(page, false, () => page.goBack());
      await expect(page).toHaveURL(originalUrl);
      await expect(select).toHaveValue(data.categoryB.id);
      await confirmNavigation(page, true, () => page.goBack());
      await expect(page).toHaveURL(/\/records\/import$/);
      expect((await prisma.importCategoryMapping.findUniqueOrThrow({ where: { id: rule.id } })).categoryId).toBe(data.categoryA.id);
    } finally { await prisma.$disconnect(); }
  });

  test(`discarding draft mappings on Back still saves separate KEEP/SKIP review choices${suffix}`, async ({ page }) => {
    if (hideEntryIndices) await page.addInitScript(() => Object.defineProperty(window, "navigation", { value: undefined }));
    const prisma = database();
    try {
      const data = await fixture(prisma);
      const primaryCategory = `Pending UI category ${randomUUID()}`;
      const mappingKey = `sui_shou_ji|EXPENSE|${primaryCategory}|Pending`;
      const draft = await prisma.importDraft.create({ data: {
        householdId: data.household.id, ledgerId: data.ledger.id, createdByMemberId: data.member.id, source: "sui_shou_ji", fileName: "ui-review.xlsx",
      } });
      const rowIds = Array.from({ length: 51 }, () => randomUUID());
      await prisma.importDraftRow.createMany({ data: rowIds.map((id, index) => ({
        id, draftId: draft.id, rowNumber: index + 1, transactionType: TransactionType.EXPENSE, occurredAt: new Date("2026-10-13T04:30:00.000Z"), occurredDate: "2026-10-13",
        amountFen: 1234, actorMemberId: data.member.id, createdByMemberId: data.member.id, categoryId: index === 0 ? null : data.categoryA.id,
        primaryCategory, secondaryCategory: index === 0 ? "Pending" : "Ready", mappingKey: index === 0 ? mappingKey : `sui_shou_ji|EXPENSE|${primaryCategory}|Ready`,
        sourceFingerprint: `ui-review-${id}`, note: `UI row ${index + 1}`, status: index === 0 ? ImportDraftRowStatus.NEEDS_MAPPING : ImportDraftRowStatus.READY, userDecision: ImportRowDecision.KEEP, duplicateCandidates: [],
      })) });
      await login(page, data.user.email);
      await page.goto(`/records/import?draft=${draft.id}`);
      await page.getByRole("button", { name: labels.import.nextPage, exact: true }).first().click();
      const row = page.getByTestId("import-review-row").first();
      await expect(row).toContainText("UI row 51");
      const select = page.locator("#import-mappings select").first();
      await select.selectOption(data.categoryB.id);
      await row.getByLabel(labels.import.skip, { exact: true }).check();
      const originalUrl = page.url();
      await confirmNavigation(page, false, () => page.goBack());
      await expect(page).toHaveURL(originalUrl);
      await expect(select).toHaveValue(data.categoryB.id);
      await expect(row.getByLabel(labels.import.skip, { exact: true })).toBeChecked();
      expect((await prisma.importDraftRow.findUniqueOrThrow({ where: { id: rowIds[50] } })).userDecision).toBe("KEEP");
      await confirmNavigation(page, true, () => page.goBack());
      await expect(page).toHaveURL((url) => url.searchParams.get("draft") === draft.id && !url.searchParams.has("page"));
      await expect.poll(async () => (await prisma.importDraftRow.findUniqueOrThrow({ where: { id: rowIds[50] } })).userDecision).toBe("SKIP");
      expect((await prisma.importDraftRow.findUniqueOrThrow({ where: { id: rowIds[0] } })).categoryId).toBeNull();
      await expect(select).toHaveValue("");
    } finally { await prisma.$disconnect(); }
  });
}
