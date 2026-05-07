import { expect, test, type Page, type TestInfo } from "@playwright/test";
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
    ["微信昵称：[晶晶]"],
    [`导出时间：[${currentShanghaiDateTimeText()}]`],
    [],
    ["----------------------微信支付账单明细列表--------------------"],
    wechatHeaders,
    [
      currentShanghaiDateTimeText(),
      "扫二维码付款",
      "阿泉食杂店",
      "收款方备注:二维码收款",
      "支出",
      "30.12",
      "招商银行储蓄卡(1209)",
      "已转账",
      orderId,
      `${orderId}-merchant`,
      "/",
    ],
  ]);

  const workbookPath = testInfo.outputPath("wechat-pay-import.xlsx");
  await workbook.xlsx.writeFile(workbookPath);

  return workbookPath;
}

test("users can import WeChat Pay records from the records page", async ({ page }, testInfo) => {
  const workbookPath = await createWechatPayWorkbook(testInfo);

  await logIn(page);
  await page.goto("/records");
  await page.getByRole("link", { name: "导入" }).click();

  await page.getByLabel("微信支付").check();
  await page.getByLabel("文件").setInputFiles(workbookPath);
  await page.getByRole("button", { name: "上传并解析" }).click();

  await expect(page).toHaveURL(/\/records\/import\?draft=/);
  const ownerForm = page.locator("form", {
    has: page.getByRole("heading", { name: "账单归属成员" }),
  });
  await expect(ownerForm).toBeVisible();
  const ownerMemberSelect = ownerForm.getByLabel("成员");
  await expect(ownerMemberSelect.locator("option:checked")).toHaveText("老婆");
  await ownerMemberSelect.selectOption({ label: "老公" });
  await ownerForm.getByRole("button", { name: "保存成员" }).click();
  await expect(page).toHaveURL(/\/records\/import\?draft=/);
  await expect(ownerMemberSelect.locator("option:checked")).toHaveText("老公");

  const mappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "分类映射" }),
  });
  const wechatMapping = mappingForm.locator("label", { hasText: "支出 · 扫二维码付款 / 阿泉食杂店" });
  await expect(wechatMapping).toBeVisible();
  await wechatMapping.getByRole("combobox").selectOption({ label: "餐饮" });
  await mappingForm.getByRole("button", { name: "保存映射" }).click();

  const confirmButton = page.getByRole("button", { name: "确认导入" });
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect(page.getByRole("heading", { name: "导入已完成" })).toBeVisible();
  await page.getByRole("link", { name: "返回记录" }).last().click();

  await expect(page).toHaveURL((url) => url.pathname === "/records" && url.search === "");
  const importedRecord = page.getByRole("link", { name: /-30\.12.*餐饮.*老公/ });
  await expect(importedRecord).toBeVisible();
  await expect(importedRecord).toContainText("-30.12");
  await expect(importedRecord).toContainText("餐饮");
  await expect(importedRecord).toContainText("老公");
});
