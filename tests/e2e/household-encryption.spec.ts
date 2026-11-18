import { randomUUID } from "node:crypto";
import { readFile } from "node:fs/promises";
import { hash } from "argon2";
import { PrismaClient } from "@prisma/client";
import { getMessages } from "../../src/lib/i18n";
import { chromium, expect, test, type BrowserContext, type Locator, type Page } from "./fixtures";

const owned: Array<{ householdId: string; accountId: string }> = [];
const password = "synthetic-encryption-test-password";

function database() {
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname) || !/dev|test/i.test(url.pathname)) throw new Error("Encryption browser fixtures require a local dev/test database");
  return new PrismaClient();
}

async function fixture(aiProcessingEnabled = false) {
  const prisma = database();
  try {
    const account = await prisma.user.create({ data: { email: `encryption-${randomUUID()}@example.test`, displayName: "Encryption browser owner", emailVerifiedAt: new Date(), passwordHash: await hash(password), aiProcessingEnabled } });
    const household = await prisma.household.create({ data: { name: "Encryption browser household", members: { create: { userId: account.id, memberName: "Encryption owner", role: "OWNER" } }, ledgers: { create: { name: "Default", isDefault: true, acceptsLegacyDrafts: true } } }, include: { members: true, ledgers: true } });
    owned.push({ householdId: household.id, accountId: account.id });
    const category = await prisma.category.findFirstOrThrow({ where: { name: "Dining", type: "EXPENSE", isActive: true } });
    const note = `private-encryption-record-${randomUUID()}`;
    const record = await prisma.transaction.create({ data: { householdId: household.id, ledgerId: household.ledgers[0].id, actorMemberId: household.members[0].id, createdByMemberId: household.members[0].id, categoryId: category.id, type: "EXPENSE", amountFen: 1234, occurredAt: new Date(), note } });
    return { account, household, record, note };
  } finally { await prisma.$disconnect(); }
}

async function expireOriginalSession(accountId: string) {
  const prisma = database();
  try { await prisma.appSession.updateMany({ where: { userId: accountId, revokedAt: null }, data: { expiresAt: new Date(Date.now() - 60_000) } }); }
  finally { await prisma.$disconnect(); }
}

async function login(page: Page, email: string) {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(password);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 20_000 });
}

async function independentlyBackUp(page: Page, settings: Locator) {
  const card = settings.getByTestId("encryption-candidate");
  await expect(card).toBeVisible({ timeout: 15_000 });
  const code = await card.locator("textarea[readonly]").inputValue();
  const files: Buffer[] = [];
  const saveLabels = ["保存解锁码副本", "保存恢复文件", "保存临时操作恢复文件"];
  for (const label of saveLabels) {
    const [download] = await Promise.all([page.waitForEvent("download"), card.getByRole("button", { name: label, exact: true }).click()]);
    const file = await download.path();
    if (!file) throw new Error("Recovery download is unavailable");
    files.push(await readFile(file));
  }
  expect(files[0].toString()).toBe(code);
  expect(files[1].toString()).not.toContain(code);
  expect(files[2].toString()).not.toContain(code);
  const publish = card.getByRole("button", { name: "确认并执行", exact: true });
  await expect(publish).toBeDisabled();
  for (let index = 0; index < files.length; index += 1) await card.locator('input[type="file"]').nth(index).setInputFiles({ name: `verified-${index}.json`, mimeType: "application/json", buffer: files[index] });
  await card.getByRole("checkbox").check();
  await expect(publish).toBeEnabled();
  return { code, files, publish };
}

test.afterEach(async () => {
  const prisma = database();
  try {
    for (const item of owned.splice(0)) {
      await prisma.$transaction([
        prisma.appEvent.deleteMany({ where: { householdId: item.householdId } }),
        prisma.appSession.deleteMany({ where: { userId: item.accountId } }),
        prisma.transaction.deleteMany({ where: { householdId: item.householdId } }),
        prisma.naturalLanguageRequest.deleteMany({ where: { householdId: item.householdId } }),
        prisma.ledgerAuditLog.deleteMany({ where: { householdId: item.householdId } }),
        prisma.encryptionOperation.deleteMany({ where: { householdId: item.householdId } }),
        prisma.householdEncryption.deleteMany({ where: { householdId: item.householdId } }),
        prisma.ledger.deleteMany({ where: { householdId: item.householdId } }),
        prisma.householdMember.deleteMany({ where: { householdId: item.householdId } }),
        prisma.household.deleteMany({ where: { id: item.householdId } }),
        prisma.user.deleteMany({ where: { id: item.accountId } }),
      ]);
    }
  } finally { await prisma.$disconnect(); }
});

test("recovers original operation and accounting UUIDs after lost responses and session expiry, while navigation stays available", async ({ page }) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const current = await fixture(true);
  const operations: Array<{ operation: string; kind?: string; id?: string }> = [];
  let lostPrepare = false;
  let lostCommit = false;
  let faultReceipt: string | undefined;
  await page.route("**/api/household/encryption", async (route) => {
    const body = route.request().postDataJSON() as { operation: string; kind?: string; id?: string };
    operations.push({ operation: body.operation, kind: body.kind, id: body.id });
    if (body.operation === "query" && body.id === faultReceipt) {
      faultReceipt = undefined;
      const response = await route.fetch();
      const value = await response.json();
      value.operation.recoveryDigest = "0".repeat(64);
      await route.fulfill({ response, json: value });
      return;
    }
    if ((!lostPrepare && body.operation === "prepare" && body.kind === "ENABLE")
      || (!lostCommit && body.operation === "commit" && body.kind === "ROTATE")) {
      if (body.operation === "prepare") lostPrepare = true;
      else lostCommit = true;
      const response = await route.fetch();
      expect(response.status()).toBe(200);
      await response.body();
      await route.abort("failed");
      return;
    }
    await route.continue();
  });
  await login(page, current.account.email);
  await page.goto("/account/household");
  const settings = page.getByTestId("household-encryption-settings");
  await settings.getByRole("button", { name: "开启加密", exact: true }).click();
  const first = await independentlyBackUp(page, settings);
  await first.publish.click();
  await expect(settings.getByText("结果待确认，请查询原操作，不要重新生成密钥。", { exact: true })).toBeVisible();
  const originalEnable = operations.find((operation) => operation.operation === "prepare" && operation.kind === "ENABLE")!.id;
  await page.reload();
  const restored = settings.getByTestId("encryption-candidate");
  await expect(restored.locator("textarea[readonly]")).toHaveValue(first.code);
  await restored.getByRole("checkbox").check();
  await restored.getByRole("button", { name: "确认并执行", exact: true }).click();
  await expect(settings.getByText("已加密", { exact: true })).toBeVisible({ timeout: 45_000 });
  expect(operations.filter((operation) => operation.operation === "prepare" && operation.kind === "ENABLE")).toEqual([{ operation: "prepare", kind: "ENABLE", id: originalEnable }]);
  expect(operations.some((operation) => operation.operation === "query" && operation.id === originalEnable)).toBe(true);

  await settings.getByRole("button", { name: "独立更换密钥", exact: true }).click();
  const rotated = await independentlyBackUp(page, settings);
  await rotated.publish.click();
  await expect(settings.getByText("结果待确认，请查询原操作，不要重新生成密钥。", { exact: true })).toBeVisible();
  const originalRotate = operations.find((operation) => operation.operation === "commit" && operation.kind === "ROTATE")!.id;
  await expireOriginalSession(current.account.id);
  await page.goto("/home");
  await expect(page).toHaveURL(/\/login\?reason=session-expired$/);
  await login(page, current.account.email);
  await page.goto("/account/household");
  await expect(restored.locator("textarea[readonly]")).toHaveValue(rotated.code);
  faultReceipt = originalRotate;
  await settings.getByRole("button", { name: "查询原操作", exact: true }).click();
  await expect.poll(() => faultReceipt).toBeUndefined();
  await expect(settings.getByRole("button", { name: "查询原操作", exact: true })).toBeEnabled();
  await expect(settings.getByText("结果待确认，请查询原操作，不要重新生成密钥。", { exact: true })).toBeVisible();
  await expect(restored.locator("textarea[readonly]")).toHaveValue(rotated.code);
  await settings.getByRole("button", { name: "查询原操作", exact: true }).click();
  await expect(settings.getByText("操作已完成", { exact: true })).toBeVisible();
  expect(operations.filter((operation) => operation.operation === "commit" && operation.kind === "ROTATE")).toEqual([{ operation: "commit", kind: "ROTATE", id: originalRotate }]);
  expect(operations.some((operation) => operation.operation === "query" && operation.id === originalRotate)).toBe(true);

  await page.goto("/add");
  await page.getByLabel("金额", { exact: true }).fill("47.82");
  await page.getByRole("button", { name: "添加备注", exact: true }).click();
  const pendingNote = `encrypted-pending-${randomUUID()}`;
  await page.getByLabel("备注", { exact: true }).fill(pendingNote);
  let manualPosts = 0;
  await page.route(/\/add(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST" || !route.request().headers()["next-action"]) { await route.continue(); return; }
    manualPosts += 1;
    if (manualPosts !== 1) { await route.continue(); return; }
    const response = await route.fetch();
    await response.body();
    await route.abort("failed");
  });
  await page.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(page.getByText("保存结果尚未确认", { exact: true })).toBeVisible();
  const prisma = database();
  let originalManual: string;
  try {
    const written = await prisma.transaction.findFirstOrThrow({ where: { householdId: current.household.id, clientRequestId: { not: null } }, select: { clientRequestId: true } });
    originalManual = written.clientRequestId!;
  } finally { await prisma.$disconnect(); }
  const protectedSnapshot = await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith("billboard:transaction-draft:v2:"))?.[1]);
  expect(protectedSnapshot).toBeTruthy();
  expect(protectedSnapshot).not.toContain(pendingNote);
  expect(protectedSnapshot).not.toContain("47.82");
  await expireOriginalSession(current.account.id);
  await page.goto("/home");
  await expect(page).toHaveURL(/\/login\?reason=session-expired$/);
  expect(await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith("billboard:transaction-draft:v2:"))?.[1])).toBe(protectedSnapshot);
  await login(page, current.account.email);
  await page.goto("/add");
  await expect(page.getByText("保存结果尚未确认", { exact: true })).toBeVisible();
  await expect(page.getByLabel("金额", { exact: true })).toHaveValue("47.82");
  await expect(page.getByLabel("备注", { exact: true })).toHaveValue(pendingNote);
  expect(manualPosts).toBe(1);
  await page.getByRole("button", { name: "重新确认保存", exact: true }).click();
  await expect(page.getByLabel("金额", { exact: true })).toHaveValue("");
  const confirmed = database();
  try { expect(await confirmed.transaction.count({ where: { householdId: current.household.id, clientRequestId: originalManual } })).toBe(1); }
  finally { await confirmed.$disconnect(); }
  expect(manualPosts).toBe(2);
  await page.unroute(/\/add(?:\?.*)?$/);

  let release!: () => void;
  let entered!: () => void;
  let responseDelivered = false;
  const actionEntered = new Promise<void>((resolve) => { entered = resolve; });
  const mayRespond = new Promise<void>((resolve) => { release = resolve; });
  await page.route(/\/add(?:\?.*)?$/, async (route) => {
    if (route.request().method() !== "POST" || !route.request().headers()["next-action"]) { await route.continue(); return; }
    const response = route.fetch();
    entered();
    await mayRespond;
    await route.fulfill({ response: await response });
    responseDelivered = true;
  });
  try {
    await page.getByRole("button", { name: "自然语言", exact: true }).click();
    await page.getByRole("textbox", { name: "收支描述", exact: true }).fill("午饭35元 __agent_delayed__");
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await actionEntered;
    await page.getByRole("link", { name: "记录", exact: true }).last().click();
    await expect(page.getByText(pendingNote, { exact: true })).toBeVisible();
    expect(responseDelivered).toBe(false);
  } finally { release(); }
  await expect.poll(() => responseDelivered).toBe(true);
  await page.getByRole("link", { name: "记一笔", exact: true }).last().click();
  await page.getByRole("button", { name: "自然语言", exact: true }).click();
  await expect(page.getByText("已记 1 笔，支出 ¥35.00", { exact: true })).toBeVisible();
  await page.unroute(/\/add(?:\?.*)?$/);

  await page.goto("/account/household");
  await page.getByRole("button", { name: "退出登录", exact: true }).click();
  await expect(page).toHaveURL(/\/login/);
  expect(await page.evaluate(() => Object.keys(sessionStorage).filter((key) => /^(billboard:transaction-draft:|billboard:natural-language-|billboard:voice-)/.test(key)))).toEqual([]);
  await login(page, current.account.email);
  await page.goto("/records");
  await expect(page.getByTestId("household-encryption-gate")).toBeVisible();
  await expect(page.getByLabel("家庭解锁码", { exact: true })).toBeVisible();
  await expect(page.getByText(pendingNote, { exact: true })).toHaveCount(0);
});

test("optionally encrypts, reads with POST, rotates independently and disables after verified backups", async ({ page }, testInfo) => {
  test.setTimeout(180_000);
  page.setDefaultTimeout(15_000);
  await page.setViewportSize({ width: 390, height: 844 });
  await page.emulateMedia({ reducedMotion: "reduce" });
  const current = await fixture();
  await login(page, current.account.email);
  await page.goto("/account/household");
  const settings = page.getByTestId("household-encryption-settings");
  await expect(settings.getByText("未加密", { exact: true })).toBeVisible();
  async function checkCodeDisclosure(title: string, marker: string) {
    const disclosure = settings.locator("details").filter({ has: page.locator("summary").filter({ hasText: title }) });
    await disclosure.locator("summary").click();
    await disclosure.locator("textarea").fill(marker);
    await disclosure.locator("summary").click();
    await expect(disclosure.locator("textarea")).toHaveCount(0);
    expect(await page.locator("input,textarea").evaluateAll((fields, code) => fields.some((field) => (field as HTMLInputElement | HTMLTextAreaElement).value.includes(code)), marker)).toBe(false);
    await disclosure.locator("summary").click();
    await expect(disclosure.locator("textarea")).toHaveValue("");
    await disclosure.locator("summary").click();
  }
  await checkCodeDisclosure("家庭恢复文件", `BBK1.synthetic-history-${randomUUID()}`);
  await checkCodeDisclosure("恢复原操作", `BBK1.synthetic-restore-${randomUUID()}`);
  await settings.getByRole("button", { name: "开启加密", exact: true }).click();
  const first = await independentlyBackUp(page, settings);
  const firstOperationId = JSON.parse(first.files[2].toString()).id as string;
  await checkCodeDisclosure("恢复原操作", `BBK1.synthetic-pending-restore-${randomUUID()}`);
  await expect(settings.getByTestId("encryption-candidate").locator("textarea[readonly]")).toHaveValue(first.code);
  const [retainedOperation] = await Promise.all([page.waitForEvent("download"), settings.getByRole("button", { name: "保存临时操作恢复文件", exact: true }).click()]);
  expect(JSON.parse(await readFile((await retainedOperation.path())!, "utf8")).id).toBe(firstOperationId);
  const requests: Array<{ url: string; headers: Record<string, string>; body: string }> = [];
  page.on("request", (request) => { if (request.url().includes("/api/household/")) requests.push({ url: request.url(), headers: request.headers(), body: request.postData() ?? "" }); });
  await first.publish.click();
  await expect(settings.getByText("已加密", { exact: true })).toBeVisible({ timeout: 45_000 });
  expect(requests.some((request) => request.body.includes('"operation":"prepare"') && request.body.includes(first.code))).toBe(false);
  expect(requests.some((request) => request.body.includes('"operation":"batch"') && request.body.includes(first.code))).toBe(true);
  expect(JSON.parse(requests.find((request) => request.body.includes('"operation":"prepare"'))!.body).id).toBe(firstOperationId);
  for (const request of requests) { expect(request.url).not.toContain(first.code); expect(JSON.stringify(request.headers)).not.toContain(first.code); }
  await settings.getByRole("button", { name: "显示当前解锁码", exact: true }).click();
  await expect(settings.locator("textarea[readonly]")).toHaveValue(first.code);
  await page.locator("main > header").getByRole("link", { name: "BillBoard", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
  await expect(page.getByRole("heading", { name: "首页", exact: true })).toBeVisible();
  await expect(settings).toHaveCount(0);
  expect(await page.locator("input,textarea").evaluateAll((fields) => fields.some((field) => (field as HTMLInputElement | HTMLTextAreaElement).value.includes("BBK1.")))).toBe(false);
  const response = await page.goto("/records");
  expect(await response!.text()).not.toContain(current.note);
  await expect(page.getByText(current.note, { exact: true })).toBeVisible({ timeout: 20_000 });
  const prisma = database();
  try {
    const raw = await prisma.transaction.findUniqueOrThrow({ where: { id: current.record.id } });
    expect(raw.note).not.toBe(current.note);
    expect(raw.encryptedPayload).toMatch(/^BBE1\./);
  } finally { await prisma.$disconnect(); }
  await page.goto("/add");
  await page.getByLabel("金额", { exact: true }).fill("18.60");
  await page.getByRole("button", { name: "添加备注", exact: true }).click();
  await page.getByLabel("备注", { exact: true }).fill("encrypted browser draft");
  await page.getByRole("link", { name: "记录", exact: true }).last().click();
  await expect(page.getByText(current.note, { exact: true })).toBeVisible();
  await page.getByRole("link", { name: "记一笔", exact: true }).last().click();
  await expect(page.getByLabel("金额", { exact: true })).toHaveValue("18.60");
  await expect(page.getByLabel("备注", { exact: true })).toHaveValue("encrypted browser draft");
  await expect.poll(async () => page.evaluate(() => Object.entries(sessionStorage).filter(([key]) => key.startsWith("billboard:transaction-draft:")).map(([, value]) => value).join(""))).not.toContain("encrypted browser draft");
  await page.getByRole("button", { name: "保存记录", exact: true }).click();
  await expect(page.getByLabel("金额", { exact: true })).toHaveValue("", { timeout: 20_000 });
  await page.goto("/records");
  await expect(page.getByText("encrypted browser draft", { exact: true })).toBeVisible();
  await page.getByRole("link").filter({ hasText: "encrypted browser draft" }).click();
  const editor = page.getByRole("dialog", { name: "编辑记录", exact: true });
  await expect(editor).toBeVisible();
  await editor.getByLabel("金额", { exact: true }).fill("20.60");
  await editor.getByLabel("备注", { exact: true }).fill("encrypted browser draft edited");
  await editor.getByRole("button", { name: "保存修改", exact: true }).click();
  await expect(editor).toBeHidden();
  await expect(page.getByText("encrypted browser draft edited", { exact: true })).toBeVisible();
  const labels = getMessages("zh-CN");
  for (const [path, title] of [["/home?mode=all", labels.home.title], ["/records/reconcile", labels.billAnalysis.title], ["/records/import", labels.import.title], ["/records/import/mappings", labels.import.manageMappings], ["/ledgers", labels.ledgers.title]]) {
    await page.goto(path);
    await expect(page.getByRole("heading", { name: title, exact: true })).toBeVisible();
  }
  await page.goto("/account/household");
  await settings.getByRole("button", { name: "独立更换密钥", exact: true }).click();
  const rotated = await independentlyBackUp(page, settings);
  expect(rotated.code).not.toBe(first.code);
  await rotated.publish.click();
  await expect(settings.getByText("操作已完成", { exact: true })).toBeVisible({ timeout: 30_000 });
  await expect(settings.getByText("已加密", { exact: true })).toBeVisible();
  await page.goto("/records");
  await expect(page.getByText(current.note, { exact: true })).toBeVisible();
  await page.goto("/account/household");
  await settings.getByRole("button", { name: "清除此设备的解锁码", exact: true }).click();
  const clearDeviceDialog = page.getByRole("dialog", { name: "清除解锁码和本地草稿", exact: true });
  await expect(clearDeviceDialog).toBeVisible();
  await clearDeviceDialog.getByRole("button", { name: "确认清除", exact: true }).click();
  await expect(clearDeviceDialog).toBeHidden();
  await page.goto("/records");
  await expect(page.getByTestId("household-encryption-gate")).toBeVisible();
  await expect(page.getByText(current.note, { exact: true })).toHaveCount(0);
  expect(await page.evaluate(() => (document as Document & { featurePolicy?: { allowsFeature(name: string): boolean } }).featurePolicy?.allowsFeature("camera"))).toBe(true);
  await page.evaluate(() => {
    Object.defineProperty(window, "BarcodeDetector", { configurable: true, value: class { async detect() { return []; } } });
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => { throw new DOMException("Synthetic camera denial", "NotAllowedError"); } });
  });
  await page.getByRole("button", { name: "扫描本机二维码", exact: true }).click();
  await expect(page.getByText("也可以直接粘贴解锁码。", { exact: true })).toBeVisible();
  await page.getByLabel("家庭解锁码", { exact: true }).fill(rotated.code);
  await page.getByRole("button", { name: "导入并解锁", exact: true }).click();
  await expect(page.getByText(current.note, { exact: true })).toBeVisible();
  await page.goto("/account/household");
  await settings.getByRole("button", { name: "关闭加密", exact: true }).click();
  const disabled = await independentlyBackUp(page, settings);
  await disabled.publish.click();
  await expect(settings.getByText("未加密", { exact: true })).toBeVisible({ timeout: 45_000 });
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
    await page.screenshot({ path: testInfo.outputPath(`household-encryption-settings-${width}.png`), fullPage: true });
  }
  await page.goto("/records");
  await expect(page.getByText(current.note, { exact: true })).toBeVisible();
  const restored = database();
  try { expect((await restored.transaction.findUniqueOrThrow({ where: { id: current.record.id } })).note).toBe(current.note); }
  finally { await restored.$disconnect(); }
});

test("restores protected pending entries after closing and reopening the browser process", async ({ baseURL }, testInfo) => {
  test.setTimeout(180_000);
  const current = await fixture(true);
  const profile = testInfo.outputPath("protected-browser-profile");
  let context: BrowserContext | undefined;
  async function reopen() {
    await context?.close();
    context = await chromium.launchPersistentContext(profile, { headless: true, baseURL, viewport: { width: 390, height: 844 } });
    const page = context.pages()[0] ?? await context.newPage();
    page.setDefaultTimeout(15_000);
    await page.emulateMedia({ reducedMotion: "reduce" });
    return page;
  }
  try {
    let page = await reopen();
    await login(page, current.account.email);
    await page.goto("/account/household");
    const settings = page.getByTestId("household-encryption-settings");
    await settings.getByRole("button", { name: "开启加密", exact: true }).click();
    const backup = await independentlyBackUp(page, settings);
    await backup.publish.click();
    await expect(settings.getByText("已加密", { exact: true })).toBeVisible({ timeout: 45_000 });
    await page.goto("/add");
    await page.getByLabel("金额", { exact: true }).fill("63.29");
    await page.getByRole("button", { name: "添加备注", exact: true }).click();
    const note = `restart-private-${randomUUID()}`;
    await page.getByLabel("备注", { exact: true }).fill(note);
    await page.route(/\/add(?:\?.*)?$/, async (route) => {
      if (route.request().method() !== "POST" || !route.request().headers()["next-action"]) { await route.continue(); return; }
      const response = await route.fetch();
      await response.body();
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "保存记录", exact: true }).click();
    await expect(page.getByText("保存结果尚未确认", { exact: true })).toBeVisible();
    const prisma = database();
    let manualId: string;
    try { manualId = (await prisma.transaction.findFirstOrThrow({ where: { householdId: current.household.id, clientRequestId: { not: null } }, select: { clientRequestId: true } })).clientRequestId!; }
    finally { await prisma.$disconnect(); }
    page = await reopen();
    let postsAfterReopen = 0;
    page.on("request", (request) => { if (request.method() === "POST" && request.headers()["next-action"]) postsAfterReopen += 1; });
    await page.goto("/add");
    await expect(page.getByText("保存结果尚未确认", { exact: true })).toBeVisible();
    await expect(page.getByLabel("金额", { exact: true })).toHaveValue("63.29");
    await expect(page.getByLabel("备注", { exact: true })).toHaveValue(note);
    expect(postsAfterReopen).toBe(0);
    await page.getByRole("button", { name: "重新确认保存", exact: true }).click();
    await expect(page.getByLabel("金额", { exact: true })).toHaveValue("");
    const confirmed = database();
    try { expect(await confirmed.transaction.count({ where: { householdId: current.household.id, clientRequestId: manualId } })).toBe(1); }
    finally { await confirmed.$disconnect(); }

    const text = "午饭35元 __agent_delayed__";
    await page.getByRole("button", { name: "自然语言", exact: true }).click();
    await page.getByRole("textbox", { name: "收支描述", exact: true }).fill(text);
    await page.route(/\/add(?:\?.*)?$/, async (route) => {
      if (route.request().method() !== "POST" || !route.request().headers()["next-action"]) { await route.continue(); return; }
      const response = await route.fetch();
      await response.body();
      await route.abort("failed");
    });
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("记账结果尚未确认", { exact: true })).toBeVisible();
    const originalTextId = await page.evaluate(() => Object.entries(sessionStorage).find(([key]) => key.startsWith("billboard:natural-language-pending:v2:"))?.[1]);
    expect(originalTextId).toMatch(/^[0-9a-f-]{36}$/);
    page = await reopen();
    const restoredQuery = page.waitForRequest((request) => request.method() === "POST" && Boolean(request.headers()["next-action"]) && (request.postData() ?? "").includes(originalTextId!));
    await page.goto("/add");
    const query = await test.step("capture the restored UUID query", async () => await restoredQuery);
    expect(query.postData()).not.toContain(text);
    const response = await test.step("receive the restored query response", async () => await query.response());
    await test.step("finish the restored query response stream", async () => { await response?.finished(); });
    await test.step("clear the restored pending UUID", async () => {
      await expect.poll(() => page.evaluate(() => Object.keys(sessionStorage).filter((key) => key.startsWith("billboard:natural-language-pending:")).length)).toBe(0);
    });
    const restored = database();
    try {
      expect(await restored.naturalLanguageRequest.count({ where: { householdId: current.household.id, clientRequestId: originalTextId } })).toBe(1);
      expect(await restored.transaction.count({ where: { householdId: current.household.id, deletedAt: null } })).toBe(3);
    } finally { await restored.$disconnect(); }
  } finally { await test.step("close the final persistent browser", async () => { await context?.close(); }); }
});
