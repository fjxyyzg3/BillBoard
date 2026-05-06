import { expect, test, type Page, type TestInfo } from "@playwright/test";
import ExcelJS from "exceljs";

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
      "晶晶",
      "小店",
      "",
      "",
      "晶晶",
      note,
    ],
  ]);
  workbook.addWorksheet("收入").addRows([suiShouJiHeaders]);

  const workbookPath = testInfo.outputPath("sui-shou-ji-import.xlsx");
  await workbook.xlsx.writeFile(workbookPath);

  return workbookPath;
}

test("users can import Sui Shou Ji records from the records page", async ({ page }, testInfo) => {
  const workbookPath = await createSuiShouJiWorkbook(testInfo);

  await logIn(page);
  await page.goto("/records");
  await page.getByRole("link", { name: "导入" }).click();

  await page.getByLabel("文件").setInputFiles(workbookPath);
  await page.getByRole("button", { name: "上传并解析" }).click();

  await expect(page).toHaveURL(/\/records\/import\?draft=/);
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

  await expect(page).toHaveURL(/\/records/);
  const importedRecord = page.getByRole("link", { name: /-12\.34.*餐饮.*老婆/ });
  await expect(importedRecord).toBeVisible();
  await expect(importedRecord).toContainText("-12.34");
  await expect(importedRecord).toContainText("餐饮");
  await expect(importedRecord).toContainText("老婆");
});
