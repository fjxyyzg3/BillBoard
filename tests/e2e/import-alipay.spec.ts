import { writeFile } from "node:fs/promises";

import { expect, test, type Page, type TestInfo } from "./fixtures";

const alipayHeaders = [
  "交易时间",
  "交易分类",
  "交易对方",
  "对方账号",
  "商品说明",
  "收/支",
  "金额",
  "收/付款方式",
  "交易状态",
  "交易订单号",
  "商家订单号",
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
  const value = (type: string) =>
    parts.find((part) => part.type === type)?.value ?? "";

  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

type AlipayCsvScenario = "full-refund" | "partial-refund" | "standard";

async function createAlipayCsv(
  testInfo: TestInfo,
  scenario: AlipayCsvScenario = "standard",
) {
  const orderId = `alipay-e2e-${Date.now()}`;
  const merchantOrderId = `${orderId}-merchant`;
  const paymentAmount = scenario === "standard" ? "22.85" : "1.80";
  const rows = [
    [
      currentShanghaiDateTimeText(),
      "餐饮美食",
      "示例商户",
      "/",
      "示例商户",
      "支出",
      paymentAmount,
      "示例银行信用卡(0000)&红包",
      "交易成功",
      orderId,
      merchantOrderId,
      "/",
      "",
    ],
  ];

  if (scenario !== "standard") {
    rows.push([
      currentShanghaiDateTimeText(),
      "退款",
      "示例商户",
      "/",
      "退款-示例商户",
      "不计收支",
      scenario === "partial-refund" ? "1.15" : "1.80",
      "/",
      "退款成功",
      `${orderId}-refund`,
      merchantOrderId,
      "/",
      "",
    ]);
  }

  const csv = [
    "------------------------------------------------------------------------------------",
    "导出信息：",
    "姓名：老公",
    "支付宝账户：example-alipay-account",
    "------------------------支付宝支付科技有限公司  电子客户回单------------------------",
    [...alipayHeaders, ""].join(","),
    ...rows.map((row) => row.join(",")),
  ].join("\n");
  const csvPath = testInfo.outputPath(`alipay-${scenario}.csv`);

  await writeFile(csvPath, csv, "utf8");

  return csvPath;
}

async function uploadAlipayCsv(page: Page, csvPath: string) {
  await page.goto("/records/import");
  await page.getByLabel("支付宝").check();
  await page.getByLabel("文件").setInputFiles(csvPath);
  await page.getByRole("button", { name: "上传并解析" }).click();
  await expect(page).toHaveURL(/\/records\/import\?draft=/);
}

async function saveVisibleAlipayMappings(page: Page) {
  const memberMappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "成员映射" }),
  });

  if (await memberMappingForm.isVisible()) {
    await memberMappingForm.getByRole("button", { name: "保存成员映射" }).click();
  }

  const mappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "分类映射" }),
  });

  if (await mappingForm.isVisible()) {
    const alipayMapping = mappingForm.locator("label", {
      hasText: "支出 · 餐饮美食",
    });

    await alipayMapping.getByRole("combobox").selectOption({ label: "餐饮" });
    await mappingForm.getByRole("button", { name: "保存映射" }).click();
  }
}

test("users can import Alipay records from the records page", async ({
  page,
}, testInfo) => {
  const csvPath = await createAlipayCsv(testInfo);

  await logIn(page);
  await page.goto("/records");
  await page.getByRole("link", { name: "导入" }).click();
  const uploadLedgerId = await page.getByRole("combobox", { name: "记入账本", exact: true }).inputValue();
  expect(uploadLedgerId).not.toBe("");

  await page.getByLabel("支付宝").check();
  await page.getByLabel("文件").setInputFiles(csvPath);
  await page.getByRole("button", { name: "上传并解析" }).click();

  await expect(page).toHaveURL(/\/records\/import\?draft=/);
  const memberMappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "成员映射" }),
  });
  await expect(memberMappingForm).toBeVisible();
  const ownerMapping = memberMappingForm.locator("label", { hasText: "老公" });
  await expect(ownerMapping).toBeVisible();
  await expect(ownerMapping.getByRole("combobox").locator("option:checked")).toHaveText("老公");
  await memberMappingForm.getByRole("button", { name: "保存成员映射" }).click();

  const mappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "分类映射" }),
  });
  const alipayMapping = mappingForm.locator("label", {
    hasText: "支出 · 餐饮美食",
  });
  await expect(alipayMapping).toBeVisible();
  await alipayMapping.getByRole("combobox").selectOption({ label: "餐饮" });
  await mappingForm.getByRole("button", { name: "保存映射" }).click();

  const confirmButton = page.getByRole("button", { name: "确认导入" });
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect(page.getByRole("heading", { name: "导入已完成" })).toBeVisible();
  await page.getByRole("link", { name: "返回记录" }).last().click();

  await expect(page).toHaveURL(
    (url) => url.pathname === "/records" && url.search === `?ledger=${encodeURIComponent(uploadLedgerId)}`,
  );
  const importedRecord = page.getByRole("link", {
    name: /餐饮.*老公.*-22\.85/,
  });
  await expect(importedRecord).toBeVisible();
  await expect(importedRecord).toContainText("-22.85");
  await expect(importedRecord).toContainText("餐饮");
  await expect(importedRecord).toContainText("老公");
});

test("users import only the net expense for a partial Alipay refund", async ({
  page,
}, testInfo) => {
  const csvPath = await createAlipayCsv(testInfo, "partial-refund");

  await logIn(page);
  await uploadAlipayCsv(page, csvPath);
  await saveVisibleAlipayMappings(page);

  const confirmButton = page.getByRole("button", { name: "确认导入" });
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();
  await expect(page.getByRole("heading", { name: "导入已完成" })).toBeVisible();
  await page.getByRole("link", { name: "返回记录" }).last().click();

  const importedRecord = page.getByRole("link", {
    name: /餐饮.*老公.*-0\.65/,
  });
  await expect(importedRecord).toBeVisible();
  await expect(importedRecord).toContainText("-0.65");
});

test("users see a full Alipay refund as a locked skipped outcome", async ({
  page,
}, testInfo) => {
  const csvPath = await createAlipayCsv(testInfo, "full-refund");

  await logIn(page);
  await uploadAlipayCsv(page, csvPath);

  const refundPanel = page.locator("form", {
    has: page.getByRole("heading", { name: "导入复核" }),
  });
  const refundRow = refundPanel
    .getByTestId("import-review-row")
    .filter({ hasText: "已完全退款，自动跳过" });

  await expect(refundPanel).toBeVisible();
  await expect(refundRow).toContainText("1.80");
  await expect(refundRow).toContainText("餐饮美食 / 示例商户");
  await expect(refundRow.locator('input[name^="decision:"]')).toHaveCount(0);
  await expect(page.getByRole("combobox", { name: "成员" })).toHaveCount(0);

  const confirmButton = page.getByRole("button", { name: "确认导入" });
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();
  await expect(page.getByRole("heading", { name: "导入已完成" })).toBeVisible();
});
