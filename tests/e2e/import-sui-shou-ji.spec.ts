import { expect, test, type Page, type TestInfo } from "./fixtures";
import { clearTransactions } from "./db-cleanup";
import ExcelJS from "exceljs";
import { writeFile } from "node:fs/promises";
import { workbookAtUploadBoundary } from "../fixtures/import-capacity";

const suiShouJiHeaders = [
  "交易类型",
  "日期",
  "一级分类",
  "二级分类",
  "账户1",
  "账户2",
  "账户币种",
  "金额",
  "成员",
  "商家",
  "项目分类",
  "项目",
  "记账人",
  "备注",
];

function requireEnv(name: string) {
  const value = process.env[name];

  if (!value) {
    throw new Error(`Missing required env var: ${name}`);
  }

  return value;
}

async function logIn(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录" }).click();
  await expect(page).toHaveURL(/\/home$/);
}

function currentShanghaiDateTimeText() {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).formatToParts(new Date());
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";

  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

async function createSuiShouJiWorkbook(testInfo: TestInfo) {
  const workbook = new ExcelJS.Workbook();
  const note = `E2E import ${Date.now()}`;

  const expenseSheet = workbook.addWorksheet("支出");
  expenseSheet.addRows([
    suiShouJiHeaders,
    [
      "支出",
      currentShanghaiDateTimeText(),
      "餐饮",
      "三餐",
      "现金",
      "",
      "CNY",
      "12.34",
      "老婆",
      "小店",
      "",
      "",
      "老婆",
      note,
    ],
  ]);
  workbook.addWorksheet("收入").addRows([suiShouJiHeaders]);

  const workbookPath = testInfo.outputPath("sui-shou-ji-import.xlsx");
  await writeFile(workbookPath, await workbookAtUploadBoundary(new Uint8Array(await workbook.xlsx.writeBuffer())));

  return workbookPath;
}

test("users can import Sui Shou Ji records from the records page", async ({ page }, testInfo) => {
  await clearTransactions();
  const workbookPath = await createSuiShouJiWorkbook(testInfo);

  await logIn(page);
  await page.goto("/records");
  await page.getByRole("link", { name: "导入" }).click();
  const uploadLedgerId = await page.getByRole("combobox", { name: "记入账本", exact: true }).inputValue();
  expect(uploadLedgerId).not.toBe("");

  await page.getByLabel("随手记").check();
  await page.getByLabel("文件").setInputFiles(workbookPath);
  await page.getByRole("button", { name: "上传并解析" }).click();

  await expect(page).toHaveURL(/\/records\/import\?draft=/);
  const memberMappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "成员映射" }),
  });
  await expect(memberMappingForm).toBeVisible();
  const wifeMapping = memberMappingForm.locator("label", { hasText: "老婆" });
  await expect(wifeMapping).toBeVisible();
  await wifeMapping.getByRole("combobox").selectOption({ label: "老婆" });
  await memberMappingForm.getByRole("button", { name: "保存成员映射" }).click();

  const mappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "分类映射" }),
  });
  await expect(mappingForm).toBeVisible();
  const diningMapping = mappingForm.locator("label", { hasText: "支出 · 餐饮 / 三餐" });
  await expect(diningMapping).toBeVisible();
  await diningMapping.getByRole("combobox").selectOption({ label: "餐饮" });
  await mappingForm.getByRole("button", { name: "保存映射" }).click();

  const confirmButton = page.getByRole("button", { name: "确认导入" });
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect(page.getByRole("heading", { name: "导入已完成" })).toBeVisible();
  await page.getByRole("link", { name: "返回记录" }).last().click();

  await expect(page).toHaveURL((url) => url.pathname === "/records" && url.search === `?ledger=${encodeURIComponent(uploadLedgerId)}`);
  const importedRecord = page.getByRole("link", { name: /餐饮.*老婆.*-12\.34/ });
  await expect(importedRecord).toBeVisible();
  await expect(importedRecord).toContainText("-12.34");
  await expect(importedRecord).toContainText("餐饮");
  await expect(importedRecord).toContainText("老婆");
});
