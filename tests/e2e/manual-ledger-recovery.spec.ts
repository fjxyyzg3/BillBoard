import { randomUUID } from "node:crypto";
import { PrismaClient } from "@prisma/client";
import { clearTransactions } from "./db-cleanup";
import { expect, test, type Page } from "./fixtures";

const ownedLedgerIds: string[] = [];
const ownedCategoryIds: string[] = [];
const legacyMarkerRestores: Array<{ id: string; acceptsLegacyDrafts: boolean }> = [];

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function client() {
  const url = new URL(requireEnv("DATABASE_URL"));
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname)
    || !/(?:dev|test)/i.test(url.pathname)) throw new Error("Manual recovery fixtures require a local dev/test database");
  return new PrismaClient();
}

async function fixture() {
  const prisma = client();
  try {
    const user = await prisma.user.findUniqueOrThrow({
      where: { email: requireEnv("SEED_USER_A_EMAIL") },
      select: { householdMember: { where: { leftAt: null }, take: 1 } },
    });
    const member = user.householdMember[0];
    if (!member) throw new Error("Seed membership is missing");
    const original = await prisma.ledger.findFirstOrThrow({ where: { householdId: member.householdId, isDefault: true } });
    let legacy = await prisma.ledger.findFirst({ where: { householdId: member.householdId, acceptsLegacyDrafts: true } });
    if (!legacy) {
      // A freshly seeded household has no historical-client compatibility marker.
      legacyMarkerRestores.push({ id: original.id, acceptsLegacyDrafts: original.acceptsLegacyDrafts });
      legacy = await prisma.ledger.update({ where: { id: original.id }, data: { acceptsLegacyDrafts: true } });
    }
    if (legacy.archivedAt) throw new Error("The original legacy fixture ledger must be active");
    const alternate = await prisma.ledger.create({ data: { householdId: member.householdId, name: `E2E manual recovery ${randomUUID()}` } });
    ownedLedgerIds.push(alternate.id);
    const category = await prisma.category.create({ data: {
      name: `E2E recovery ${randomUUID()}`, type: "EXPENSE", sortOrder: -100,
    } });
    ownedCategoryIds.push(category.id);
    return { member, original, alternate, legacy, category };
  } finally { await prisma.$disconnect(); }
}

type Fixture = Awaited<ReturnType<typeof fixture>>;

async function setCategoryActive(current: Fixture, isActive: boolean) {
  const prisma = client();
  try { await prisma.category.update({ where: { id: current.category.id }, data: { isActive } }); }
  finally { await prisma.$disconnect(); }
}

async function savedTransactions(current: Fixture) {
  const prisma = client();
  try {
    return await prisma.transaction.findMany({
      where: { householdId: current.member.householdId, categoryId: current.category.id, deletedAt: null },
      select: { id: true, ledgerId: true, clientRequestId: true, amountFen: true },
    });
  } finally { await prisma.$disconnect(); }
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
}

async function selectScope(page: Page, ledgerId: string) {
  const select = page.getByRole("combobox", { name: "查看范围", exact: true });
  await select.selectOption(ledgerId);
  await expect.poll(() => new URL(page.url()).searchParams.get("ledger")).toBe(ledgerId);
  await expect(select).toBeEnabled();
  await expect(page.getByRole("combobox", { name: "记入账本", exact: true })).toHaveValue(ledgerId);
}

function draftKey(current: Fixture, ledgerId = current.original.id) {
  return `billboard:transaction-draft:v2:${[current.member.householdId, current.member.id, ledgerId].map(encodeURIComponent).join(":")}`;
}

async function storedDraft(page: Page, key: string) {
  return page.evaluate((storageKey) => sessionStorage.getItem(storageKey), key);
}

async function fillExpense(page: Page, amount: string, note: string, categoryName: string) {
  await page.getByLabel("金额", { exact: true }).fill(amount);
  await page.getByRole("radio", { name: categoryName, exact: true }).check();
  const noteInput = page.getByLabel("备注", { exact: true });
  // An exiting note input can still be visible after success; reopen using the current toggle state.
  const expandNote = page.getByRole("button", { name: "添加备注", exact: true });
  if (await expandNote.isVisible()) await expandNote.click();
  await noteInput.fill(note);
}

async function pauseFirstActionResponse(page: Page) {
  const state = { received: false, actionPosts: 0 };
  let intercepted = false;
  let release = () => {};
  let delivered = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  const delivery = new Promise<void>((resolve) => { delivered = resolve; });
  await page.route(/\/add(?:\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) { await route.continue(); return; }
    state.actionPosts++;
    if (intercepted) { await route.continue(); return; }
    intercepted = true;
    try {
      const response = await route.fetch();
      const body = await response.body();
      state.received = true;
      await released;
      await route.fulfill({ response, body });
    } finally { delivered(); }
  });
  return {
    state,
    async release() {
      release();
      if (!intercepted) return;
      await delivery;
      // Let the Flight result and the old component's promise continuation settle.
      await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    },
  };
}

test.beforeEach(async () => { await clearTransactions(); });

test.afterEach(async () => {
  const prisma = client();
  try {
    const rows = await prisma.transaction.findMany({ where: { categoryId: { in: ownedCategoryIds } }, select: { id: true } });
    await prisma.ledgerAuditLog.deleteMany({ where: { OR: [
      { ledgerId: { in: ownedLedgerIds } }, { targetId: { in: rows.map(({ id }) => id) } },
    ] } });
    await clearTransactions();
    await prisma.ledger.deleteMany({ where: { id: { in: ownedLedgerIds.splice(0) } } });
    await prisma.category.deleteMany({ where: { id: { in: ownedCategoryIds.splice(0) } } });
  } finally {
    try {
      for (const previous of legacyMarkerRestores.splice(0)) {
        await prisma.ledger.update({ where: { id: previous.id }, data: { acceptsLegacyDrafts: previous.acceptsLegacyDrafts } });
      }
    } finally { await prisma.$disconnect(); }
  }
});

for (const lateResult of ["success", "error"] as const) {
  test(`preserves a newer ledger draft when an unmounted manual request returns late ${lateResult}`, async ({ page }) => {
    const current = await fixture();
    await login(page);
    await page.goto(`/add?ledger=${encodeURIComponent(current.original.id)}&entryLedger=${encodeURIComponent(current.original.id)}`);
    await fillExpense(page, "18.60", "Manual recovery original request", current.category.name);
    const paused = await pauseFirstActionResponse(page);
    // A private fixture category makes the first error a real server validation result.
    if (lateResult === "error") await setCategoryActive(current, false);
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await expect.poll(() => paused.state.received).toBe(true);
    try {
      if (lateResult === "error") await setCategoryActive(current, true);
      const key = draftKey(current);
      const original = JSON.parse((await storedDraft(page, key))!) as { clientRequestId: string; status: string };
      expect(original.status).toBe("awaiting-confirmation");
      expect(original.clientRequestId).toEqual(expect.any(String));
      expect(await savedTransactions(current)).toHaveLength(lateResult === "success" ? 1 : 0);

      await selectScope(page, current.alternate.id);
      await expect(page.getByLabel("金额", { exact: true })).toHaveValue("");
      await selectScope(page, current.original.id);
      await expect(page.getByText("保存结果尚未确认", { exact: true })).toBeVisible();
      expect(JSON.parse((await storedDraft(page, key))!).clientRequestId).toBe(original.clientRequestId);
      await page.getByRole("button", { name: "重新确认保存", exact: true }).click();
      await expect(page.getByText("记录已保存", { exact: true })).toBeVisible();
      expect(await savedTransactions(current)).toEqual([expect.objectContaining({
        ledgerId: current.original.id, clientRequestId: original.clientRequestId, amountFen: 1860,
      })]);

      await fillExpense(page, "31.42", "Manual recovery newer unsaved draft", current.category.name);
      const newer = await storedDraft(page, key);
      expect(JSON.parse(newer!)).toMatchObject({ status: "draft", clientRequestId: null,
        payload: { amount: "31.42", note: "Manual recovery newer unsaved draft" } });
      await paused.release();

      expect(await storedDraft(page, key)).toBe(newer);
      await expect(page.getByLabel("金额", { exact: true })).toHaveValue("31.42");
      expect(paused.state.actionPosts).toBe(2);
      expect(await savedTransactions(current)).toHaveLength(1);
    } finally { await paused.release(); }
  });
}

test("retains a legacy manual draft when its original ledger migration cannot write scoped storage", async ({ page }) => {
  const current = await fixture();
  await login(page);
  const legacyKey = `billboard:transaction-draft:v1:${current.member.id}`;
  const scopedKey = draftKey(current, current.legacy.id);
  const serialized = JSON.stringify({ version: 1, memberId: current.member.id, payload: {
    type: "expense", amount: "24.68", categoryId: current.category.id, actorMemberId: current.member.id,
    occurredAt: "2026-10-21T10:30", note: "Manual recovery legacy draft",
  }, clientRequestId: null, status: "draft", savedAt: new Date().toISOString() });
  await page.addInitScript(({ legacyKey, scopedKey, serialized }) => {
    sessionStorage.setItem(legacyKey, serialized);
    const setItem = Storage.prototype.setItem;
    Storage.prototype.setItem = function (key: string, value: string) {
      if (this === sessionStorage && key === scopedKey) {
        const fixtureWindow = window as typeof window & { manualRecoveryQuotaFailures?: number };
        fixtureWindow.manualRecoveryQuotaFailures = (fixtureWindow.manualRecoveryQuotaFailures ?? 0) + 1;
        throw new DOMException("Synthetic manual draft quota failure", "QuotaExceededError");
      }
      return setItem.call(this, key, value);
    };
  }, { legacyKey, scopedKey, serialized });
  await page.goto(`/add?ledger=${encodeURIComponent(current.legacy.id)}&entryLedger=${encodeURIComponent(current.legacy.id)}`);
  await expect(page.getByLabel("金额", { exact: true })).toHaveValue("24.68");
  expect(await page.evaluate(() => (window as typeof window & { manualRecoveryQuotaFailures?: number }).manualRecoveryQuotaFailures)).toBeGreaterThan(0);
  expect(await storedDraft(page, scopedKey)).toBeNull();
  expect(await storedDraft(page, legacyKey)).toBe(serialized);
  expect(await savedTransactions(current)).toHaveLength(0);
});
