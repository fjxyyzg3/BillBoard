# 微信支付导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 `/records/import` 草稿导入流程中支持微信支付 `.xlsx` 账单导入，并提供上传前来源选择和微信账单归属成员下拉。

**Architecture:** 复用现有 `ImportDraft`、`ImportDraftRow`、`ImportCategoryMapping` 和 `Transaction` 来源字段。新增 `wechat_pay` 来源解析器，把 `src/lib/imports/drafts.ts` 中写死的随手记来源推广为来源参数；页面和 action 只做来源选择、错误提示和微信成员保存。

**Tech Stack:** Next.js server actions, React server components, Prisma, ExcelJS, Vitest, Playwright.

---

## File Structure

- Create: `src/lib/imports/sources/wechat-pay.ts`
  - 负责识别微信支付账单工作簿、查找表头、解析文件头昵称、规范化收入支出行、生成备注、生成来源指纹。
- Modify: `src/lib/imports/types.ts`
  - 增加 `WECHAT_PAY_SOURCE`、扩展 `ImportSource`、为 `ParsedImportWorkbook` 增加 `ownerName?: string`。
- Modify: `src/lib/imports/fingerprint.ts`
  - 保持 `createSourceFingerprint` 通用；扩展输入字段含义，让微信支付使用 `rawAccount/rawMerchant/rawCurrency` 承载支付方式、当前状态、交易单号等稳定字段。
- Modify: `src/lib/imports/member-mapping.ts`
  - 继续使用现有别名；不新增数据库字段。
- Modify: `src/lib/imports/drafts.ts`
  - 增加通用 `createImportDraft`，保留 `createSuiShouJiImportDraft` 兼容测试和现有调用；新增 `createWechatPayImportDraft` 和 `saveWechatPayDraftOwnerMember`。
- Modify: `src/lib/imports/category-mapping.ts`
  - `buildImportCategoryMappingKey` 自动支持扩展后的 `ImportSource`。
- Modify: `src/app/(app)/records/import/actions.ts`
  - 上传 action 改名为通用 `uploadImportDraft`；读取 `source`；新增 `saveWechatPayOwnerMember`。
- Modify: `src/app/(app)/records/import/page.tsx`
  - 上传表单加来源选择；微信草稿显示成员下拉；分类映射和疑似重复保留现有布局。
- Modify: `src/lib/i18n.ts`
  - 补中文和英文文案。
- Modify: `tests/unit/sui-shou-ji-import.test.ts`
  - 更新来源 union 后的断言。
- Create: `tests/unit/wechat-pay-import.test.ts`
  - 微信解析器单元测试。
- Modify: `tests/integration/import-drafts.test.ts`
  - 增加微信草稿、成员保存、映射复用、确认导入、去重和权限测试。
- Modify: `tests/integration/import-page-and-actions.test.ts`
  - 更新 mock 和 server action/page 渲染测试。
- Modify: `tests/unit/i18n.test.ts`
  - 增加微信导入文案断言。
- Modify: `tests/e2e/import-sui-shou-ji.spec.ts`
  - 适配上传前来源选择，确保随手记路径仍可用。
- Create: `tests/e2e/import-wechat-pay.spec.ts`
  - 微信支付端到端导入路径。

## Task 1: Extend Import Source Types

**Files:**
- Modify: `src/lib/imports/types.ts`
- Modify: `tests/unit/sui-shou-ji-import.test.ts`

- [ ] **Step 1: Write failing type-level expectations**

Update `tests/unit/sui-shou-ji-import.test.ts` imports:

```ts
import { SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE } from "@/lib/imports/types";
```

Add this assertion inside `describe("buildImportCategoryMappingKey", ...)`:

```ts
  it("supports distinct source prefixes for each import source", () => {
    expect(SUI_SHOU_JI_SOURCE).toBe("sui_shou_ji");
    expect(WECHAT_PAY_SOURCE).toBe("wechat_pay");
    expect(
      buildImportCategoryMappingKey({
        source: WECHAT_PAY_SOURCE,
        transactionType: TransactionType.EXPENSE,
        primaryCategory: "扫二维码付款",
        secondaryCategory: "阿泉食杂店",
      }),
    ).toBe("wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店");
  });
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
npm run test:unit -- tests/unit/sui-shou-ji-import.test.ts
```

Expected: TypeScript or runtime failure because `WECHAT_PAY_SOURCE` is not exported.

- [ ] **Step 3: Implement the source union**

Replace the top of `src/lib/imports/types.ts` with:

```ts
import type { TransactionType } from "@prisma/client";

export const SUI_SHOU_JI_SOURCE = "sui_shou_ji" as const;
export const WECHAT_PAY_SOURCE = "wechat_pay" as const;

export type ImportSource = typeof SUI_SHOU_JI_SOURCE | typeof WECHAT_PAY_SOURCE;
```

Replace `ParsedImportWorkbook` at the bottom of the file with:

```ts
export type ParsedImportWorkbook = {
  invalidRows: InvalidImportRow[];
  ownerName?: string;
  rows: ParsedImportRow[];
};
```

- [ ] **Step 4: Run the focused test and verify pass**

Run:

```powershell
npm run test:unit -- tests/unit/sui-shou-ji-import.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/imports/types.ts tests/unit/sui-shou-ji-import.test.ts
git commit -m "v0.16.0 扩展导入来源类型" -m "增加微信支付来源常量，保持现有随手记导入类型兼容。"
```

## Task 2: Add WeChat Pay Workbook Parser

**Files:**
- Create: `src/lib/imports/sources/wechat-pay.ts`
- Create: `tests/unit/wechat-pay-import.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `tests/unit/wechat-pay-import.test.ts`:

```ts
import { TransactionType } from "@prisma/client";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { parseWechatPayWorkbook } from "@/lib/imports/sources/wechat-pay";

const headers = [
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

async function buildWorkbookBuffer(rows: unknown[][]): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRows([
    ["微信支付账单明细"],
    ["微信昵称：[李环宇]"],
    ["起始时间：[2026-04-30 00:00:00] 终止时间：[2026-05-07 20:26:54]"],
    [],
    ["----------------------微信支付账单明细列表--------------------"],
    headers,
    ...rows,
  ]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("parseWechatPayWorkbook", () => {
  it("parses WeChat Pay expense rows with owner name, mapping key, note, and fingerprint", async () => {
    const buffer = await buildWorkbookBuffer([
      [
        new Date("2026-05-02T09:22:40.000Z"),
        "扫二维码付款",
        "阿泉食杂店",
        "收款方备注:二维码收款",
        "支出",
        "30",
        "招商银行储蓄卡(1209)",
        "已转账",
        "53110001409141202605020932752192",
        "10001073012026050201637220123649",
        "/",
      ],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.ownerName).toBe("李环宇");
    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      amountFen: 3000,
      mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
      occurredAt: new Date("2026-05-02T09:22:40.000Z"),
      occurredAtDate: "2026-05-02",
      occurredAtText: "2026-05-02 17:22:40",
      primaryCategory: "扫二维码付款",
      rawAmount: "30",
      rawCreatedBy: "李环宇",
      rawCurrency: "CNY",
      rawDate: "2026-05-02 17:22:40",
      rawMember: "李环宇",
      rawTransactionType: "支出",
      rowNumber: 7,
      secondaryCategory: "阿泉食杂店",
      sheetName: "Sheet1",
      transactionType: TransactionType.EXPENSE,
    });
    expect(result.rows[0]?.note).toContain("微信支付：扫二维码付款");
    expect(result.rows[0]?.note).toContain("交易对方：阿泉食杂店");
    expect(result.rows[0]?.note).toContain("支付方式：招商银行储蓄卡(1209)");
    expect(result.rows[0]?.note).not.toContain("备注：/");
    expect(result.rows[0]?.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("parses income rows and treats unknown non-error statuses as importable", async () => {
    const buffer = await buildWorkbookBuffer([
      [
        "2026-05-05 18:54:18",
        "转账",
        "朋友",
        "转账收款",
        "收入",
        "88.66",
        "零钱",
        "新的成功状态",
        "income-order",
        "merchant-order",
        "晚饭 AA",
      ],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.rows[0]).toMatchObject({
      amountFen: 8866,
      mappingKey: "wechat_pay|INCOME|转账|朋友",
      occurredAt: new Date("2026-05-05T10:54:18.000Z"),
      occurredAtDate: "2026-05-05",
      occurredAtText: "2026-05-05 18:54:18",
      transactionType: TransactionType.INCOME,
    });
    expect(result.invalidRows).toEqual([]);
  });

  it("marks neutral transactions as invalid without blocking other rows", async () => {
    const buffer = await buildWorkbookBuffer([
      [
        "2026-05-05 18:54:18",
        "零钱提现",
        "微信支付",
        "提现",
        "中性交易",
        "100",
        "零钱",
        "提现成功",
        "neutral-order",
        "",
        "",
      ],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.rows).toEqual([]);
    expect(result.invalidRows).toMatchObject([
      {
        rawAmount: "100",
        rawCreatedBy: "李环宇",
        rawCurrency: "CNY",
        rawDate: "2026-05-05 18:54:18",
        rawMember: "李环宇",
        rawTransactionType: "中性交易",
        reason: "Neutral transaction is not importable",
        rowNumber: 7,
        sheetName: "Sheet1",
      },
    ]);
  });

  it("marks refund, closed, and failed statuses as invalid", async () => {
    const buffer = await buildWorkbookBuffer([
      ["2026-05-05 18:54:18", "商户消费", "商户 A", "商品", "支出", "1", "零钱", "已全额退款", "refund", "", ""],
      ["2026-05-05 18:55:18", "商户消费", "商户 B", "商品", "支出", "2", "零钱", "交易关闭", "closed", "", ""],
      ["2026-05-05 18:56:18", "商户消费", "商户 C", "商品", "支出", "3", "零钱", "支付失败", "failed", "", ""],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.rows).toEqual([]);
    expect(result.invalidRows.map((row) => row.reason)).toEqual([
      "Refunded or unsuccessful transaction",
      "Refunded or unsuccessful transaction",
      "Refunded or unsuccessful transaction",
    ]);
  });

  it("throws for workbooks without a WeChat Pay detail header", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Sheet1").addRows([["交易类型", "日期"]]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(parseWechatPayWorkbook(buffer)).rejects.toThrow("无法识别微信支付账单格式");
  });
});
```

- [ ] **Step 2: Run parser tests and verify failure**

Run:

```powershell
npm run test:unit -- tests/unit/wechat-pay-import.test.ts
```

Expected: FAIL because `src/lib/imports/sources/wechat-pay.ts` does not exist.

- [ ] **Step 3: Implement the parser**

Create `src/lib/imports/sources/wechat-pay.ts`:

```ts
import { TransactionType } from "@prisma/client";
import ExcelJS from "exceljs";

import { buildImportCategoryMappingKey, normalizeImportedCategory } from "../category-mapping";
import { createSourceFingerprint } from "../fingerprint";
import {
  type InvalidImportRow,
  type ParsedImportRow,
  type ParsedImportWorkbook,
  WECHAT_PAY_SOURCE,
} from "../types";

const requiredHeaders = [
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
] as const;

const unrecognizedWorkbookMessage = "无法识别微信支付账单格式";
const importFileTooLargeMessage = "Import file is too large";
const maxImportDataRows = 20_000;
const invalidStatusPattern = /退款|关闭|失败/;

type HeaderName = (typeof requiredHeaders)[number];
type HeaderIndexes = Partial<Record<HeaderName, number>>;
type RawRow = {
  rawAmount: string;
  rawCounterparty: string;
  rawMerchantOrderId: string;
  rawNote: string;
  rawOccurredAt: string;
  rawOrderId: string;
  rawPaymentMethod: string;
  rawProduct: string;
  rawStatus: string;
  rawTransactionKind: string;
  rawTransactionType: string;
};

function cellText(value: unknown): string {
  if (value instanceof Date) {
    return formatShanghaiDateTime(value);
  }

  if (value && typeof value === "object") {
    if ("text" in value) {
      return String((value as { text?: unknown }).text ?? "").trim();
    }

    if ("richText" in value) {
      return (value as { richText?: Array<{ text?: string }> }).richText
        ?.map((part) => part.text ?? "")
        .join("")
        .trim() ?? "";
    }

    if ("result" in value) {
      return cellText((value as { result?: unknown }).result);
    }
  }

  return String(value ?? "").trim();
}

function formatShanghaiDateTime(date: Date): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    day: "2-digit",
    hour: "2-digit",
    hourCycle: "h23",
    minute: "2-digit",
    month: "2-digit",
    second: "2-digit",
    timeZone: "Asia/Shanghai",
    year: "numeric",
  }).formatToParts(date);
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";

  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

function getWorksheetRowValues(row: ExcelJS.Row): unknown[] {
  const values = [];

  for (let cellIndex = 1; cellIndex <= row.cellCount; cellIndex += 1) {
    values.push(row.getCell(cellIndex).value);
  }

  return values;
}

function getHeaderIndexes(values: unknown[]): HeaderIndexes | null {
  const indexes: HeaderIndexes = {};

  values.forEach((header, index) => {
    const headerText = cellText(header) as HeaderName;
    indexes[headerText] = index;
  });

  return requiredHeaders.every((header) => indexes[header] !== undefined) ? indexes : null;
}

function readCell(row: unknown[], indexes: HeaderIndexes, header: HeaderName): string {
  const index = indexes[header];

  return index === undefined ? "" : cellText(row[index]);
}

function parseOwnerName(workbook: ExcelJS.Workbook): string | undefined {
  for (const sheet of workbook.worksheets) {
    for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const rowValues = getWorksheetRowValues(sheet.getRow(rowNumber)).map(cellText);
      const ownerCell = rowValues.find((value) => value.includes("微信昵称："));
      const match = ownerCell?.match(/微信昵称：\[([^\]]+)\]/);

      if (match?.[1]) {
        return match[1].trim();
      }
    }
  }

  return undefined;
}

function findHeader(sheet: ExcelJS.Worksheet): { headerIndexes: HeaderIndexes; rowNumber: number } | null {
  for (let rowNumber = 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
    const headerIndexes = getHeaderIndexes(getWorksheetRowValues(sheet.getRow(rowNumber)));

    if (headerIndexes) {
      return { headerIndexes, rowNumber };
    }
  }

  return null;
}

function parseRawRow(row: unknown[], indexes: HeaderIndexes): RawRow {
  return {
    rawAmount: readCell(row, indexes, "金额(元)"),
    rawCounterparty: readCell(row, indexes, "交易对方"),
    rawMerchantOrderId: readCell(row, indexes, "商户单号"),
    rawNote: normalizeWechatNote(readCell(row, indexes, "备注")),
    rawOccurredAt: readCell(row, indexes, "交易时间"),
    rawOrderId: readCell(row, indexes, "交易单号"),
    rawPaymentMethod: readCell(row, indexes, "支付方式"),
    rawProduct: readCell(row, indexes, "商品"),
    rawStatus: readCell(row, indexes, "当前状态"),
    rawTransactionKind: readCell(row, indexes, "交易类型"),
    rawTransactionType: readCell(row, indexes, "收/支"),
  };
}

function normalizeWechatNote(value: string): string {
  return value === "/" ? "" : value;
}

function invalidRow(
  sheetName: string,
  rowNumber: number,
  ownerName: string,
  rawRow: RawRow,
  reason: string,
): InvalidImportRow {
  return {
    rawAmount: rawRow.rawAmount,
    rawCreatedBy: ownerName,
    rawCurrency: "CNY",
    rawDate: rawRow.rawOccurredAt,
    rawMember: ownerName,
    rawTransactionType: rawRow.rawTransactionType,
    reason,
    rowNumber,
    sheetName,
  };
}

function parseTransactionType(value: string): TransactionType | "NEUTRAL" | null {
  if (value === "支出") {
    return TransactionType.EXPENSE;
  }

  if (value === "收入") {
    return TransactionType.INCOME;
  }

  if (value === "中性交易") {
    return "NEUTRAL";
  }

  return null;
}

function parseAmountFen(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    return null;
  }

  const [yuanText, fenText = ""] = value.split(".");
  const amountFen = Number(yuanText) * 100 + Number(fenText.padEnd(2, "0"));

  return amountFen > 0 ? amountFen : null;
}

function parseShanghaiDate(value: string): { occurredAt: Date; occurredAtDate: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2})[ T](\d{2}):(\d{2}):(\d{2})$/.exec(value);

  if (!match) {
    return null;
  }

  const [, yearText, monthText, dayText, hourText, minuteText, secondText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const hour = Number(hourText);
  const minute = Number(minuteText);
  const second = Number(secondText);

  if (month < 1 || month > 12 || hour > 23 || minute > 59 || second > 59) {
    return null;
  }

  const occurredAt = new Date(Date.UTC(year, month - 1, day, hour - 8, minute, second));
  const shanghaiTime = new Date(occurredAt.getTime() + 8 * 60 * 60 * 1000);

  if (
    shanghaiTime.getUTCFullYear() !== year ||
    shanghaiTime.getUTCMonth() !== month - 1 ||
    shanghaiTime.getUTCDate() !== day ||
    shanghaiTime.getUTCHours() !== hour ||
    shanghaiTime.getUTCMinutes() !== minute ||
    shanghaiTime.getUTCSeconds() !== second
  ) {
    return null;
  }

  return { occurredAt, occurredAtDate: value.slice(0, 10) };
}

function buildWechatPayNote(rawRow: RawRow): string {
  return [
    `微信支付：${rawRow.rawTransactionKind}`,
    rawRow.rawCounterparty ? `交易对方：${rawRow.rawCounterparty}` : "",
    rawRow.rawProduct ? `商品：${rawRow.rawProduct}` : "",
    rawRow.rawPaymentMethod ? `支付方式：${rawRow.rawPaymentMethod}` : "",
    rawRow.rawStatus ? `状态：${rawRow.rawStatus}` : "",
    rawRow.rawOrderId ? `交易单号：${rawRow.rawOrderId}` : "",
    rawRow.rawMerchantOrderId ? `商户单号：${rawRow.rawMerchantOrderId}` : "",
    rawRow.rawNote ? `备注：${rawRow.rawNote}` : "",
  ]
    .filter(Boolean)
    .join("；");
}

function parseDataRow(
  sheetName: string,
  rowNumber: number,
  ownerName: string,
  rawRow: RawRow,
): ParsedImportRow | InvalidImportRow {
  const transactionType = parseTransactionType(rawRow.rawTransactionType);

  if (transactionType === "NEUTRAL") {
    return invalidRow(sheetName, rowNumber, ownerName, rawRow, "Neutral transaction is not importable");
  }

  if (!transactionType) {
    return invalidRow(sheetName, rowNumber, ownerName, rawRow, "Unsupported transaction type");
  }

  if (invalidStatusPattern.test(rawRow.rawStatus)) {
    return invalidRow(sheetName, rowNumber, ownerName, rawRow, "Refunded or unsuccessful transaction");
  }

  const amountFen = parseAmountFen(rawRow.rawAmount);

  if (amountFen === null) {
    return invalidRow(sheetName, rowNumber, ownerName, rawRow, "Invalid amount");
  }

  const parsedDate = parseShanghaiDate(rawRow.rawOccurredAt);

  if (!parsedDate) {
    return invalidRow(sheetName, rowNumber, ownerName, rawRow, "Invalid date");
  }

  const primaryCategory = normalizeImportedCategory(rawRow.rawTransactionKind);
  const secondaryCategory = normalizeImportedCategory(rawRow.rawCounterparty);

  return {
    amountFen,
    mappingKey: buildImportCategoryMappingKey({
      primaryCategory,
      secondaryCategory,
      source: WECHAT_PAY_SOURCE,
      transactionType,
    }),
    note: buildWechatPayNote(rawRow),
    occurredAt: parsedDate.occurredAt,
    occurredAtDate: parsedDate.occurredAtDate,
    occurredAtText: rawRow.rawOccurredAt,
    primaryCategory,
    rawAmount: rawRow.rawAmount,
    rawCreatedBy: ownerName,
    rawCurrency: "CNY",
    rawDate: rawRow.rawOccurredAt,
    rawMember: ownerName,
    rawTransactionType: rawRow.rawTransactionType,
    rowNumber,
    secondaryCategory,
    sheetName,
    sourceFingerprint: createSourceFingerprint({
      amountText: rawRow.rawAmount,
      createdByName: ownerName,
      memberName: ownerName,
      note: rawRow.rawNote,
      occurredAtText: rawRow.rawOccurredAt,
      primaryCategory,
      rawAccount: rawRow.rawPaymentMethod,
      rawCurrency: [rawRow.rawStatus, rawRow.rawOrderId, rawRow.rawMerchantOrderId].join("|"),
      rawMerchant: rawRow.rawProduct,
      secondaryCategory,
      source: WECHAT_PAY_SOURCE,
      transactionType,
    }),
    transactionType,
  };
}

export async function parseWechatPayWorkbook(buffer: Buffer): Promise<ParsedImportWorkbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const ownerName = parseOwnerName(workbook) ?? "";
  const rows: ParsedImportRow[] = [];
  const invalidRows: InvalidImportRow[] = [];
  let totalDataRows = 0;
  let foundHeader = false;

  for (const sheet of workbook.worksheets) {
    const header = findHeader(sheet);

    if (!header) {
      continue;
    }

    foundHeader = true;

    for (let rowNumber = header.rowNumber + 1; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const sheetRow = sheet.getRow(rowNumber);

      if (!sheetRow.hasValues) {
        continue;
      }

      totalDataRows += 1;

      if (totalDataRows > maxImportDataRows) {
        throw new Error(importFileTooLargeMessage);
      }

      const rawRow = parseRawRow(getWorksheetRowValues(sheetRow), header.headerIndexes);
      const parsedRow = parseDataRow(sheet.name, rowNumber, ownerName, rawRow);

      if ("reason" in parsedRow) {
        invalidRows.push(parsedRow);
      } else {
        rows.push(parsedRow);
      }
    }
  }

  if (!foundHeader) {
    throw new Error(unrecognizedWorkbookMessage);
  }

  return { invalidRows, ownerName: ownerName || undefined, rows };
}
```

- [ ] **Step 4: Run parser tests and verify pass**

Run:

```powershell
npm run test:unit -- tests/unit/wechat-pay-import.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run existing import parser tests**

Run:

```powershell
npm run test:unit -- tests/unit/sui-shou-ji-import.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/imports/sources/wechat-pay.ts tests/unit/wechat-pay-import.test.ts
git commit -m "v0.16.0 解析微信支付账单" -m "新增微信支付 Excel 解析器，覆盖昵称、收支、状态、金额、时间、备注和指纹规则。"
```

## Task 3: Generalize Draft Creation by Source

**Files:**
- Modify: `src/lib/imports/drafts.ts`
- Modify: `tests/integration/import-drafts.test.ts`

- [ ] **Step 1: Add failing integration tests for WeChat draft creation**

In `tests/integration/import-drafts.test.ts`, import `WECHAT_PAY_SOURCE`:

```ts
import { WECHAT_PAY_SOURCE } from "@/lib/imports/types";
```

Add helpers near the existing workbook helpers:

```ts
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

async function buildWechatPayWorkbook(ownerName = "李环宇") {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRows([
    ["微信支付账单明细"],
    [`微信昵称：[${ownerName}]`],
    ["起始时间：[2026-04-30 00:00:00] 终止时间：[2026-05-07 20:26:54]"],
    [],
    ["----------------------微信支付账单明细列表--------------------"],
    wechatHeaders,
    [
      "2026-05-02 17:22:40",
      "扫二维码付款",
      "阿泉食杂店",
      "收款方备注:二维码收款",
      "支出",
      "30",
      "招商银行储蓄卡(1209)",
      "已转账",
      "53110001409141202605020932752192",
      "10001073012026050201637220123649",
      "/",
    ],
  ]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}
```

Add tests inside `describe("Sui Shou Ji import draft services", ...)`:

```ts
  it("creates a WeChat Pay draft with owner inferred from the file header", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const draft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-pay.xlsx",
      sessionUser,
    });

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.source).toBe(WECHAT_PAY_SOURCE);
    expect(summary.missingMappings).toMatchObject([
      {
        mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
        primaryCategory: "扫二维码付款",
        secondaryCategory: "阿泉食杂店",
        transactionType: TransactionType.EXPENSE,
      },
    ]);
    expect(summary.rows[0]).toMatchObject({
      actorFallbackApplied: false,
      actorMemberId: husbandMember.id,
      createdByMemberId: husbandMember.id,
      creatorFallbackApplied: false,
      rawCreatedBy: "李环宇",
      rawMember: "李环宇",
      status: ImportDraftRowStatus.NEEDS_MAPPING,
    });
  });

  it("falls back to the current member when a WeChat Pay owner cannot be inferred", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const draft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("陌生昵称"),
      fileName: "wechat-pay-unknown.xlsx",
      sessionUser,
    });

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.rows[0]).toMatchObject({
      actorFallbackApplied: true,
      actorMemberId: sessionUser.memberId,
      createdByMemberId: sessionUser.memberId,
      creatorFallbackApplied: true,
    });
  });
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; npm run test:integration -- tests/integration/import-drafts.test.ts
```

Expected: FAIL because `createWechatPayImportDraft` is not exported and summary source is still typed as `sui_shou_ji`.

- [ ] **Step 3: Generalize source handling in `drafts.ts`**

Update imports:

```ts
import { parseWechatPayWorkbook } from "@/lib/imports/sources/wechat-pay";
import {
  type HouseholdMemberOption,
  type ImportSource,
  type InvalidImportRow,
  type ParsedImportRow,
  type ParsedImportWorkbook,
  SUI_SHOU_JI_SOURCE,
  WECHAT_PAY_SOURCE,
} from "@/lib/imports/types";
```

Change these types:

```ts
type ImportDraftSummary = {
  counts: {
    importable: number;
    invalid: number;
    needsMapping: number;
    possibleDuplicate: number;
    ready: number;
    sourceDuplicate: number;
    total: number;
    userSkipped: number;
  };
  createdAt: Date;
  fileName: string;
  id: string;
  missingMappings: Array<{
    count: number;
    mappingKey: string;
    primaryCategory: string | null;
    secondaryCategory: string | null;
    transactionType: TransactionType | null;
  }>;
  rows: ImportDraftRowSummary[];
  source: ImportSource;
  status: ImportDraftStatus;
};

type MappingKeyParts = {
  primaryCategory: string;
  secondaryCategory: string;
  source: ImportSource;
  transactionType: TransactionType;
};
```

Replace `parseMappingKey`:

```ts
function parseMappingKey(mappingKey: string): MappingKeyParts {
  const [source, transactionType, primaryCategory, secondaryCategory] = mappingKey.split("|");

  if (
    (source !== SUI_SHOU_JI_SOURCE && source !== WECHAT_PAY_SOURCE) ||
    (transactionType !== TransactionType.EXPENSE && transactionType !== TransactionType.INCOME) ||
    primaryCategory === undefined ||
    secondaryCategory === undefined
  ) {
    throw new Error("Invalid import mapping key");
  }

  return {
    primaryCategory,
    secondaryCategory,
    source,
    transactionType,
  };
}
```

Update helpers to accept source:

```ts
async function findExistingSourceFingerprints(
  tx: Prisma.TransactionClient,
  householdId: string,
  source: ImportSource,
  fingerprints: string[],
) {
  const existing = new Set<string>();

  for (const chunk of chunkArray(fingerprints, confirmImportChunkSize)) {
    const rows = await tx.transaction.findMany({
      where: {
        householdId,
        source,
        sourceFingerprint: { in: chunk },
      },
      select: { sourceFingerprint: true },
    });

    for (const row of rows) {
      if (row.sourceFingerprint) {
        existing.add(row.sourceFingerprint);
      }
    }
  }

  return existing;
}

async function insertImportTransactions(
  tx: Prisma.TransactionClient,
  householdId: string,
  source: ImportSource,
  rows: ConfirmImportableRow[],
  importedAt: Date,
) {
  const insertedFingerprints = new Set<string>();

  for (const chunk of chunkArray(rows, confirmImportChunkSize)) {
    const inserted = await tx.$queryRaw<Array<{ sourceFingerprint: string }>>(Prisma.sql`
      INSERT INTO "Transaction" (
        "id",
        "household_id",
        "type",
        "actor_member_id",
        "created_by_member_id",
        "category_id",
        "amount_fen",
        "occurred_at",
        "note",
        "source",
        "source_fingerprint",
        "source_imported_at",
        "created_at",
        "updated_at"
      )
      VALUES ${Prisma.join(
        chunk.map((row) => Prisma.sql`(
          ${randomUUID()},
          ${householdId},
          CAST(${row.transactionType} AS "TransactionType"),
          ${row.actorMemberId},
          ${row.createdByMemberId},
          ${row.categoryId},
          ${row.amountFen},
          ${row.occurredAt},
          ${row.note},
          ${source},
          ${row.sourceFingerprint},
          ${importedAt},
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )`),
      )}
      ON CONFLICT DO NOTHING
      RETURNING "source_fingerprint" AS "sourceFingerprint"
    `);

    for (const row of inserted) {
      insertedFingerprints.add(row.sourceFingerprint);
    }
  }

  return insertedFingerprints;
}
```

Replace summary source assignment:

```ts
    source: draft.source as ImportSource,
```

Replace `loadCategoryMappings` and `findSourceDuplicateFingerprints` signatures:

```ts
async function loadCategoryMappings(householdId: string, source: ImportSource, mappingKeys: string[]) {
  const keySet = new Set(mappingKeys);
  const mappings = await db.importCategoryMapping.findMany({
    where: {
      householdId,
      source,
    },
    select: {
      categoryId: true,
      primaryCategory: true,
      secondaryCategory: true,
      source: true,
      transactionType: true,
    },
  });
  const mappingByKey = new Map<string, string>();

  for (const mapping of mappings) {
    const mappingKey = buildImportCategoryMappingKey({
      primaryCategory: mapping.primaryCategory,
      secondaryCategory: mapping.secondaryCategory,
      source: mapping.source as ImportSource,
      transactionType: mapping.transactionType,
    });

    if (keySet.has(mappingKey)) {
      mappingByKey.set(mappingKey, mapping.categoryId);
    }
  }

  return mappingByKey;
}

async function findSourceDuplicateFingerprints(
  householdId: string,
  source: ImportSource,
  fingerprints: string[],
) {
  const rows = await db.transaction.findMany({
    where: {
      householdId,
      source,
      sourceFingerprint: { in: fingerprints },
    },
    select: { sourceFingerprint: true },
  });

  return new Set(rows.flatMap((row) => (row.sourceFingerprint ? [row.sourceFingerprint] : [])));
}
```

Replace possible duplicate source exclusion:

```ts
async function findPossibleDuplicateCandidates(input: {
  amountFen: number;
  householdId: string;
  occurredDate: string;
  source: ImportSource;
}) {
  const { nextStart, start } = shanghaiDayBounds(input.occurredDate);
  const transactions = await db.transaction.findMany({
    where: {
      amountFen: input.amountFen,
      deletedAt: null,
      householdId: input.householdId,
      occurredAt: {
        gte: start,
        lt: nextStart,
      },
      OR: [{ source: null }, { source: { not: input.source } }],
    },
    orderBy: { occurredAt: "asc" },
    select: {
      amountFen: true,
      categoryId: true,
      id: true,
      occurredAt: true,
      source: true,
      type: true,
    },
  });

  return transactions.map((transaction) => ({
    amountFen: transaction.amountFen,
    categoryId: transaction.categoryId,
    id: transaction.id,
    occurredAt: transaction.occurredAt.toISOString(),
    source: transaction.source,
    type: transaction.type,
  }));
}
```

Add generic creator and source-specific wrappers:

```ts
async function createImportDraft(input: {
  buffer: Buffer;
  fileName: string;
  parseWorkbook: (buffer: Buffer) => Promise<ParsedImportWorkbook>;
  sessionUser: SessionUser;
  source: ImportSource;
}) {
  const { currentMember, householdMembers } = await requireHouseholdMember(input.sessionUser);
  const parsedWorkbook = await input.parseWorkbook(input.buffer);
  const mappingKeys = parsedWorkbook.rows.map((row) => row.mappingKey);
  const [categoryMappings, sourceDuplicateFingerprints] = await Promise.all([
    loadCategoryMappings(input.sessionUser.householdId, input.source, mappingKeys),
    findSourceDuplicateFingerprints(
      input.sessionUser.householdId,
      input.source,
      parsedWorkbook.rows.map((row) => row.sourceFingerprint),
    ),
  ]);
  const parsedRowCreateInputs = [];

  for (const row of parsedWorkbook.rows) {
    const duplicateCandidates = await findPossibleDuplicateCandidates({
      amountFen: row.amountFen,
      householdId: input.sessionUser.householdId,
      occurredDate: row.occurredAtDate,
      source: input.source,
    });

    parsedRowCreateInputs.push(
      buildParsedRowCreateInput({
        categoryId: categoryMappings.get(row.mappingKey) ?? null,
        currentMemberId: currentMember.id,
        duplicateCandidates,
        householdMembers,
        isSourceDuplicate: sourceDuplicateFingerprints.has(row.sourceFingerprint),
        row,
      }),
    );
  }

  return db.importDraft.create({
    data: {
      createdByMemberId: currentMember.id,
      fileName: input.fileName,
      householdId: input.sessionUser.householdId,
      rows: {
        create: [
          ...parsedRowCreateInputs,
          ...parsedWorkbook.invalidRows.map(buildInvalidRowCreateInput),
        ],
      },
      source: input.source,
    },
    select: {
      id: true,
      status: true,
    },
  });
}

export async function createSuiShouJiImportDraft(input: {
  buffer: Buffer;
  fileName: string;
  sessionUser: SessionUser;
}) {
  return createImportDraft({
    ...input,
    parseWorkbook: parseSuiShouJiWorkbook,
    source: SUI_SHOU_JI_SOURCE,
  });
}

export async function createWechatPayImportDraft(input: {
  buffer: Buffer;
  fileName: string;
  sessionUser: SessionUser;
}) {
  return createImportDraft({
    ...input,
    parseWorkbook: parseWechatPayWorkbook,
    source: WECHAT_PAY_SOURCE,
  });
}
```

Update confirm calls:

```ts
    const draftSource = draft.source as ImportSource;
    const existingSourceFingerprints = await findExistingSourceFingerprints(
      tx,
      sessionUser.householdId,
      draftSource,
      importableRows.map((row) => row.sourceFingerprint),
    );
```

```ts
    const insertedFingerprints = await insertImportTransactions(
      tx,
      sessionUser.householdId,
      draftSource,
      rowsToCreate,
      importedAt,
    );
```

- [ ] **Step 4: Run integration tests and verify pass**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; npm run test:integration -- tests/integration/import-drafts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/imports/drafts.ts tests/integration/import-drafts.test.ts
git commit -m "v0.16.0 创建微信支付导入草稿" -m "复用导入草稿流程支持微信支付来源，保留随手记兼容入口。"
```

## Task 4: Save WeChat Pay Draft Owner Member

**Files:**
- Modify: `src/lib/imports/drafts.ts`
- Modify: `tests/integration/import-drafts.test.ts`

- [ ] **Step 1: Add failing member update tests**

Append to `tests/integration/import-drafts.test.ts`:

```ts
  it("updates WeChat Pay draft owner member on importable rows before confirmation", async () => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const draft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-owner.xlsx",
      sessionUser,
    });

    await services.saveWechatPayDraftOwnerMember(draft.id, wifeMember.id, sessionUser);

    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.rows[0]).toMatchObject({
      actorFallbackApplied: false,
      actorMemberId: wifeMember.id,
      createdByMemberId: wifeMember.id,
      creatorFallbackApplied: false,
    });
  });

  it("does not allow WeChat Pay owner changes after completion", async () => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-completed-owner.xlsx",
      sessionUser,
    });
    await services.saveImportDraftMappings(
      draft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
        },
      ],
      sessionUser,
    );
    await services.confirmImportDraft(draft.id, sessionUser);

    await expect(
      services.saveWechatPayDraftOwnerMember(draft.id, wifeMember.id, sessionUser),
    ).rejects.toThrow("Import draft is already completed");
  });

  it("rejects WeChat Pay owner member changes to a member outside the current household", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const outsideSessionUser = await createOutsideSessionUser();
    const draft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-owner-private.xlsx",
      sessionUser,
    });

    await expect(
      services.saveWechatPayDraftOwnerMember(draft.id, outsideSessionUser.memberId, sessionUser),
    ).rejects.toThrow("Member not found");
  });
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; npm run test:integration -- tests/integration/import-drafts.test.ts
```

Expected: FAIL because `saveWechatPayDraftOwnerMember` is not exported.

- [ ] **Step 3: Implement member update service**

Add to `src/lib/imports/drafts.ts`:

```ts
export async function saveWechatPayDraftOwnerMember(
  draftId: string,
  ownerMemberId: string,
  sessionUser: SessionUser,
) {
  await requireHouseholdMember(sessionUser);

  const [draft, ownerMember] = await Promise.all([
    db.importDraft.findFirst({
      where: {
        householdId: sessionUser.householdId,
        id: draftId,
        source: WECHAT_PAY_SOURCE,
      },
      select: { id: true, status: true },
    }),
    db.householdMember.findFirst({
      where: {
        householdId: sessionUser.householdId,
        id: ownerMemberId,
      },
      select: { id: true },
    }),
  ]);

  if (!draft) {
    throw new Error("Import draft not found");
  }

  if (!ownerMember) {
    throw new Error("Member not found");
  }

  if (draft.status !== ImportDraftStatus.PENDING) {
    throw new Error("Import draft is already completed");
  }

  await db.importDraftRow.updateMany({
    where: {
      draftId: draft.id,
      status: {
        notIn: [ImportDraftRowStatus.INVALID, ImportDraftRowStatus.SOURCE_DUPLICATE],
      },
    },
    data: {
      actorFallbackApplied: false,
      actorMemberId: ownerMember.id,
      createdByMemberId: ownerMember.id,
      creatorFallbackApplied: false,
    },
  });
}
```

- [ ] **Step 4: Run tests and verify pass**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; npm run test:integration -- tests/integration/import-drafts.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/lib/imports/drafts.ts tests/integration/import-drafts.test.ts
git commit -m "v0.16.0 支持微信账单成员选择" -m "为微信支付草稿增加成员批量更新服务，不新增草稿级数据库字段。"
```

## Task 5: Wire Upload Actions by Selected Source

**Files:**
- Modify: `src/app/(app)/records/import/actions.ts`
- Modify: `tests/integration/import-page-and-actions.test.ts`

- [ ] **Step 1: Update action mocks and write failing source selection tests**

In `tests/integration/import-page-and-actions.test.ts`, extend hoisted mocks:

```ts
  createWechatPayImportDraftMock: vi.fn(),
  saveWechatPayDraftOwnerMemberMock: vi.fn(),
```

Add them to `vi.mock("@/lib/imports/drafts", ...)`:

```ts
  createWechatPayImportDraft: createWechatPayImportDraftMock,
  saveWechatPayDraftOwnerMember: saveWechatPayDraftOwnerMemberMock,
```

Reset in the action `beforeEach`:

```ts
    createWechatPayImportDraftMock.mockReset();
    saveWechatPayDraftOwnerMemberMock.mockReset();
```

Replace the existing upload action test with:

```ts
  it("uploads a Sui Shou Ji .xlsx file when the selected source is Sui Shou Ji", async () => {
    createSuiShouJiImportDraftMock.mockResolvedValue({ id: "draft-1" });
    const formData = new FormData();
    formData.set("source", "sui_shou_ji");
    formData.set("file", new File([new Uint8Array([1, 2, 3])], "export.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );
    expect(createSuiShouJiImportDraftMock).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      fileName: "export.xlsx",
      sessionUser,
    });
    expect(createWechatPayImportDraftMock).not.toHaveBeenCalled();
  });

  it("uploads a WeChat Pay .xlsx file when the selected source is WeChat Pay", async () => {
    createWechatPayImportDraftMock.mockResolvedValue({ id: "wechat-draft" });
    const formData = new FormData();
    formData.set("source", "wechat_pay");
    formData.set("file", new File([new Uint8Array([1, 2, 3])], "wechat.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=wechat-draft",
    );
    expect(createWechatPayImportDraftMock).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      fileName: "wechat.xlsx",
      sessionUser,
    });
    expect(createSuiShouJiImportDraftMock).not.toHaveBeenCalled();
  });

  it("redirects when import source is missing", async () => {
    const formData = new FormData();
    formData.set("file", new File([new Uint8Array([1])], "export.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=missing-source",
    );
    expect(createSuiShouJiImportDraftMock).not.toHaveBeenCalled();
    expect(createWechatPayImportDraftMock).not.toHaveBeenCalled();
  });

  it("maps WeChat Pay unrecognized workbook errors to the WeChat error redirect", async () => {
    createWechatPayImportDraftMock.mockRejectedValue(new Error("无法识别微信支付账单格式"));
    const formData = new FormData();
    formData.set("source", "wechat_pay");
    formData.set("file", new File([new Uint8Array([1])], "wechat.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unrecognized-wechat-pay-file",
    );
  });

  it("saves WeChat Pay owner member selection and redirects back to the draft", async () => {
    const formData = new FormData();
    formData.set("draftId", "draft-1");
    formData.set("ownerMemberId", "member-2");

    const { saveWechatPayOwnerMember } = await import("@/app/(app)/records/import/actions");

    await expect(saveWechatPayOwnerMember(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );
    expect(saveWechatPayDraftOwnerMemberMock).toHaveBeenCalledWith(
      "draft-1",
      "member-2",
      sessionUser,
    );
  });
```

- [ ] **Step 2: Run action tests and verify failure**

Run:

```powershell
npm run test:integration -- tests/integration/import-page-and-actions.test.ts
```

Expected: FAIL because `uploadImportDraft` and `saveWechatPayOwnerMember` do not exist.

- [ ] **Step 3: Implement source-dispatching actions**

Update imports in `src/app/(app)/records/import/actions.ts`:

```ts
import {
  confirmImportDraft,
  createSuiShouJiImportDraft,
  createWechatPayImportDraft,
  saveImportDraftMappings,
  saveWechatPayDraftOwnerMember,
  setImportDraftRowDecision,
} from "@/lib/imports/drafts";
import { SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE, type ImportSource } from "@/lib/imports/types";
```

Add constants:

```ts
const unrecognizedSuiShouJiWorkbookMessage = "无法识别随手记导出格式";
const unrecognizedWechatPayWorkbookMessage = "无法识别微信支付账单格式";
```

Add source reader:

```ts
function readImportSource(formData: FormData): ImportSource | null {
  const source = String(formData.get("source") ?? "").trim();

  if (source === SUI_SHOU_JI_SOURCE || source === WECHAT_PAY_SOURCE) {
    return source;
  }

  return null;
}
```

Replace upload action:

```ts
export async function uploadImportDraft(formData: FormData) {
  const source = readImportSource(formData);

  if (!source) {
    redirect("/records/import?error=missing-source");
  }

  const file = formData.get("file");

  if (!isXlsxFile(file)) {
    redirect("/records/import?error=unsupported-file");
  }

  if (file.size > maxUploadFileBytes) {
    redirect("/records/import?error=file-too-large");
  }

  try {
    const sessionUser = await requireAppSession();
    const input = {
      buffer: Buffer.from(await file.arrayBuffer()),
      fileName: file.name,
      sessionUser,
    };
    const draft =
      source === WECHAT_PAY_SOURCE
        ? await createWechatPayImportDraft(input)
        : await createSuiShouJiImportDraft(input);

    redirectToDraft(draft.id);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    if (error instanceof Error && error.message === "Unauthorized") {
      redirect("/login");
    }

    if (error instanceof Error && error.message === unrecognizedSuiShouJiWorkbookMessage) {
      redirect("/records/import?error=unrecognized-file");
    }

    if (error instanceof Error && error.message === unrecognizedWechatPayWorkbookMessage) {
      redirect("/records/import?error=unrecognized-wechat-pay-file");
    }

    if (error instanceof Error && error.message === importFileTooLargeMessage) {
      redirect("/records/import?error=file-too-large");
    }

    redirect("/records/import?error=upload-failed");
  }
}
```

Add compatibility export so older tests or callers can be removed later in the same task:

```ts
export const uploadSuiShouJiImportDraft = uploadImportDraft;
```

Add member action:

```ts
export async function saveWechatPayOwnerMember(formData: FormData) {
  const draftId = readDraftId(formData);
  const ownerMemberId = String(formData.get("ownerMemberId") ?? "").trim();

  if (!ownerMemberId) {
    redirectToDraft(draftId);
  }

  const sessionUser = await requireAppSession();

  await saveWechatPayDraftOwnerMember(draftId, ownerMemberId, sessionUser);

  redirectToDraft(draftId);
}
```

- [ ] **Step 4: Run action tests and verify pass**

Run:

```powershell
npm run test:integration -- tests/integration/import-page-and-actions.test.ts
```

Expected: PASS.

- [ ] **Step 5: Commit**

```powershell
git add src/app/(app)/records/import/actions.ts tests/integration/import-page-and-actions.test.ts
git commit -m "v0.16.0 分发导入上传来源" -m "导入上传支持随手记和微信支付来源选择，并新增微信成员保存 action。"
```

## Task 6: Render Source Selection and WeChat Owner Member UI

**Files:**
- Modify: `src/app/(app)/records/import/page.tsx`
- Modify: `src/lib/i18n.ts`
- Modify: `tests/integration/import-page-and-actions.test.ts`
- Modify: `tests/unit/i18n.test.ts`

- [ ] **Step 1: Add failing i18n and page tests**

Add to `tests/unit/i18n.test.ts`:

```ts
  it("includes import source and WeChat Pay owner member messages", () => {
    expect(getMessages("zh-CN").import.sources.wechatPay).toBe("微信支付");
    expect(getMessages("zh-CN").import.ownerMemberTitle).toBe("账单归属成员");
    expect(getMessages("en-US").import.sources.wechatPay).toBe("WeChat Pay");
    expect(getMessages("en-US").import.ownerMemberTitle).toBe("Bill owner");
  });
```

In `tests/integration/import-page-and-actions.test.ts`, update `buildPendingDraftSummary` to accept source overrides already supported by spread. Add a WeChat summary test:

```ts
  it("renders source selection on the upload form", async () => {
    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      await ImportPage({
        searchParams: Promise.resolve({}),
      }),
    );

    expect(markup).toContain("name=\"source\"");
    expect(markup).toContain("value=\"sui_shou_ji\"");
    expect(markup).toContain("value=\"wechat_pay\"");
    expect(markup).toContain("随手记");
    expect(markup).toContain("微信支付");
  });

  it("renders WeChat Pay owner member selector for pending WeChat drafts", async () => {
    householdMemberFindManyMock.mockResolvedValue([
      { id: "member-1", memberName: "老公" },
      { id: "member-2", memberName: "老婆" },
    ]);
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        missingMappings: [],
        rows: [
          {
            ...buildPendingDraftSummary().rows[0],
            actorMemberId: "member-2",
            createdByMemberId: "member-2",
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
            primaryCategory: "扫二维码付款",
            secondaryCategory: "阿泉食杂店",
          },
        ],
        source: "wechat_pay",
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      }),
    );

    expect(markup).toContain("账单归属成员");
    expect(markup).toContain("name=\"ownerMemberId\"");
    expect(markup).toContain("value=\"member-2\" selected=\"\"");
    expect(markup).toContain("保存成员");
  });

  it("does not render WeChat Pay owner member selector for Sui Shou Ji drafts", async () => {
    getImportDraftSummaryMock.mockResolvedValue(buildPendingDraftSummary());

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      }),
    );

    expect(markup).not.toContain("账单归属成员");
    expect(markup).not.toContain("name=\"ownerMemberId\"");
  });
```

- [ ] **Step 2: Run tests and verify failure**

Run:

```powershell
npm run test:unit -- tests/unit/i18n.test.ts
npm run test:integration -- tests/integration/import-page-and-actions.test.ts
```

Expected: FAIL because messages and UI are not present.

- [ ] **Step 3: Add i18n messages**

In `src/lib/i18n.ts`, change Chinese import copy:

```ts
    import: {
      eyebrow: "账单导入",
      title: "导入记录",
      description: "选择来源并上传 .xlsx，补齐分类映射后确认入账。",
      uploadTitle: "上传文件",
      uploadDescription: "选择导入来源和对应的 .xlsx 文件。",
      source: "来源",
      sources: {
        suiShouJi: "随手记",
        wechatPay: "微信支付",
      },
      ownerMemberTitle: "账单归属成员",
      ownerMemberDescription: "微信账单没有独立成员字段，这里选择的成员会用于这份草稿的所有可导入记录。",
      saveOwnerMember: "保存成员",
```

Add Chinese error keys:

```ts
        "missing-source": "请选择导入来源。",
        "unrecognized-wechat-pay-file": "无法识别微信支付账单格式。",
```

Change English import copy:

```ts
    import: {
      eyebrow: "Bill import",
      title: "Import records",
      description: "Choose a source, upload an .xlsx file, map categories, then confirm the import.",
      uploadTitle: "Upload file",
      uploadDescription: "Choose the import source and matching .xlsx file.",
      source: "Source",
      sources: {
        suiShouJi: "Sui Shou Ji",
        wechatPay: "WeChat Pay",
      },
      ownerMemberTitle: "Bill owner",
      ownerMemberDescription: "WeChat bills do not include separate member fields. This member is used for all importable rows in this draft.",
      saveOwnerMember: "Save member",
```

Add English error keys:

```ts
        "missing-source": "Choose an import source.",
        "unrecognized-wechat-pay-file": "Could not recognize the WeChat Pay bill format.",
```

- [ ] **Step 4: Update page imports and data loading**

In `src/app/(app)/records/import/page.tsx`, add:

```ts
import { SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE } from "@/lib/imports/types";
```

Change actions import:

```ts
import {
  confirmImportDraftAction,
  saveImportDecisions,
  saveImportMappings,
  saveWechatPayOwnerMember,
  uploadImportDraft,
} from "./actions";
```

Add member type:

```ts
type MemberOption = {
  id: string;
  memberName: string;
};
```

Change data loading:

```ts
  const [summary, categories, members] = draftId
    ? await Promise.all([
        getImportDraftSummary(draftId, sessionUser),
        db.category.findMany({
          where: { isActive: true },
          orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
          select: { id: true, name: true, type: true },
        }) as Promise<CategoryOption[]>,
        db.householdMember.findMany({
          where: { householdId: sessionUser.householdId },
          orderBy: { joinedAt: "asc" },
          select: { id: true, memberName: true },
        }) as Promise<MemberOption[]>,
      ])
    : [null, [] as CategoryOption[], [] as MemberOption[]];
```

Add current owner derivation:

```ts
  const wechatOwnerMemberId =
    summary?.source === WECHAT_PAY_SOURCE
      ? (summary.rows.find((row) => row.actorMemberId)?.actorMemberId ?? sessionUser.memberId)
      : null;
```

- [ ] **Step 5: Update upload form and owner form JSX**

Replace upload form action:

```tsx
        <form action={uploadImportDraft} className="ios-panel space-y-4 p-5">
```

Insert source selector before file input:

```tsx
          <fieldset className="space-y-2">
            <legend className="text-sm font-medium text-stone-700">{messages.import.source}</legend>
            <div className="grid grid-cols-2 gap-2">
              <label className="flex items-center justify-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-2 text-sm font-medium">
                <input name="source" required type="radio" value={SUI_SHOU_JI_SOURCE} />
                {messages.import.sources.suiShouJi}
              </label>
              <label className="flex items-center justify-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-2 text-sm font-medium">
                <input name="source" required type="radio" value={WECHAT_PAY_SOURCE} />
                {messages.import.sources.wechatPay}
              </label>
            </div>
          </fieldset>
```

Insert WeChat owner form after summary stats and before mapping form:

```tsx
          {summary.source === WECHAT_PAY_SOURCE && wechatOwnerMemberId ? (
            <form action={saveWechatPayOwnerMember} className="ios-panel space-y-4 p-5">
              <input name="draftId" type="hidden" value={summary.id} />
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">{messages.import.ownerMemberTitle}</h2>
                <p className="text-sm text-stone-500">{messages.import.ownerMemberDescription}</p>
              </div>
              <label className="block space-y-2 text-sm font-medium text-stone-700">
                <span>{messages.common.who}</span>
                <select
                  className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"
                  defaultValue={wechatOwnerMemberId}
                  name="ownerMemberId"
                  required
                >
                  {members.map((member) => (
                    <option key={member.id} value={member.id}>
                      {member.memberName}
                    </option>
                  ))}
                </select>
              </label>
              <button
                className="w-full rounded-full bg-stone-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-stone-700"
                type="submit"
              >
                {messages.import.saveOwnerMember}
              </button>
            </form>
          ) : null}
```

- [ ] **Step 6: Run tests and verify pass**

Run:

```powershell
npm run test:unit -- tests/unit/i18n.test.ts
npm run test:integration -- tests/integration/import-page-and-actions.test.ts
```

Expected: PASS.

- [ ] **Step 7: Commit**

```powershell
git add src/app/(app)/records/import/page.tsx src/lib/i18n.ts tests/integration/import-page-and-actions.test.ts tests/unit/i18n.test.ts
git commit -m "v0.16.0 显示微信导入交互" -m "导入页增加来源选择、微信账单成员下拉和双语文案。"
```

## Task 7: Confirm WeChat Pay Import Behavior End-to-End in Services

**Files:**
- Modify: `tests/integration/import-drafts.test.ts`

- [ ] **Step 1: Add confirmation, mapping reuse, and duplicate tests**

Append these tests:

```ts
  it("confirms mapped WeChat Pay rows into transactions with source metadata", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-confirm.xlsx",
      sessionUser,
    });

    await services.saveImportDraftMappings(
      draft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
        },
      ],
      sessionUser,
    );

    const result = await services.confirmImportDraft(draft.id, sessionUser);

    expect(result).toMatchObject({
      createdCount: 1,
      sourceDuplicateCount: 0,
      userSkippedCount: 0,
    });

    await expect(
      db.transaction.findFirstOrThrow({
        where: {
          householdId: sessionUser.householdId,
          source: "wechat_pay",
        },
      }),
    ).resolves.toMatchObject({
      actorMemberId: husbandMember.id,
      amountFen: 3000,
      categoryId: expenseCategory.id,
      createdByMemberId: husbandMember.id,
      source: "wechat_pay",
      type: TransactionType.EXPENSE,
    });
  });

  it("reuses household WeChat Pay category mappings on the next draft", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const firstDraft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-first.xlsx",
      sessionUser,
    });

    await services.saveImportDraftMappings(
      firstDraft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
        },
      ],
      sessionUser,
    );

    const secondDraft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-second.xlsx",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(secondDraft.id, sessionUser);

    expect(summary.counts.needsMapping).toBe(0);
    expect(summary.rows[0]).toMatchObject({
      categoryId: expenseCategory.id,
      status: ImportDraftRowStatus.READY,
    });
  });

  it("marks repeated WeChat Pay source fingerprints as source duplicates", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const firstDraft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-first-duplicate.xlsx",
      sessionUser,
    });
    await services.saveImportDraftMappings(
      firstDraft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
        },
      ],
      sessionUser,
    );
    await services.confirmImportDraft(firstDraft.id, sessionUser);

    const secondDraft = await services.createWechatPayImportDraft({
      buffer: await buildWechatPayWorkbook("李环宇"),
      fileName: "wechat-second-duplicate.xlsx",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(secondDraft.id, sessionUser);

    expect(summary.counts.sourceDuplicate).toBe(1);
    expect(summary.rows[0]).toMatchObject({
      status: ImportDraftRowStatus.SOURCE_DUPLICATE,
      userDecision: ImportRowDecision.SKIP,
    });
  });
```

- [ ] **Step 2: Run integration tests**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; npm run test:integration -- tests/integration/import-drafts.test.ts
```

Expected: PASS. If a test fails because earlier implementation used a different mapping key, adjust implementation to match `wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店`.

- [ ] **Step 3: Commit**

```powershell
git add tests/integration/import-drafts.test.ts
git commit -m "v0.16.0 覆盖微信导入确认" -m "补充微信支付映射复用、确认入账和同源重复集成测试。"
```

## Task 8: Add E2E Coverage for Source Selection and WeChat Pay

**Files:**
- Modify: `tests/e2e/import-sui-shou-ji.spec.ts`
- Create: `tests/e2e/import-wechat-pay.spec.ts`

- [ ] **Step 1: Update Sui Shou Ji e2e for source selection**

In `tests/e2e/import-sui-shou-ji.spec.ts`, after navigating to `/records/import` and before file upload, add:

```ts
  await page.getByLabel("随手记").check();
```

- [ ] **Step 2: Create WeChat Pay e2e test**

Create `tests/e2e/import-wechat-pay.spec.ts`:

```ts
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
    ["微信昵称：[李环宇]"],
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
  await expect(page.getByRole("heading", { name: "账单归属成员" })).toBeVisible();
  await expect(page.getByLabel("成员")).toHaveValue(/.+/);

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

  await expect(page).toHaveURL(/\/records/);
  const importedRecord = page.getByRole("link", { name: /-30\.12.*餐饮.*老公/ });
  await expect(importedRecord).toBeVisible();
  await expect(importedRecord).toContainText("-30.12");
  await expect(importedRecord).toContainText("餐饮");
  await expect(importedRecord).toContainText("老公");
});
```

- [ ] **Step 3: Run e2e tests and verify pass**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; $env:AUTH_SECRET='replace-me'; npm run test:e2e
```

Expected: PASS with the existing 9 tests plus the new WeChat Pay import test.

- [ ] **Step 4: Commit**

```powershell
git add tests/e2e/import-sui-shou-ji.spec.ts tests/e2e/import-wechat-pay.spec.ts
git commit -m "v0.16.0 验证微信支付导入流程" -m "端到端覆盖来源选择、微信账单上传、成员确认、分类映射和导入结果。"
```

## Task 9: Full Verification and Version Commit Hygiene

**Files:**
- Inspect: `package.json`
- Inspect: `package-lock.json`
- Inspect: all changed files

- [ ] **Step 1: Confirm project version remains correct**

Run:

```powershell
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); if(p.version !== '0.16.0' || l.version !== '0.16.0' || l.packages[''].version !== '0.16.0') process.exit(1); console.log(p.version)"
```

Expected:

```text
0.16.0
```

- [ ] **Step 2: Run lint**

Run:

```powershell
npm run lint
```

Expected: PASS.

- [ ] **Step 3: Run unit tests**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; npm run test:unit
```

Expected: PASS.

- [ ] **Step 4: Run integration tests**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; npm run test:integration
```

Expected: PASS.

- [ ] **Step 5: Run e2e tests**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; $env:AUTH_SECRET='replace-me'; npm run test:e2e
```

Expected: PASS.

- [ ] **Step 6: Inspect git history against origin/master**

Run:

```powershell
git log --oneline origin/master..HEAD
git status --short
```

Expected: commits are all for the微信支付导入 feature, and worktree is clean. If multiple local commits exist for this same feature, squash them into one feature commit before final delivery:

```powershell
git reset --soft origin/master
git commit -m "v0.16.0 支持微信支付账单导入" -m "新增微信支付来源解析、成员选择、分类映射复用、同源去重和端到端导入验证。"
```

Use `git reset --soft` only when all commits shown by `origin/master..HEAD` belong to this same feature.

## Self-Review

- Spec coverage: parser, source selection, member dropdown without new DB fields, category mapping by `收/支 + 交易类型 + 交易对方`, neutral/refund invalid rows, same-source dedupe, possible duplicates, i18n, integration tests, e2e, and full verification are covered.
- Placeholder scan: the plan contains no unresolved placeholder markers or undefined future work. Every task names files, commands, expected results, and concrete code changes.
- Type consistency: source constants are `SUI_SHOU_JI_SOURCE` and `WECHAT_PAY_SOURCE`; public draft functions are `createSuiShouJiImportDraft`, `createWechatPayImportDraft`, `saveWechatPayDraftOwnerMember`; action functions are `uploadImportDraft` and `saveWechatPayOwnerMember`.
