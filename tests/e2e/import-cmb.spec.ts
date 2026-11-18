import path from "node:path";
import { readFile } from "node:fs/promises";

import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { expect, test, type Page } from "./fixtures";

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

async function buildEncryptedCmbZip() {
  const pdfPath = path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "imports",
    "cmb",
    "statement-single-page.pdf",
  );
  const writer = new Uint8ArrayWriter();
  const zipWriter = new ZipWriter(writer, {
    password: "e2e-password",
    useWebWorkers: false,
    zipCrypto: true,
  });
  await zipWriter.add(
    "招商银行交易流水.pdf",
    new Uint8ArrayReader(await readFile(pdfPath)),
  );
  return Buffer.from(await zipWriter.close());
}

test("users can upload a password-protected CMB ZIP statement", async ({ page }) => {
  await logIn(page);
  await page.goto("/records/import");
  await page.getByLabel("招商银行", { exact: true }).check();
  await page.getByLabel("文件").setInputFiles({
    buffer: await buildEncryptedCmbZip(),
    mimeType: "application/zip",
    name: "statement.zip",
  });
  await page.getByLabel("招商银行 ZIP 解压密码").fill("e2e-password");
  await page.getByRole("button", { name: "上传并解析" }).click();

  await expect(page).toHaveURL(/\/records\/import\?draft=/);
  await expect(page.locator("p").filter({ hasText: "文件: cmb.pdf" })).toBeVisible();
  await expect(page.getByRole("heading", { name: "成员映射" })).toBeVisible();
  await expect(page.getByTestId("import-review-row")).toHaveCount(4);
});

test("users can restore and import a default-skipped CMB movement", async ({ page }) => {
  const pdfPath = path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "imports",
    "cmb",
    "statement-single-page.pdf",
  );

  await logIn(page);
  await page.goto("/records/import");
  await page.getByLabel("招商银行", { exact: true }).check();
  await page.getByLabel("文件").setInputFiles(pdfPath);
  await page.getByRole("button", { name: "上传并解析" }).click();

  await expect(page).toHaveURL(/\/records\/import\?draft=/);
  const memberMappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "成员映射" }),
  });
  const ownerMapping = memberMappingForm.locator("label", { hasText: "示例户名" });
  await expect(ownerMapping).toBeVisible();
  await ownerMapping.getByRole("combobox").selectOption({ label: "老公" });
  await memberMappingForm.getByRole("button", { name: "保存成员映射" }).click();

  const mappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "分类映射" }),
  });
  await mappingForm
    .locator("label", { hasText: "支出 · 快捷支付 / 示例商户 示例门店" })
    .getByRole("combobox")
    .selectOption({ label: "餐饮" });
  await mappingForm
    .locator("label", { hasText: "收入 · 工资 / 示例公司" })
    .getByRole("combobox")
    .selectOption({ label: "工资" });
  await mappingForm.getByRole("button", { name: "保存映射" }).click();
  // Wait for the saved mappings' server refresh before editing a review row.
  await expect(page.getByText("分类映射已完成", { exact: true })).toBeVisible();

  const rowForm = page.locator("form", {
    has: page.getByRole("heading", { name: "导入复核" }),
  });
  await expect(rowForm).toContainText("转账汇款");
  await expect(rowForm.locator('input[value="SKIP"]:checked')).toHaveCount(1);
  const suggestedMovement = rowForm.getByTestId("import-review-row").filter({
    hasText: "分类: 转账汇款 / 示例户名",
  });
  await suggestedMovement.getByLabel("导入", { exact: true }).check();
  await rowForm.getByRole("button", { name: "保存选择" }).click();

  await mappingForm
    .locator("label", { hasText: "支出 · 转账汇款 / 示例户名" })
    .getByRole("combobox")
    .selectOption({ label: "餐饮" });
  await mappingForm.getByRole("button", { name: "保存映射" }).click();

  const confirmButton = page.getByRole("button", { name: "确认导入" });
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();
  await expect(page.getByRole("heading", { name: "导入已完成" })).toBeVisible();

  await page.getByRole("link", { name: "返回记录" }).last().click();
  await page.getByTestId("report-range-trigger").click();
  await page.getByRole("dialog").getByRole("button", { name: "全部", exact: true }).click();
  await expect(page.getByRole("link", { name: /餐饮.*老公.*-1234\.56/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /餐饮.*老公.*-2000\.00/ })).toBeVisible();
  await expect(page.getByRole("link", { name: /工资.*老公.*\+8000\.00/ })).toBeVisible();
});

test("users can review centered multiline CMB rows on a continuation page", async ({ page }) => {
  const pdfPath = path.join(
    process.cwd(),
    "tests",
    "fixtures",
    "imports",
    "cmb",
    "statement-continuation-pages.pdf",
  );

  await logIn(page);
  await page.goto("/records/import");
  await page.getByLabel("招商银行", { exact: true }).check();
  await page.getByLabel("文件").setInputFiles(pdfPath);
  await page.getByRole("button", { name: "上传并解析" }).click();

  await expect(page).toHaveURL(/\/records\/import\?draft=/);
  const memberMappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "成员映射" }),
  });
  await memberMappingForm
    .locator("label", { hasText: "示例户名" })
    .getByRole("combobox")
    .selectOption({ label: "老公" });
  await memberMappingForm.getByRole("button", { name: "保存成员映射" }).click();

  const mappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "分类映射" }),
  });
  const reviewRows = page.getByTestId("import-review-row");
  const expectedRows = [
    {
      amount: "32.10",
      counterparty: "示例早餐店 城西分店",
      date: "2026年7月8日",
      summary: "快捷支付 示例早餐",
      type: "支出",
    },
    {
      amount: "2400.00",
      counterparty: "示例公司 财务部",
      date: "2026年7月9日",
      summary: "工资 示例补贴",
      type: "收入",
    },
    {
      amount: "58.20",
      counterparty: "示例书店 城东门店",
      date: "2026年7月10日",
      summary: "快捷支付 示例图书",
      type: "支出",
    },
    {
      amount: "8.00",
      counterparty: "示例百货 客服中心",
      date: "2026年7月11日",
      summary: "退款 示例退货",
      type: "收入",
    },
  ];

  await expect(reviewRows).toHaveCount(expectedRows.length);
  for (const [index, expected] of expectedRows.entries()) {
    const row = reviewRows.nth(index);
    await expect(row).toContainText(`明细 #${index + 1}`);
    await expect(row).toContainText(expected.date);
    await expect(row.getByText(expected.amount, { exact: true })).toBeVisible();
    await expect(row.getByText(expected.type, { exact: true })).toBeVisible();
    await expect(row.getByTestId("import-row-details")).not.toHaveAttribute("open");
    await row.getByTestId("import-row-details").locator("summary").click();
    await expect(row.getByText(`分类: ${expected.summary} / ${expected.counterparty}`, { exact: true })).toBeVisible();
    await expect(row.getByText(`备注: 招商银行：${expected.summary}；对手信息：${expected.counterparty}`, { exact: true })).toBeVisible();
    await expect(row).toContainText("成员: 老公 · 创建人: 老公");
    await expect(mappingForm.locator("label", {
      hasText: `${expected.type} · ${expected.summary} / ${expected.counterparty}`,
    })).toBeVisible();
  }
});

test("users import a CMB net expense once and review locked refund outcomes", async ({ page }) => {
  const pdfPath = path.join(process.cwd(), "tests", "fixtures", "imports", "cmb", "statement-refunds.pdf");

  async function uploadStatement() {
    await page.goto("/records/import");
    await page.getByLabel("招商银行", { exact: true }).check();
    await page.getByLabel("文件").setInputFiles(pdfPath);
    await page.getByRole("button", { name: "上传并解析" }).click();
    await expect(page).toHaveURL(/\/records\/import\?draft=/);
  }

  await logIn(page);
  await uploadStatement();
  const memberMappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "成员映射" }),
  });
  await memberMappingForm
    .locator("label", { hasText: "示例户名" })
    .getByRole("combobox")
    .selectOption({ label: "老公" });
  await memberMappingForm.getByRole("button", { name: "保存成员映射" }).click();

  const reviewRows = page.getByTestId("import-review-row");
  await expect(reviewRows).toHaveCount(3);
  const netRow = reviewRows.filter({ hasText: "分类: 快捷支付 / 示例净额商户" });
  await expect(netRow).toContainText("2026年7月1日");
  await expect(netRow).toContainText("原支付 100.00－退款 30.00＝净支出 70.00");
  await expect(netRow.getByLabel("导入", { exact: true })).toBeChecked();

  const fullRefundRow = reviewRows.filter({ hasText: "示例全退商户" });
  await expect(fullRefundRow).toContainText("已完全退款，自动跳过");
  await expect(fullRefundRow.locator('input[name^="decision:"]')).toHaveCount(0);
  const manualRefundRow = reviewRows.filter({ hasText: "示例待核对商户" });
  await expect(manualRefundRow).toContainText("未找到快捷退款对应的可用原支付，请手工核对原支出");
  await expect(manualRefundRow.locator('input[name^="decision:"]')).toHaveCount(0);

  const mappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "分类映射" }),
  });
  await expect(mappingForm.getByRole("combobox")).toHaveCount(1);
  await mappingForm
    .locator("label", { hasText: "支出 · 快捷支付 / 示例净额商户" })
    .getByRole("combobox")
    .selectOption({ label: "餐饮" });
  await mappingForm.getByRole("button", { name: "保存映射" }).click();
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("heading", { name: "导入已完成" })).toBeVisible();

  await page.getByRole("link", { name: "返回记录" }).last().click();
  await page.getByTestId("report-range-trigger").click();
  await page.getByRole("dialog").getByRole("button", { name: "全部", exact: true }).click();
  await expect(page).toHaveURL((url) => url.searchParams.get("mode") === "all");
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  const importedRecord = page.locator('a[href*="record="]').filter({ hasText: "示例净额商户" });
  await expect(importedRecord).toHaveCount(1);
  await expect(importedRecord).toContainText("餐饮");
  await expect(importedRecord).toContainText("老公");
  await expect(importedRecord).toContainText("-70.00");
  await expect(page.getByRole("link", { name: /示例全退商户|示例待核对商户/ })).toHaveCount(0);

  await uploadStatement();
  await expect(netRow).toContainText("已存在同源记录，不会重复导入。");
  await expect(netRow.locator('input[name^="decision:"]')).toHaveCount(0);
  await expect(mappingForm).toHaveCount(0);
  await page.getByRole("button", { name: "确认导入" }).click();
  await expect(page.getByRole("heading", { name: "导入已完成" })).toBeVisible();
  await page.getByRole("link", { name: "返回记录" }).last().click();
  await page.getByTestId("report-range-trigger").click();
  await page.getByRole("dialog").getByRole("button", { name: "全部", exact: true }).click();
  await page.getByRole("dialog").getByRole("button", { name: "关闭", exact: true }).click();
  await expect(importedRecord).toHaveCount(1);
});
