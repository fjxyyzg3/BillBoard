import { PrismaClient } from "@prisma/client";
import { clearTransactions } from "./db-cleanup";
import { expect, test, type Page } from "./fixtures";
import { prepareVoiceTranscription } from "./voice-admission-fixture";

const ledgerPrefix = "E2E ledger workflow ";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function client() {
  const url = new URL(requireEnv("DATABASE_URL"));
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/(?:dev|test)/i.test(url.pathname)) throw new Error("Multi-ledger fixtures require a local dev/test database");
  return new PrismaClient();
}

async function household() {
  const prisma = client();
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: requireEnv("SEED_USER_A_EMAIL") }, select: { householdMember: { where: { leftAt: null }, take: 1 } } });
    const member = user.householdMember[0];
    if (!member) throw new Error("Seed membership is missing");
    const ledger = await prisma.ledger.findFirstOrThrow({ where: { householdId: member.householdId, isDefault: true } });
    return { member, ledger };
  } finally { await prisma.$disconnect(); }
}

async function transactions() {
  const { member } = await household();
  const prisma = client();
  try { return await prisma.transaction.findMany({ where: { householdId: member.householdId, deletedAt: null }, select: { id: true, ledgerId: true, amountFen: true, note: true } }); }
  finally { await prisma.$disconnect(); }
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
}

async function createLedger(page: Page) {
  const name = `${ledgerPrefix}${Date.now()}`;
  await openLedgerManagement(page);
  await page.getByLabel("新账本名称", { exact: true }).fill(name);
  await page.getByRole("button", { name: "新建账本", exact: true }).click();
  await expect(page.getByRole("link", { name, exact: true })).toBeVisible();
  const prisma = client();
  try { return await prisma.ledger.findFirstOrThrow({ where: { name } }); }
  finally { await prisma.$disconnect(); }
}

async function openLedgerManagement(page: Page) {
  const link = page.getByRole("link", { name: "管理账本", exact: true });
  if (!await link.isVisible()) await page.getByRole("button", { name: "更多选项", exact: true }).click();
  await link.click();
}

async function selectScope(page: Page, ledgerId: string) {
  const select = page.getByRole("combobox", { name: "查看范围", exact: true });
  await select.selectOption(ledgerId);
  await expect.poll(() => new URL(page.url()).searchParams.get("ledger")).toBe(ledgerId);
  await expect(select).toBeEnabled();
}

test.beforeEach(async () => { await clearTransactions(); });
test.afterEach(async () => {
  await clearTransactions();
  const prisma = client();
  try {
    const targets = await prisma.ledger.findMany({ where: { name: { startsWith: ledgerPrefix } }, select: { id: true, householdId: true, isDefault: true } });
    for (const target of targets) if (target.isDefault) {
      const original = await prisma.ledger.findFirstOrThrow({ where: { householdId: target.householdId, name: { not: { startsWith: ledgerPrefix } }, archivedAt: null } });
      await prisma.$transaction([prisma.ledger.update({ where: { id: target.id }, data: { isDefault: false } }), prisma.ledger.update({ where: { id: original.id }, data: { isDefault: true } })]);
    }
    await prisma.ledgerAuditLog.deleteMany({ where: { ledgerId: { in: targets.map((ledger) => ledger.id) } } });
    await prisma.ledger.deleteMany({ where: { id: { in: targets.map((ledger) => ledger.id) } } });
  } finally { await prisma.$disconnect(); }
});

test("creates, renames, moves, archives and restores a ledger without changing household totals", async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await login(page);
  await expect(page.getByRole("combobox", { name: "查看范围", exact: true })).toHaveValue("all");
  const { ledger: original } = await household();
  const target = await createLedger(page);
  const row = page.getByRole("link", { name: target.name, exact: true }).locator("..").locator("..");
  await row.getByRole("button", { name: "重命名", exact: true }).click();
  const renamed = `${target.name} trip`;
  await row.getByLabel("账本名称", { exact: true }).fill(renamed);
  await row.getByRole("button", { name: "保存名称", exact: true }).click();
  await expect(page.getByRole("link", { name: renamed, exact: true })).toBeVisible();
  await selectScope(page, target.id);
  await page.getByRole("link", { name: "记一笔", exact: true }).filter({ visible: true }).click();
  await expect(page.getByRole("combobox", { name: "记入账本", exact: true })).toHaveValue(target.id);
  await page.getByLabel("金额", { exact: true }).fill("18.60");
  await page.getByRole("button", { name: "添加备注", exact: true }).click();
  await page.getByLabel("备注", { exact: true }).fill("Multi-ledger transaction");
  await page.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(page.getByText("记录已保存", { exact: true })).toBeVisible();
  const before = (await transactions())[0];
  expect(before).toMatchObject({ ledgerId: target.id, amountFen: 1860 });
  await page.getByRole("link", { name: "记录", exact: true }).filter({ visible: true }).click();
  await page.getByRole("link").filter({ hasText: "Multi-ledger transaction" }).click();
  const editor = page.getByRole("dialog", { name: "编辑记录", exact: true });
  await editor.getByRole("combobox", { name: "移至账本", exact: true }).selectOption(original.id);
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(editor).toBeHidden();
  const moved = (await transactions())[0];
  expect(moved).toEqual({ ...before, ledgerId: original.id });
  await selectScope(page, "all");
  await expect(page.getByRole("link").filter({ hasText: "Multi-ledger transaction" })).toContainText("-18.60");
  expect((await transactions()).reduce((total, item) => total + item.amountFen, 0)).toBe(1860);
  await page.getByRole("link", { name: "记一笔", exact: true }).filter({ visible: true }).click();
  await page.getByLabel("金额", { exact: true }).fill("12.40");
  await page.getByRole("button", { name: "添加备注", exact: true }).click();
  await page.getByLabel("备注", { exact: true }).fill("Archived ledger history");
  await page.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(page.getByText("记录已保存", { exact: true })).toBeVisible();
  await openLedgerManagement(page);
  await expect(page).toHaveURL(/\/ledgers(?:\?|$)/);
  await selectScope(page, target.id);
  expect(new URL(page.url()).searchParams.has("entryLedger")).toBe(false);
  const renamedRow = page.getByRole("link", { name: renamed, exact: true }).locator("..").locator("..");
  await renamedRow.getByRole("button", { name: "归档", exact: true }).click();
  await renamedRow.getByRole("button", { name: "确认归档", exact: true }).click();
  await expect(renamedRow.getByText("已归档", { exact: true })).toBeVisible();
  expect((await transactions()).reduce((total, item) => total + item.amountFen, 0)).toBe(3100);
  await page.getByRole("link", { name: "记录", exact: true }).filter({ visible: true }).click();
  await page.getByRole("link").filter({ hasText: "Archived ledger history" }).click();
  await expect(editor).toContainText("该账本已归档，请恢复后再修改。");
  await expect(editor.getByRole("button", { name: "保存修改", exact: true })).toBeDisabled();
  await editor.getByRole("button", { name: "关闭", exact: true }).click();
  await expect(editor).toBeHidden();
  await openLedgerManagement(page);
  await renamedRow.getByRole("button", { name: "恢复账本", exact: true }).click();
  await expect(renamedRow.getByRole("button", { name: "归档", exact: true })).toBeVisible();
  expect((await transactions()).reduce((total, item) => total + item.amountFen, 0)).toBe(3100);
});

test("retains per-ledger manual and text drafts across selection and restores the device preference", async ({ page }) => {
  await login(page);
  const { ledger: original } = await household();
  const target = await createLedger(page);
  await page.goto(`/add?ledger=${encodeURIComponent(original.id)}`);
  await page.getByLabel("金额", { exact: true }).fill("23.45");
  await page.getByRole("button", { name: "自然语言", exact: true }).click();
  await page.getByRole("textbox", { name: "收支描述", exact: true }).fill("午饭35元");
  expect(await page.evaluate(() => JSON.stringify(Object.entries(sessionStorage)))).not.toContain("午饭35元");
  await selectScope(page, target.id);
  await expect(page.getByLabel("金额", { exact: true })).toHaveValue("");
  await page.getByLabel("金额", { exact: true }).fill("8.90");
  await selectScope(page, original.id);
  await expect(page.getByLabel("金额", { exact: true })).toHaveValue("23.45");
  await page.getByRole("button", { name: "自然语言", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "收支描述", exact: true })).toHaveValue("午饭35元");
  await selectScope(page, target.id);
  await page.reload();
  await page.goto("/records");
  await expect(page.getByRole("combobox", { name: "查看范围", exact: true })).toHaveValue(target.id);
  await page.goto("/add");
  await expect(page.getByRole("combobox", { name: "记入账本", exact: true })).toHaveValue(target.id);
  await expect(page.getByLabel("金额", { exact: true })).toHaveValue("8.90");
});

test("confirms a lost text result on its original ledger after switching without resending the text", async ({ page }) => {
  await login(page);
  const { ledger: original, member } = await household();
  const target = await createLedger(page);
  await page.goto(`/add?ledger=${encodeURIComponent(original.id)}&mode=year&year=2001&member=${encodeURIComponent(member.id)}`);
  let submitted = 0;
  let dropped = false;
  await page.route(/\/add(?:\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) { await route.continue(); return; }
    const input = request.postData() ?? "";
    if (input.includes("午饭35元")) submitted++;
    if (dropped) { await route.continue(); return; }
    dropped = true;
    const response = await route.fetch();
    await response.body();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "自然语言", exact: true }).click();
  await page.getByRole("textbox", { name: "收支描述", exact: true }).fill("午饭35元");
  await page.getByRole("button", { name: "导入", exact: true }).click();
  await expect(page.getByText("记账结果尚未确认", { exact: true })).toBeVisible();
  const pending = await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith("billboard:natural-language-pending:v2:")));
  expect(pending).toHaveLength(1);
  await selectScope(page, target.id);
  await expect(page.getByRole("combobox", { name: "记入账本", exact: true })).toHaveValue(target.id);
  expect(await page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith("billboard:natural-language-pending:v2:")))).toEqual(pending);
  await page.getByRole("button", { name: "查看待确认记账", exact: true }).click();
  const overlay = page.getByRole("dialog", { name: "语音记账", exact: true });
  await expect(overlay).toContainText(original.name === "Default" ? "默认账本" : original.name);
  await overlay.getByRole("button", { name: "确认记账结果", exact: true }).click();
  await expect(overlay.getByText("已记 1 笔，支出 ¥35.00", { exact: true })).toBeVisible();
  const records = overlay.getByRole("link", { name: "查看记录", exact: true });
  await expect(records).toHaveAttribute("href", `/records?mode=all&ledger=${encodeURIComponent(original.id)}`);
  await records.click();
  await expect(page.getByRole("combobox", { name: "查看范围", exact: true })).toHaveValue(original.id);
  await expect(page.getByText("35.00", { exact: false }).first()).toBeVisible();
  expect(submitted).toBe(1);
  expect(await transactions()).toEqual([expect.objectContaining({ ledgerId: original.id, amountFen: 3500 })]);
});

for (const duringRecording of [false, true]) test(duringRecording ? "keeps the recording target when switching ledgers while recording" : "finishes a background voice task in its original ledger while a different ledger is selected", async ({ page }) => {
  await page.addInitScript(() => {
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.connect(destination); oscillator.start(); await context.resume();
      for (const track of destination.stream.getTracks()) {
        const stop = track.stop.bind(track);
        track.stop = () => { stop(); oscillator.disconnect(); if (context.state !== "closed") void context.close(); };
      }
      return destination.stream;
    } });
  });
  await login(page);
  const { ledger: original } = await household();
  const target = await createLedger(page);
  await page.goto(`/home?ledger=${encodeURIComponent(original.id)}`);
  let transcription: Awaited<ReturnType<typeof prepareVoiceTranscription>> | null = null;
  await page.route("**/api/voice/transcribe", async (route) => { transcription = await prepareVoiceTranscription(route); });
  const add = page.getByRole("link", { name: "记一笔", exact: true }).filter({ visible: true });
  const box = await add.boundingBox();
  if (!box) throw new Error("Voice entry is not visible");
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  const overlay = page.getByRole("dialog", { name: "语音记账", exact: true });
  await expect(overlay.getByText(/^[1-9]\d* \/ 60 s$/)).toBeVisible();
  if (duringRecording) {
    await selectScope(page, target.id);
    await expect(overlay.getByText("正在录音", { exact: true })).toBeVisible();
    await expect(overlay).toContainText(original.name === "Default" ? "默认账本" : original.name);
  }
  await page.mouse.up();
  await expect.poll(() => transcription !== null).toBe(true);
  await expect(overlay).toBeHidden();
  if (!duringRecording) await selectScope(page, target.id);
  await expect(page.getByRole("combobox", { name: "查看范围", exact: true })).toHaveValue(target.id);
  await expect(page.getByTestId("voice-task-status")).toContainText(original.name === "Default" ? "默认账本" : original.name);
  await expect(page.getByTestId("voice-task-status")).not.toContainText(target.name);
  await transcription!.fulfill("午饭35元");
  await expect(page.getByTestId("voice-success-notice")).toContainText(original.name === "Default" ? "默认账本" : original.name);
  expect(await transactions()).toEqual([expect.objectContaining({ ledgerId: original.id, amountFen: 3500 })]);
});
