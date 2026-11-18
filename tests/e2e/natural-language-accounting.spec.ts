import { PrismaClient } from "@prisma/client";
import { getCurrentShanghaiDateTimeLocal, parseShanghaiDateTimeLocal } from "../../src/lib/transactions/datetime";
import { clearTransactions } from "./db-cleanup";
import { expect, test, type Page } from "./fixtures";

const pendingKeyPrefix = "billboard:natural-language-pending:v2:";
const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const twoExpenses = "午饭35元，打车22元";
const incompleteExpenses = "午饭35元，打车忘了多少钱";
const mixedTransactions = "工资转账到账8000元，午饭花了35元";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function createSafeDatabaseClient() {
  const url = new URL(requireEnv("DATABASE_URL"));
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname)
    || !/(?:dev|test)/i.test(url.pathname.replace(/^\//, ""))) {
    throw new Error("Natural-language fixtures require a local dev/test database");
  }
  return new PrismaClient();
}

async function ledgerSnapshot() {
  const prisma = createSafeDatabaseClient();
  try {
    const [owner, spouse] = await Promise.all(["SEED_USER_A_EMAIL", "SEED_USER_B_EMAIL"].map((key) => prisma.user.findUniqueOrThrow({
      where: { email: requireEnv(key) }, select: { householdMember: { where: { leftAt: null }, take: 1, select: { id: true, householdId: true } } },
    })));
    if (!owner.householdMember[0] || !spouse.householdMember[0]) throw new Error("Seed members are missing");
    const householdId = owner.householdMember[0].householdId;
    const ledger = await prisma.ledger.findFirstOrThrow({ where: { householdId, isDefault: true } });
    const [transactions, requests] = await Promise.all([
      prisma.transaction.findMany({
        where: { householdId, deletedAt: null }, orderBy: [{ note: "asc" }, { id: "asc" }],
        select: {
          id: true, type: true, note: true, amountFen: true, occurredAt: true, actorMemberId: true, createdByMemberId: true,
          source: true, sourceFingerprint: true, sourceImportedAt: true, category: { select: { name: true } },
        },
      }),
      prisma.naturalLanguageRequest.findMany({
        where: { householdId, createdByMemberId: owner.householdMember[0].id }, orderBy: [{ createdAt: "asc" }, { id: "asc" }],
        select: { clientRequestId: true, inputHash: true, referenceAt: true, status: true, errorCode: true, issues: true },
      }),
    ]);
    return { owner: owner.householdMember[0], spouse: spouse.householdMember[0], ledger, transactions, requests };
  } finally {
    await prisma.$disconnect();
  }
}

async function logInAndOpen(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
  await page.goto("/add");
  await expect(page.getByLabel("金额", { exact: true })).toBeEditable();
}

async function openNaturalLanguage(page: Page) {
  await page.getByRole("button", { name: "自然语言", exact: true }).click();
  await expect(page.getByRole("textbox", { name: "收支描述", exact: true })).toBeEditable();
}

async function pendingEntries(page: Page) {
  return page.evaluate((prefix) => Object.entries(window.sessionStorage)
    .filter(([key]) => key.startsWith(prefix)), pendingKeyPrefix);
}

function naturalLanguageFeedback(page: Page) {
  return page.locator("form").filter({ has: page.locator('textarea[name="description"]') }).getByRole("alert");
}

async function dropFirstAction(page: Page, afterResponse: boolean) {
  const state = { actionCount: 0, dropped: false };
  await page.route(/\/add(?:\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) {
      await route.continue();
      return;
    }
    state.actionCount += 1;
    if (state.dropped) {
      await route.continue();
      return;
    }
    state.dropped = true;
    if (afterResponse) {
      const response = await route.fetch();
      await response.body();
    }
    await route.abort("failed");
  });
  return state;
}

async function replaceFirstSuccessWithLegacyShape(page: Page) {
  const state = { actionCount: 0, replaced: false };
  await page.route(/\/add(?:\?.*)?$/, async (route) => {
    const request = route.request();
    if (request.method() !== "POST" || !request.headers()["next-action"]) {
      await route.continue();
      return;
    }
    state.actionCount += 1;
    if (state.actionCount !== 1) {
      await route.continue();
      return;
    }
    const response = await route.fetch();
    const body = (await response.text()).split("\n").map((line) => {
      const colon = line.indexOf(":");
      if (colon < 0) return line;
      try {
        const value: unknown = JSON.parse(line.slice(colon + 1));
        if (value && typeof value === "object" && "status" in value && value.status === "success"
          && "requestId" in value && "count" in value && "incomeAmountFen" in value && "expenseAmountFen" in value) {
          state.replaced = true;
          return `${line.slice(0, colon + 1)}${JSON.stringify({
            status: "success", requestId: value.requestId, count: value.count,
            totalAmountFen: Number(value.incomeAmountFen) + Number(value.expenseAmountFen),
          })}`;
        }
      } catch {
        // Flight rows outside the action result are preserved verbatim.
      }
      return line;
    }).join("\n");
    await route.fulfill({ response, body });
  });
  return state;
}

test.describe("natural-language accounting", () => {
  test.beforeEach(async () => {
    await clearTransactions();
  });

  test("preserves both drafts across mode switches with one natural-language input and a reachable mobile import", async ({ page }, testInfo) => {
    await page.setViewportSize({ width: 390, height: 844 });
    await logInAndOpen(page);
    await expect(page.getByRole("button", { name: "手工填写", exact: true })).toHaveAttribute("aria-pressed", "true");
    await page.getByLabel("金额", { exact: true }).fill("23.45");
    await page.getByRole("radio", { name: requireEnv("SEED_USER_B_NAME"), exact: true }).check();
    await page.getByRole("button", { name: "添加备注", exact: true }).click();
    await page.getByLabel("备注", { exact: true }).fill("Synthetic manual draft");
    await openNaturalLanguage(page);
    const description = page.getByRole("textbox", { name: "收支描述", exact: true });
    await description.fill(twoExpenses);
    const naturalForm = page.locator("form").filter({ has: description });
    await expect(naturalForm.getByRole("textbox")).toHaveCount(1);
    await expect(naturalForm.locator("input:visible, select:visible")).toHaveCount(0);
    await expect(naturalForm.getByRole("button")).toHaveCount(1);
    await page.getByRole("button", { name: "手工填写", exact: true }).click();
    await expect(page.getByLabel("金额", { exact: true })).toHaveValue("23.45");
    await expect(page.getByLabel("备注", { exact: true })).toHaveValue("Synthetic manual draft");
    await expect(page.getByRole("radio", { name: requireEnv("SEED_USER_B_NAME"), exact: true })).toBeChecked();
    await openNaturalLanguage(page);
    await expect(description).toHaveValue(twoExpenses);
    const button = naturalForm.getByRole("button", { name: "导入", exact: true });
    const navigation = page.locator("nav").filter({ has: page.getByRole("link", { name: "记一笔", exact: true }) }).last();
    for (const height of [844, 480]) {
      await page.setViewportSize({ width: 390, height });
      await description.focus();
      await expect(button).toBeInViewport();
      const buttonBox = await button.boundingBox();
      const navigationBox = await navigation.boundingBox();
      expect(buttonBox).not.toBeNull();
      expect(navigationBox).not.toBeNull();
      expect(buttonBox!.y + buttonBox!.height).toBeLessThanOrEqual(navigationBox!.y);
      expect(await page.evaluate(() => document.documentElement.scrollWidth)).toBeLessThanOrEqual(390);
    }
    await page.screenshot({ path: testInfo.outputPath("natural-language-mobile.png"), fullPage: true });
    expect((await ledgerSnapshot()).transactions).toHaveLength(0);
  });

  test("records two expenses atomically and displays the total and records without reloading", async ({ page }) => {
    await logInAndOpen(page);
    await openNaturalLanguage(page);
    await page.evaluate(() => {
      (window as typeof window & { naturalLanguageMarker?: string }).naturalLanguageMarker = "preserved";
    });
    await page.getByRole("textbox", { name: "收支描述", exact: true }).fill(twoExpenses);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("已记 2 笔，支出 ¥57.00", { exact: true })).toBeVisible();
    await expect(page.getByRole("textbox", { name: "收支描述", exact: true })).toHaveValue("");
    expect(await page.evaluate(() => (window as typeof window & { naturalLanguageMarker?: string }).naturalLanguageMarker)).toBe("preserved");
    const snapshot = await ledgerSnapshot();
    expect(snapshot.transactions).toHaveLength(2);
    expect(snapshot.transactions.map(({ amountFen }) => amountFen).sort((a, b) => a - b)).toEqual([2200, 3500]);
    expect(snapshot.transactions.map(({ category }) => category.name).sort()).toEqual(["Dining", "Transport"]);
    for (const entry of snapshot.transactions) {
      expect(entry).toMatchObject({ actorMemberId: snapshot.owner.id, createdByMemberId: snapshot.owner.id,
        source: null, sourceFingerprint: null, sourceImportedAt: null });
      expect(entry.occurredAt).toEqual(snapshot.requests[0].referenceAt);
    }
    expect(await pendingEntries(page)).toEqual([]);
    await page.getByRole("link", { name: "记录", exact: true }).click();
    await expect(page.getByRole("link").filter({ hasText: "午饭" })).toContainText("-35.00");
    await expect(page.getByRole("link").filter({ hasText: "打车" })).toContainText("-22.00");
  });

  test("records mixed income and expenses with separate totals and existing record types", async ({ page }) => {
    await logInAndOpen(page);
    await openNaturalLanguage(page);
    const description = page.getByRole("textbox", { name: "收支描述", exact: true });
    await description.fill(mixedTransactions);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("已记 2 笔，收入 ¥8,000.00，支出 ¥35.00", { exact: true })).toBeVisible();
    await expect(description).toHaveValue("");
    const saved = await ledgerSnapshot();
    expect(saved.transactions).toHaveLength(2);
    expect(saved.transactions.find(({ type }) => type === "INCOME")).toMatchObject({
      amountFen: 800000, category: { name: "Salary" }, actorMemberId: saved.owner.id, createdByMemberId: saved.owner.id,
      source: null, sourceFingerprint: null, sourceImportedAt: null,
    });
    expect(saved.transactions.find(({ type }) => type === "EXPENSE")).toMatchObject({
      amountFen: 3500, category: { name: "Dining" }, actorMemberId: saved.owner.id, createdByMemberId: saved.owner.id,
      source: null, sourceFingerprint: null, sourceImportedAt: null,
    });
    expect(saved.requests).toHaveLength(1);
    expect(await pendingEntries(page)).toEqual([]);
    await page.getByRole("link", { name: "记录", exact: true }).click();
    await expect(page.getByRole("link").filter({ hasText: "工资" })).toContainText("+8000.00");
    await expect(page.getByRole("link").filter({ hasText: "午饭" })).toContainText("-35.00");
  });

  test("adds recipient-owned bonus and refund income without changing the original expense", async ({ page }) => {
    await logInAndOpen(page);
    await openNaturalLanguage(page);
    const description = page.getByRole("textbox", { name: "收支描述", exact: true });
    await description.fill("午饭35元");
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("已记 1 笔，支出 ¥35.00", { exact: true })).toBeVisible();
    const original = (await ledgerSnapshot()).transactions[0];
    await description.fill("老婆昨天收到单位奖金500元，我今天收到退款100元");
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("已记 2 笔，收入 ¥600.00", { exact: true })).toBeVisible();
    const saved = await ledgerSnapshot();
    expect(saved.transactions).toHaveLength(3);
    expect(saved.transactions.find(({ id }) => id === original.id)).toEqual(original);
    const reference = saved.requests[1].referenceAt;
    expect(reference).not.toBeNull();
    const today = getCurrentShanghaiDateTimeLocal(reference!).split("T")[0];
    const yesterday = getCurrentShanghaiDateTimeLocal(new Date(reference!.getTime() - 24 * 60 * 60 * 1000)).split("T")[0];
    expect(saved.transactions.find(({ note }) => note === "奖金")).toMatchObject({
      type: "INCOME", amountFen: 50000, category: { name: "Bonus" }, actorMemberId: saved.spouse.id,
      createdByMemberId: saved.owner.id, occurredAt: parseShanghaiDateTimeLocal(`${yesterday}T00:00`),
      source: null, sourceFingerprint: null, sourceImportedAt: null,
    });
    expect(saved.transactions.find(({ note }) => note === "退款")).toMatchObject({
      type: "INCOME", amountFen: 10000, category: { name: "Refund" }, actorMemberId: saved.owner.id,
      createdByMemberId: saved.owner.id, occurredAt: parseShanghaiDateTimeLocal(`${today}T00:00`),
      source: null, sourceFingerprint: null, sourceImportedAt: null,
    });
    await expect(description).toHaveValue("");
  });

  test("rejects a whole mixed batch with a missing amount and rejects pure transfers", async ({ page }) => {
    await logInAndOpen(page);
    await openNaturalLanguage(page);
    const description = page.getByRole("textbox", { name: "收支描述", exact: true });
    const text = "工资到账8000元，午饭忘了多少钱";
    await description.fill(text);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(naturalLanguageFeedback(page).locator("q")).toHaveText("午饭忘了多少钱");
    await expect(description).toHaveValue(text);
    await expect(description).toBeEditable();
    expect((await ledgerSnapshot()).transactions).toHaveLength(0);
    await description.fill("我转账给老婆100元");
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(naturalLanguageFeedback(page)).toContainText("不记账户互转");
    await expect(description).toHaveValue("我转账给老婆100元");
    expect((await ledgerSnapshot()).transactions).toHaveLength(0);
  });

  test("keeps the whole text and missing-amount fragment without partial records, then imports a new request", async ({ page }) => {
    await logInAndOpen(page);
    await openNaturalLanguage(page);
    const description = page.getByRole("textbox", { name: "收支描述", exact: true });
    await description.fill(incompleteExpenses);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(naturalLanguageFeedback(page)).toContainText("本段文字尚未入账");
    await expect(naturalLanguageFeedback(page)).toContainText("请补充金额");
    await expect(naturalLanguageFeedback(page).locator("q")).toHaveText("打车忘了多少钱");
    await expect(description).toHaveValue(incompleteExpenses);
    await expect(description).toBeEditable();
    await expect(description).toHaveAttribute("aria-invalid", "true");
    await expect(description).toHaveAccessibleDescription(/请补充金额/);
    await expect(description).toBeFocused();
    const failed = await ledgerSnapshot();
    expect(failed.transactions).toHaveLength(0);
    expect(failed.requests).toHaveLength(1);
    expect(failed.requests[0].errorCode).toBe("NEEDS_CORRECTION");
    await description.fill(twoExpenses);
    await expect(description).not.toHaveAttribute("aria-invalid", "true");
    await expect(description).not.toHaveAccessibleDescription(/请补充金额/);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("已记 2 笔，支出 ¥57.00", { exact: true })).toBeVisible();
    const saved = await ledgerSnapshot();
    expect(saved.transactions).toHaveLength(2);
    expect(saved.requests).toHaveLength(2);
    expect(new Set(saved.requests.map(({ clientRequestId }) => clientRequestId)).size).toBe(2);
  });

  test("uses the explicit paying member and Shanghai relative dates while retaining the submitting creator", async ({ page }) => {
    await logInAndOpen(page);
    await openNaturalLanguage(page);
    await page.getByRole("textbox", { name: "收支描述", exact: true }).fill("昨天老婆付了午饭35元，我今天打车22元");
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("已记 2 笔，支出 ¥57.00", { exact: true })).toBeVisible();
    const saved = await ledgerSnapshot();
    const reference = saved.requests[0].referenceAt;
    expect(reference).not.toBeNull();
    const today = getCurrentShanghaiDateTimeLocal(reference!).split("T")[0];
    const yesterday = getCurrentShanghaiDateTimeLocal(new Date(reference!.getTime() - 24 * 60 * 60 * 1000)).split("T")[0];
    expect(saved.transactions.find(({ note }) => note === "午饭")).toMatchObject({
      actorMemberId: saved.spouse.id, createdByMemberId: saved.owner.id, occurredAt: parseShanghaiDateTimeLocal(`${yesterday}T00:00`),
    });
    expect(saved.transactions.find(({ note }) => note === "打车")).toMatchObject({
      actorMemberId: saved.owner.id, createdByMemberId: saved.owner.id, occurredAt: parseShanghaiDateTimeLocal(`${today}T00:00`),
    });
  });

  test("provides English input, error and success messages", async ({ page }) => {
    await logInAndOpen(page);
    if (!await page.getByRole("button", { name: "切换语言", exact: true }).first().isVisible()) {
      await page.getByRole("button", { name: "更多选项", exact: true }).first().click();
    }
    await page.getByRole("button", { name: "切换语言", exact: true }).first().click();
    await page.getByRole("button", { name: "Natural language", exact: true }).click();
    const description = page.getByRole("textbox", { name: "Describe transactions", exact: true });
    await expect(description).toHaveAttribute("placeholder", "Salary received ¥8000, lunch ¥35");
    await description.fill("Lunch 35 CNY, taxi amount forgotten");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(naturalLanguageFeedback(page)).toContainText("Nothing from this text was recorded");
    await expect(naturalLanguageFeedback(page)).toContainText("Add the amount");
    await description.fill("Lunch 35 CNY, taxi 22 CNY");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByText("2 transactions recorded, expenses ¥57.00", { exact: true })).toBeVisible();
    await expect(description).toHaveValue("");
    expect((await ledgerSnapshot()).transactions).toHaveLength(2);
    await description.fill("Salary received 8000 CNY, lunch 35 CNY");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByText("2 transactions recorded, income ¥8,000.00, expenses ¥35.00", { exact: true })).toBeVisible();
    await description.fill("Refund received 100 CNY");
    await page.getByRole("button", { name: "Import", exact: true }).click();
    await expect(page.getByText("1 transaction recorded, income ¥100.00", { exact: true })).toBeVisible();
    const saved = await ledgerSnapshot();
    expect(saved.transactions).toHaveLength(5);
    expect(saved.transactions.filter(({ type }) => type === "INCOME")).toHaveLength(2);
    expect(saved.transactions.filter(({ type }) => type === "EXPENSE")).toHaveLength(3);
  });

  test("freezes the snapshot and modes while pending and stores only its member-scoped UUID", async ({ page }) => {
    await logInAndOpen(page);
    await openNaturalLanguage(page);
    const description = page.getByRole("textbox", { name: "收支描述", exact: true });
    const text = "午饭35元 __agent_delayed__";
    await description.fill(text);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByRole("button", { name: "处理中…", exact: true })).toBeDisabled();
    await expect(description).toBeDisabled();
    await expect(page.getByRole("button", { name: "手工填写", exact: true })).toBeDisabled();
    await expect(page.getByRole("button", { name: "自然语言", exact: true })).toBeDisabled();
    const entries = await pendingEntries(page);
    expect(entries).toHaveLength(1);
    expect(entries[0][1]).toMatch(uuidPattern);
    const stored = await page.evaluate(() => JSON.stringify({ session: { ...window.sessionStorage }, local: { ...window.localStorage } }));
    expect(stored).not.toContain(text);
    expect(stored).not.toContain("午饭");
    expect(stored).not.toContain("amountFen");
    await expect(page.getByText("已记 1 笔，支出 ¥35.00", { exact: true })).toBeVisible();
    expect(await pendingEntries(page)).toEqual([]);
    const saved = await ledgerSnapshot();
    expect(saved.requests[0].clientRequestId).toBe(entries[0][1]);
    expect(entries[0][0]).toBe(`${pendingKeyPrefix}${[saved.owner.householdId, saved.owner.id, saved.ledger.id].map(encodeURIComponent).join(":")}`);
  });

  test("confirms a committed response lost in transit without repeating its expenses", async ({ page }) => {
    await logInAndOpen(page);
    await openNaturalLanguage(page);
    const network = await dropFirstAction(page, true);
    const description = page.getByRole("textbox", { name: "收支描述", exact: true });
    await description.fill(twoExpenses);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("记账结果尚未确认", { exact: true })).toBeVisible();
    await expect(description).toBeDisabled();
    await expect(description).toHaveValue(twoExpenses);
    const pending = await pendingEntries(page);
    expect(pending).toHaveLength(1);
    const committed = await ledgerSnapshot();
    expect(committed.transactions).toHaveLength(2);
    expect(committed.requests[0].clientRequestId).toBe(pending[0][1]);
    await page.getByRole("button", { name: "确认记账结果", exact: true }).click();
    await expect(page.getByText("已记 2 笔，支出 ¥57.00", { exact: true })).toBeVisible();
    expect(network.actionCount).toBe(2);
    const confirmed = await ledgerSnapshot();
    expect(confirmed.transactions).toEqual(committed.transactions);
    expect(confirmed.requests).toHaveLength(1);
    expect(await pendingEntries(page)).toEqual([]);
  });

  test("retains a committed mixed request when an old success shape arrives and confirms it after refresh", async ({ page }) => {
    await logInAndOpen(page);
    await openNaturalLanguage(page);
    const network = await replaceFirstSuccessWithLegacyShape(page);
    const description = page.getByRole("textbox", { name: "收支描述", exact: true });
    await description.fill(mixedTransactions);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("记账结果尚未确认", { exact: true })).toBeVisible();
    expect(network.replaced).toBe(true);
    await expect(description).toBeDisabled();
    await expect(description).toHaveValue(mixedTransactions);
    await expect(page.getByRole("button", { name: "手工填写", exact: true })).toBeDisabled();
    await expect(page.getByText(/已记 2 笔/)).toHaveCount(0);
    const pending = await pendingEntries(page);
    expect(pending).toHaveLength(1);
    const committed = await ledgerSnapshot();
    expect(committed.transactions).toHaveLength(2);
    expect(committed.requests[0].clientRequestId).toBe(pending[0][1]);
    await page.reload();
    const restored = page.getByRole("dialog", { name: "语音记账", exact: true });
    await expect(restored.getByText("已记 2 笔，收入 ¥8,000.00，支出 ¥35.00", { exact: true })).toBeVisible();
    await expect(page.getByRole("button", { name: "手工填写", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(restored.getByRole("textbox")).toHaveCount(0);
    await restored.getByRole("button", { name: "关闭", exact: true }).click();
    await openNaturalLanguage(page);
    await expect(page.getByRole("textbox", { name: "收支描述", exact: true })).toHaveValue("");
    const confirmed = await ledgerSnapshot();
    expect(confirmed.transactions).toEqual(committed.transactions);
    expect(confirmed.requests).toEqual(committed.requests);
    expect(await pendingEntries(page)).toEqual([]);
    expect(network.actionCount).toBe(2);
  });

  test("keeps an old client capability unknown without writing or closing until a refreshed query", async ({ page }) => {
    await logInAndOpen(page);
    await openNaturalLanguage(page);
    let legacyActions = 0;
    await page.route(/\/add(?:\?.*)?$/, async (route) => {
      const request = route.request();
      if (request.method() !== "POST" || !request.headers()["next-action"] || legacyActions >= 2) {
        await route.continue();
        return;
      }
      legacyActions += 1;
      const args: unknown[] = request.postDataJSON();
      expect(Array.isArray(args)).toBe(true);
      if (legacyActions === 1) {
        expect(args[0]).toMatchObject({ resultVersion: 2 });
        const input = { ...args[0] as Record<string, unknown> };
        delete input.resultVersion;
        const response = await route.fetch({ postData: JSON.stringify([input]) });
        await route.fulfill({ response });
      } else {
        expect(args[1]).toBe(2);
        const response = await route.fetch({ postData: JSON.stringify([args[0]]) });
        await route.fulfill({ response });
      }
    });
    const description = page.getByRole("textbox", { name: "收支描述", exact: true });
    await description.fill(mixedTransactions);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("记账结果尚未确认", { exact: true })).toBeVisible();
    const pending = await pendingEntries(page);
    expect(pending).toHaveLength(1);
    expect((await ledgerSnapshot()).requests).toHaveLength(0);
    expect((await ledgerSnapshot()).transactions).toHaveLength(0);
    await page.getByRole("button", { name: "确认记账结果", exact: true }).click();
    await expect(page.getByText("记账结果尚未确认", { exact: true })).toBeVisible();
    expect(legacyActions).toBe(2);
    expect(await pendingEntries(page)).toEqual(pending);
    expect((await ledgerSnapshot()).requests).toHaveLength(0);
    await expect(description).toBeDisabled();
    await page.reload();
    const restored = page.getByRole("dialog", { name: "语音记账", exact: true });
    await expect(restored.getByRole("alert")).toContainText("本次请求未受理，已确认未入账");
    await expect(page.getByRole("button", { name: "手工填写", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(restored.getByRole("textbox")).toHaveCount(0);
    const closed = await ledgerSnapshot();
    expect(closed.transactions).toHaveLength(0);
    expect(closed.requests).toHaveLength(1);
    expect(closed.requests[0]).toMatchObject({ clientRequestId: pending[0][1], status: "FAILED", errorCode: "NOT_ACCEPTED" });
    expect(await pendingEntries(page)).toEqual([]);
  });

  test("globally closes an undelivered request after reload and allows a fresh text request without guessing its source", async ({ page }) => {
    await logInAndOpen(page);
    await openNaturalLanguage(page);
    const network = await dropFirstAction(page, false);
    await page.getByRole("textbox", { name: "收支描述", exact: true }).fill(twoExpenses);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("记账结果尚未确认", { exact: true })).toBeVisible();
    const pending = await pendingEntries(page);
    expect(pending).toHaveLength(1);
    expect((await ledgerSnapshot()).requests).toHaveLength(0);
    await page.reload();
    const restored = page.getByRole("dialog", { name: "语音记账", exact: true });
    await expect(restored.getByRole("alert")).toContainText("本次请求未受理，已确认未入账");
    await expect(page.getByRole("button", { name: "手工填写", exact: true })).toHaveAttribute("aria-pressed", "true");
    await expect(restored.getByRole("textbox")).toHaveCount(0);
    await restored.getByRole("button", { name: "关闭", exact: true }).click();
    await openNaturalLanguage(page);
    const description = page.getByRole("textbox", { name: "收支描述", exact: true });
    await expect(description).toBeEditable();
    await expect(description).toHaveValue("");
    await expect(page.getByRole("button", { name: "自然语言", exact: true })).toHaveAttribute("aria-pressed", "true");
    const closed = await ledgerSnapshot();
    expect(closed.transactions).toHaveLength(0);
    expect(closed.requests).toHaveLength(1);
    expect(closed.requests[0]).toMatchObject({ clientRequestId: pending[0][1], status: "FAILED", errorCode: "NOT_ACCEPTED", inputHash: null, referenceAt: null });
    expect(await pendingEntries(page)).toEqual([]);
    expect(network.actionCount).toBe(2);
    await description.fill(twoExpenses);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("已记 2 笔，支出 ¥57.00", { exact: true })).toBeVisible();
    const saved = await ledgerSnapshot();
    expect(saved.transactions).toHaveLength(2);
    expect(saved.requests).toHaveLength(2);
    expect(saved.requests.find(({ status }) => status === "SUCCEEDED")?.clientRequestId).not.toBe(pending[0][1]);
  });

  test("replays a lost correction response with its exact fragment and performs no new parsing request", async ({ page }) => {
    await logInAndOpen(page);
    await openNaturalLanguage(page);
    const network = await dropFirstAction(page, true);
    const description = page.getByRole("textbox", { name: "收支描述", exact: true });
    await description.fill(incompleteExpenses);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("记账结果尚未确认", { exact: true })).toBeVisible();
    const before = await ledgerSnapshot();
    expect(before.transactions).toHaveLength(0);
    expect(before.requests).toHaveLength(1);
    expect(before.requests[0]).toMatchObject({ errorCode: "NEEDS_CORRECTION", issues: [{ code: "missing_amount", start: 6, end: incompleteExpenses.length }] });
    await page.getByRole("button", { name: "确认记账结果", exact: true }).click();
    await expect(naturalLanguageFeedback(page)).toContainText("请补充金额");
    await expect(naturalLanguageFeedback(page).locator("q")).toHaveText("打车忘了多少钱");
    await expect(description).toHaveValue(incompleteExpenses);
    await expect(description).toBeEditable();
    expect(network.actionCount).toBe(2);
    const after = await ledgerSnapshot();
    expect(after.requests).toEqual(before.requests);
    expect(after.transactions).toHaveLength(0);
    expect(await pendingEntries(page)).toEqual([]);
    await page.reload();
    await openNaturalLanguage(page);
    await expect(page.getByRole("textbox", { name: "收支描述", exact: true })).toHaveValue("");
    await expect(page.locator("q")).toHaveCount(0);
  });

  test("returns a fixed service failure and permits a fresh import", async ({ page }) => {
    await logInAndOpen(page);
    await openNaturalLanguage(page);
    const description = page.getByRole("textbox", { name: "收支描述", exact: true });
    await description.fill("午饭35元 __agent_fail__");
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(naturalLanguageFeedback(page)).toContainText("暂时无法识别，未入账");
    await expect(description).toBeEditable();
    expect((await ledgerSnapshot()).transactions).toHaveLength(0);
    await description.fill(twoExpenses);
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByText("已记 2 笔，支出 ¥57.00", { exact: true })).toBeVisible();
    const saved = await ledgerSnapshot();
    expect(saved.transactions).toHaveLength(2);
    expect(saved.requests).toHaveLength(2);
  });
});
