import { expect, test, type Page, type TestInfo } from "./fixtures";
import ExcelJS from "exceljs";

const wechatHeaders = [
  "交易时间",
  "交易类型",
  "交易对方",
  "商品",
  "收/支",
  "金额(元)",
  "支付方式",
  "当前状态",
  "交易单号",
  "商户单号",
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

async function createWechatPayWorkbook(testInfo: TestInfo) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  const orderId = `wechat-e2e-${Date.now()}`;

  sheet.addRows([
    ["微信支付账单明细"],
    ["微信昵称：[老婆]"],
    [`导出时间：[${currentShanghaiDateTimeText()}]`],
    [],
    ["----------------------微信支付账单明细列表--------------------"],
    wechatHeaders,
    [
      currentShanghaiDateTimeText(),
      "扫二维码付款",
      "示例商户",
      "收款方备注:二维码收款",
      "支出",
      "30.12",
      "示例银行储蓄卡(0000)",
      "已转账",
      orderId,
      `${orderId}-merchant`,
      "/",
    ],
  ]);

  sheet.mergeCells("A1:K1");
  sheet.mergeCells("A4:K4");

  const workbookPath = testInfo.outputPath("wechat-pay-import.xlsx");
  await workbook.xlsx.writeFile(workbookPath);

  return workbookPath;
}

async function createWechatRefundWorkbook(testInfo: TestInfo) {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  const orderId = `wechat-refund-e2e-${Date.now()}`;
  const transactionTime = currentShanghaiDateTimeText();

  sheet.addRows([
    ["微信支付账单明细"],
    ["微信昵称：[老婆]"],
    [`导出时间：[${transactionTime}]`],
    [],
    ["----------------------微信支付账单明细列表--------------------"],
    wechatHeaders,
    [
      transactionTime,
      "商户消费",
      "示例商户",
      "示例商品",
      "支出",
      "2.00",
      "示例银行储蓄卡(0000)",
      "已退款(¥1.19)",
      orderId,
      `${orderId}-merchant`,
      "/",
    ],
    [
      transactionTime,
      "商户消费-退款",
      "示例商户",
      "示例商品退款",
      "收入",
      "1.19",
      "零钱",
      "已退款¥1.19",
      `${orderId}-refund`,
      `${orderId}-refund-merchant`,
      "/",
    ],
  ]);

  const workbookPath = testInfo.outputPath("wechat-pay-refund-import.xlsx");
  await workbook.xlsx.writeFile(workbookPath);

  return workbookPath;
}

test("users can import WeChat Pay records from the records page", async ({ page }, testInfo) => {
  const workbookPath = await createWechatPayWorkbook(testInfo);

  await logIn(page);
  await page.goto("/records");
  await page.getByRole("link", { name: "导入" }).click();
  const uploadLedgerId = await page.getByRole("combobox", { name: "记入账本", exact: true }).inputValue();
  expect(uploadLedgerId).not.toBe("");

  await page.getByLabel("微信支付").check();
  await page.getByLabel("文件").setInputFiles(workbookPath);
  await page.getByRole("button", { name: "上传并解析" }).click();

  await expect(page).toHaveURL(/\/records\/import\?draft=/);
  const memberMappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "成员映射" }),
  });
  await expect(memberMappingForm).toBeVisible();
  const ownerMapping = memberMappingForm.locator("label", { hasText: "老婆" });
  await expect(ownerMapping).toBeVisible();
  await expect(ownerMapping.getByRole("combobox").locator("option:checked")).toHaveText("老公");
  await ownerMapping.getByRole("combobox").selectOption({ label: "老公" });
  await memberMappingForm.getByRole("button", { name: "保存成员映射" }).click();
  await expect(page).toHaveURL(/\/records\/import\?draft=/);
  await expect(ownerMapping.getByRole("combobox").locator("option:checked")).toHaveText("老公");

  const mappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "分类映射" }),
  });
  const wechatMapping = mappingForm.locator("label", { hasText: "支出 · 扫二维码付款 / 示例商户" });
  await expect(wechatMapping).toBeVisible();
  await wechatMapping.getByRole("combobox").selectOption({ label: "餐饮" });
  await mappingForm.getByRole("button", { name: "保存映射" }).click();

  const confirmButton = page.getByRole("button", { name: "确认导入" });
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect(page.getByRole("heading", { name: "导入已完成" })).toBeVisible();
  await page.getByRole("link", { name: "返回记录" }).last().click();

  await expect(page).toHaveURL((url) => url.pathname === "/records" && url.search === `?ledger=${encodeURIComponent(uploadLedgerId)}`);
  const importedRecord = page.getByRole("link", { name: /餐饮.*老公.*-30\.12/ });
  await expect(importedRecord).toBeVisible();
  await expect(importedRecord).toContainText("-30.12");
  await expect(importedRecord).toContainText("餐饮");
  await expect(importedRecord).toContainText("老公");
});

test("users import a partially refunded WeChat payment as one net expense", async ({
  page,
}, testInfo) => {
  const workbookPath = await createWechatRefundWorkbook(testInfo);

  await logIn(page);
  await page.goto("/records/import");
  await page.getByLabel("微信支付").check();
  await page.getByLabel("文件").setInputFiles(workbookPath);
  await page.getByRole("button", { name: "上传并解析" }).click();

  const memberMappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "成员映射" }),
  });
  const ownerMapping = memberMappingForm.locator("label", { hasText: "老婆" });
  await ownerMapping.getByRole("combobox").selectOption({ label: "老公" });
  await memberMappingForm.getByRole("button", { name: "保存成员映射" }).click();

  const mappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "分类映射" }),
  });
  const wechatMapping = mappingForm.locator("label", {
    hasText: "支出 · 商户消费 / 示例商户",
  });
  await wechatMapping.getByRole("combobox").selectOption({ label: "餐饮" });
  await mappingForm.getByRole("button", { name: "保存映射" }).click();

  await expect(page.getByText("0.81")).toBeVisible();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("heading", { name: "导入已完成" })).toBeVisible();
  await page.getByRole("link", { name: "返回记录" }).last().click();

  const importedRecord = page.getByRole("link", { name: /餐饮.*老公.*-0\.81/ });
  await expect(importedRecord).toBeVisible();
  await expect(page.getByRole("link", { name: /\+1\.19/ })).toHaveCount(0);
});
