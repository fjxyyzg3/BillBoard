# 支付宝导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 在现有 `/records/import` 草稿导入流程中支持支付宝官方 `.csv` 账单导入。

**Architecture:** 复用现有导入草稿、分类映射、同源去重、疑似重复和确认写入流程。新增 `alipay` 来源解析器，上传 action 按来源校验 `.xlsx` 或 `.csv`，支付账单成员下拉从微信支付扩展到微信支付和支付宝。

**Tech Stack:** Next.js server actions, React server components, Prisma, Vitest, Playwright, Node `TextDecoder`.

---

## File Structure

- Create: `src/lib/imports/sources/alipay.ts`
  - 负责解码支付宝官方 CSV、查找明细表头、解析文件头姓名、解析 CSV 行、规范化收入支出行、生成备注、生成来源指纹。
- Modify: `src/lib/imports/types.ts`
  - 增加 `ALIPAY_SOURCE`，扩展 `ImportSource`。
- Modify: `src/lib/imports/drafts.ts`
  - 新增 `createAlipayImportDraft`；把支付账单成员保存逻辑通用化为微信支付和支付宝共用。
- Modify: `src/app/(app)/records/import/actions.ts`
  - 上传 action 支持 `alipay`，按来源校验文件扩展名；新增通用支付账单成员保存 action。
- Modify: `src/app/(app)/records/import/page.tsx`
  - 上传来源增加支付宝；文件输入接受 `.xlsx,.csv`；支付账单成员下拉支持微信支付和支付宝；来源标签支持支付宝。
- Modify: `src/lib/i18n.ts`
  - 补齐支付宝中英文来源、描述、错误文案。
- Modify: `tests/unit/sui-shou-ji-import.test.ts`
  - 覆盖支付宝来源常量和映射 key。
- Create: `tests/unit/alipay-import.test.ts`
  - 支付宝解析器单元测试。
- Modify: `tests/unit/i18n.test.ts`
  - 覆盖支付宝来源和错误文案。
- Modify: `tests/integration/import-drafts.test.ts`
  - 覆盖支付宝草稿创建、成员推断、成员保存、映射复用、确认导入、同源去重、疑似重复和权限隔离。
- Modify: `tests/integration/import-page-and-actions.test.ts`
  - 覆盖支付宝上传 action、文件类型错误、页面来源选择、支付账单成员下拉和 action wiring。
- Create: `tests/e2e/import-alipay.spec.ts`
  - 支付宝端到端导入路径。
- Modify: `package.json`
  - 实现提交时版本从 `0.19.0` 升到 `0.20.0`。
- Modify: `package-lock.json`
  - 同步根项目版本字段到 `0.20.0`。

## Task 1: Add Alipay Source Type and Version Bump

**Files:**
- Modify: `src/lib/imports/types.ts`
- Modify: `tests/unit/sui-shou-ji-import.test.ts`
- Modify: `package.json`
- Modify: `package-lock.json`

- [ ] **Step 1: Write the failing source expectation**

Update the import in `tests/unit/sui-shou-ji-import.test.ts`:

```ts
import { ALIPAY_SOURCE, SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE } from "@/lib/imports/types";
```

Add this assertion inside `describe("buildImportCategoryMappingKey", ...)`:

```ts
  it("supports the Alipay source prefix for category mapping keys", () => {
    expect(ALIPAY_SOURCE).toBe("alipay");
    expect(
      buildImportCategoryMappingKey({
        source: ALIPAY_SOURCE,
        transactionType: TransactionType.EXPENSE,
        primaryCategory: "餐饮美食",
        secondaryCategory: "示例商户",
      }),
    ).toBe("alipay|EXPENSE|餐饮美食|示例商户");
  });
```

- [ ] **Step 2: Run the focused test and verify failure**

Run:

```powershell
npm run test:unit -- tests/unit/sui-shou-ji-import.test.ts
```

Expected: FAIL because `ALIPAY_SOURCE` is not exported.

- [ ] **Step 3: Extend source types**

In `src/lib/imports/types.ts`, replace the source constants and union with:

```ts
export const SUI_SHOU_JI_SOURCE = "sui_shou_ji" as const;
export const WECHAT_PAY_SOURCE = "wechat_pay" as const;
export const ALIPAY_SOURCE = "alipay" as const;

export type ImportSource =
  | typeof SUI_SHOU_JI_SOURCE
  | typeof WECHAT_PAY_SOURCE
  | typeof ALIPAY_SOURCE;
```

- [ ] **Step 4: Bump implementation feature version**

In `package.json`, set:

```json
  "version": "0.20.0",
```

In `package-lock.json`, update both root version fields:

```json
  "version": "0.20.0",
```

and:

```json
      "version": "0.20.0",
```

- [ ] **Step 5: Run the focused test and verify pass**

Run:

```powershell
npm run test:unit -- tests/unit/sui-shou-ji-import.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/imports/types.ts tests/unit/sui-shou-ji-import.test.ts package.json package-lock.json
git commit -m "v0.20.0 扩展支付宝导入来源" -m "增加支付宝来源常量和映射 key 覆盖，并同步实现版本。"
```

## Task 2: Add Alipay CSV Parser

**Files:**
- Create: `src/lib/imports/sources/alipay.ts`
- Create: `tests/unit/alipay-import.test.ts`

- [ ] **Step 1: Write failing parser tests**

Create `tests/unit/alipay-import.test.ts`:

```ts
import { TransactionType } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { parseAlipayCsv } from "@/lib/imports/sources/alipay";

const gb18030OfficialCsvHex = "fake-gb18030-fixture-omitted";

const headers = [
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

function buildUtf8Csv(rows: string[][], ownerName = "老公") {
  return Buffer.from(
    [
      "------------------------------------------------------------------------------------",
      "导出信息：",
      `姓名：${ownerName}`,
      "支付宝账户：example-alipay-account",
      "------------------------支付宝支付科技有限公司  电子客户回单------------------------",
      [...headers, ""].join(","),
      ...rows.map((row) => [...row, ""].join(",")),
    ].join("\n"),
    "utf8",
  );
}

function normalExpenseRow(overrides: Partial<Record<string, string>> = {}) {
  return [
    overrides.rawOccurredAt ?? "2026-05-07 12:17:13",
    overrides.rawCategory ?? "餐饮美食",
    overrides.rawCounterparty ?? "示例商户",
    overrides.rawCounterpartyAccount ?? "/",
    overrides.rawProduct ?? "示例商户",
    overrides.rawTransactionType ?? "支出",
    overrides.rawAmount ?? "22.85",
    overrides.rawPaymentMethod ?? "示例银行信用卡(0000)&红包",
    overrides.rawStatus ?? "交易成功",
    overrides.rawOrderId ?? "alipay-order-1\t",
    overrides.rawMerchantOrderId ?? "merchant-order-1\t",
    overrides.rawNote ?? "/",
  ];
}

describe("parseAlipayCsv", () => {
  it("decodes GB18030 official CSV and parses expense rows", async () => {
    const result = await parseAlipayCsv(Buffer.from(gb18030OfficialCsvHex, "hex"));

    expect(result.ownerName).toBe("老公");
    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      amountFen: 2285,
      mappingKey: "alipay|EXPENSE|餐饮美食|示例商户",
      occurredAt: new Date("2026-05-07T04:17:13.000Z"),
      occurredAtDate: "2026-05-07",
      occurredAtText: "2026-05-07 12:17:13",
      primaryCategory: "餐饮美食",
      rawAmount: "22.85",
      rawCreatedBy: "老公",
      rawCurrency: "CNY",
      rawDate: "2026-05-07 12:17:13",
      rawMember: "老公",
      rawTransactionType: "支出",
      rowNumber: 4,
      secondaryCategory: "示例商户",
      sheetName: "支付宝",
      transactionType: TransactionType.EXPENSE,
    });
    expect(result.rows[0]?.note).toContain("支付宝：餐饮美食");
    expect(result.rows[0]?.note).toContain("交易对方：示例商户");
    expect(result.rows[0]?.note).toContain("收/付款方式：示例银行信用卡(0000)&红包");
    expect(result.rows[0]?.note).not.toContain("备注：/");
    expect(result.rows[0]?.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("parses income rows and treats unknown non-error statuses as importable", async () => {
    const result = await parseAlipayCsv(
      buildUtf8Csv([
        normalExpenseRow({
          rawAmount: "88.66",
          rawCategory: "转账红包",
          rawCounterparty: "朋友",
          rawProduct: "转账收款",
          rawStatus: "新的成功状态",
          rawTransactionType: "收入",
        }),
      ]),
    );

    expect(result.invalidRows).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      amountFen: 8866,
      mappingKey: "alipay|INCOME|转账红包|朋友",
      transactionType: TransactionType.INCOME,
    });
  });

  it("marks non-income-expense and zero amount rows as invalid without blocking other rows", async () => {
    const result = await parseAlipayCsv(
      buildUtf8Csv([
        normalExpenseRow({ rawAmount: "100", rawTransactionType: "不计收支" }),
        normalExpenseRow({ rawAmount: "0.00", rawOrderId: "zero-order" }),
      ]),
    );

    expect(result.rows).toEqual([]);
    expect(result.invalidRows.map((row) => row.reason)).toEqual([
      "Non-income-expense transaction is not importable",
      "Invalid amount",
    ]);
  });

  it("marks refund, closed, and failed statuses as invalid", async () => {
    const result = await parseAlipayCsv(
      buildUtf8Csv([
        normalExpenseRow({ rawStatus: "已退款", rawOrderId: "refund-order" }),
        normalExpenseRow({ rawStatus: "交易关闭", rawOrderId: "closed-order" }),
        normalExpenseRow({ rawStatus: "支付失败", rawOrderId: "failed-order" }),
      ]),
    );

    expect(result.rows).toEqual([]);
    expect(result.invalidRows.map((row) => row.reason)).toEqual([
      "Refunded or unsuccessful transaction",
      "Refunded or unsuccessful transaction",
      "Refunded or unsuccessful transaction",
    ]);
  });

  it("keeps fingerprints stable when only CSV encoding changes", async () => {
    const gb18030Result = await parseAlipayCsv(Buffer.from(gb18030OfficialCsvHex, "hex"));
    const utf8Result = await parseAlipayCsv(buildUtf8Csv([normalExpenseRow()]));

    expect(gb18030Result.rows[0]?.sourceFingerprint).toBe(utf8Result.rows[0]?.sourceFingerprint);
  });

  it("parses quoted CSV fields containing commas", async () => {
    const result = await parseAlipayCsv(
      Buffer.from(
        [
          "姓名：老公",
          [...headers, ""].join(","),
          [
            "2026-05-07 12:17:13",
            "餐饮美食",
            "\"隆江,猪脚饭\"",
            "/",
            "\"套餐,加饭\"",
            "支出",
            "22.85",
            "示例银行信用卡(0000)",
            "交易成功",
            "quoted-order",
            "quoted-merchant-order",
            "/",
            "",
          ].join(","),
        ].join("\n"),
        "utf8",
      ),
    );

    expect(result.rows[0]).toMatchObject({
      mappingKey: "alipay|EXPENSE|餐饮美食|隆江,猪脚饭",
      secondaryCategory: "隆江,猪脚饭",
    });
    expect(result.rows[0]?.note).toContain("商品：套餐,加饭");
  });

  it("throws for CSV without an Alipay detail header", async () => {
    await expect(parseAlipayCsv(Buffer.from("交易类型,日期\n支出,2026-05-07", "utf8"))).rejects.toThrow(
      "无法识别支付宝账单格式",
    );
  });
});
```

- [ ] **Step 2: Run parser tests and verify failure**

Run:

```powershell
npm run test:unit -- tests/unit/alipay-import.test.ts
```

Expected: FAIL because `src/lib/imports/sources/alipay.ts` does not exist.

- [ ] **Step 3: Implement the parser**

Create `src/lib/imports/sources/alipay.ts`:

```ts
import { TextDecoder } from "node:util";

import { TransactionType } from "@prisma/client";

import { buildImportCategoryMappingKey, normalizeImportedCategory } from "../category-mapping";
import { createSourceFingerprint } from "../fingerprint";
import {
  ALIPAY_SOURCE,
  type InvalidImportRow,
  type ParsedImportRow,
  type ParsedImportWorkbook,
} from "../types";

const requiredHeaders = [
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
] as const;

const sheetName = "支付宝";
const unrecognizedCsvMessage = "无法识别支付宝账单格式";
const importFileTooLargeMessage = "Import file is too large";
const maxImportDataRows = 20_000;
const invalidStatusPattern = /退款|关闭|失败/;

type HeaderName = (typeof requiredHeaders)[number];
type HeaderIndexes = Partial<Record<HeaderName, number>>;
type RawRow = {
  rawAmount: string;
  rawCategory: string;
  rawCounterparty: string;
  rawCounterpartyAccount: string;
  rawMerchantOrderId: string;
  rawNote: string;
  rawOccurredAt: string;
  rawOrderId: string;
  rawPaymentMethod: string;
  rawProduct: string;
  rawStatus: string;
  rawTransactionType: string;
};

function cellText(value: unknown): string {
  return String(value ?? "").trim();
}

function normalizeSlash(value: string): string {
  return value === "/" ? "" : value;
}

function decodeAlipayCsv(buffer: Buffer): string {
  const gb18030Text = new TextDecoder("gb18030").decode(buffer);

  if (gb18030Text.includes("交易时间") || gb18030Text.includes("导出信息")) {
    return gb18030Text;
  }

  return new TextDecoder("utf-8").decode(buffer);
}

function parseCsvRecords(text: string): string[][] {
  const records: string[][] = [];
  let record: string[] = [];
  let field = "";
  let inQuotes = false;

  for (let index = 0; index < text.length; index += 1) {
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === '"') {
      if (inQuotes && nextChar === '"') {
        field += '"';
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      continue;
    }

    if (char === "," && !inQuotes) {
      record.push(field.trim());
      field = "";
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      record.push(field.trim());
      if (record.some((value) => value !== "")) {
        records.push(record);
      }
      record = [];
      field = "";
      continue;
    }

    field += char;
  }

  record.push(field.trim());
  if (record.some((value) => value !== "")) {
    records.push(record);
  }

  return records;
}

function parseOwnerName(text: string): string | undefined {
  const match = text.match(/姓名：([^\r\n]+)/);

  return match?.[1]?.trim() || undefined;
}

function getHeaderIndexes(row: string[]): HeaderIndexes | null {
  const indexes: HeaderIndexes = {};

  row.forEach((header, index) => {
    const headerText = cellText(header) as HeaderName;
    indexes[headerText] = index;
  });

  return requiredHeaders.every((header) => indexes[header] !== undefined) ? indexes : null;
}

function findHeader(records: string[][]): { headerIndexes: HeaderIndexes; rowIndex: number } | null {
  for (let rowIndex = 0; rowIndex < records.length; rowIndex += 1) {
    const headerIndexes = getHeaderIndexes(records[rowIndex] ?? []);

    if (headerIndexes) {
      return { headerIndexes, rowIndex };
    }
  }

  return null;
}

function readCell(row: string[], indexes: HeaderIndexes, header: HeaderName): string {
  const index = indexes[header];

  return index === undefined ? "" : cellText(row[index]);
}

function parseRawRow(row: string[], indexes: HeaderIndexes): RawRow {
  return {
    rawAmount: readCell(row, indexes, "金额"),
    rawCategory: readCell(row, indexes, "交易分类"),
    rawCounterparty: normalizeSlash(readCell(row, indexes, "交易对方")),
    rawCounterpartyAccount: normalizeSlash(readCell(row, indexes, "对方账号")),
    rawMerchantOrderId: normalizeSlash(readCell(row, indexes, "商家订单号")),
    rawNote: normalizeSlash(readCell(row, indexes, "备注")),
    rawOccurredAt: readCell(row, indexes, "交易时间"),
    rawOrderId: normalizeSlash(readCell(row, indexes, "交易订单号")),
    rawPaymentMethod: normalizeSlash(readCell(row, indexes, "收/付款方式")),
    rawProduct: normalizeSlash(readCell(row, indexes, "商品说明")),
    rawStatus: readCell(row, indexes, "交易状态"),
    rawTransactionType: readCell(row, indexes, "收/支"),
  };
}

function invalidRow(rowNumber: number, ownerName: string, rawRow: RawRow, reason: string): InvalidImportRow {
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

function parseTransactionType(value: string): TransactionType | "NON_INCOME_EXPENSE" | null {
  if (value === "支出") {
    return TransactionType.EXPENSE;
  }

  if (value === "收入") {
    return TransactionType.INCOME;
  }

  if (value === "不计收支") {
    return "NON_INCOME_EXPENSE";
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

function buildAlipayNote(rawRow: RawRow): string {
  return [
    `支付宝：${rawRow.rawCategory}`,
    rawRow.rawCounterparty ? `交易对方：${rawRow.rawCounterparty}` : "",
    rawRow.rawProduct ? `商品：${rawRow.rawProduct}` : "",
    rawRow.rawPaymentMethod ? `收/付款方式：${rawRow.rawPaymentMethod}` : "",
    rawRow.rawStatus ? `状态：${rawRow.rawStatus}` : "",
    rawRow.rawOrderId ? `交易订单号：${rawRow.rawOrderId}` : "",
    rawRow.rawMerchantOrderId ? `商家订单号：${rawRow.rawMerchantOrderId}` : "",
    rawRow.rawNote ? `备注：${rawRow.rawNote}` : "",
  ]
    .filter(Boolean)
    .join("；");
}

function parseDataRow(rowNumber: number, ownerName: string, rawRow: RawRow): ParsedImportRow | InvalidImportRow {
  const transactionType = parseTransactionType(rawRow.rawTransactionType);

  if (transactionType === "NON_INCOME_EXPENSE") {
    return invalidRow(rowNumber, ownerName, rawRow, "Non-income-expense transaction is not importable");
  }

  if (!transactionType) {
    return invalidRow(rowNumber, ownerName, rawRow, "Unsupported transaction type");
  }

  if (invalidStatusPattern.test(rawRow.rawStatus)) {
    return invalidRow(rowNumber, ownerName, rawRow, "Refunded or unsuccessful transaction");
  }

  const amountFen = parseAmountFen(rawRow.rawAmount);

  if (amountFen === null) {
    return invalidRow(rowNumber, ownerName, rawRow, "Invalid amount");
  }

  const parsedDate = parseShanghaiDate(rawRow.rawOccurredAt);

  if (!parsedDate) {
    return invalidRow(rowNumber, ownerName, rawRow, "Invalid date");
  }

  const primaryCategory = normalizeImportedCategory(rawRow.rawCategory);
  const secondaryCategory = normalizeImportedCategory(rawRow.rawCounterparty);

  return {
    amountFen,
    mappingKey: buildImportCategoryMappingKey({
      primaryCategory,
      secondaryCategory,
      source: ALIPAY_SOURCE,
      transactionType,
    }),
    note: buildAlipayNote(rawRow),
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
      createdByName: "",
      memberName: ownerName,
      note: rawRow.rawNote,
      occurredAtText: rawRow.rawOccurredAt,
      primaryCategory,
      rawAccount: rawRow.rawPaymentMethod,
      rawCurrency: [
        rawRow.rawCounterpartyAccount,
        rawRow.rawStatus,
        rawRow.rawOrderId,
        rawRow.rawMerchantOrderId,
      ].join("|"),
      rawMerchant: rawRow.rawProduct,
      secondaryCategory,
      source: ALIPAY_SOURCE,
      transactionType,
    }),
    transactionType,
  };
}

export async function parseAlipayCsv(buffer: Buffer): Promise<ParsedImportWorkbook> {
  const text = decodeAlipayCsv(buffer);
  const records = parseCsvRecords(text);
  const header = findHeader(records);

  if (!header) {
    throw new Error(unrecognizedCsvMessage);
  }

  const ownerName = parseOwnerName(text) ?? "";
  const rows: ParsedImportRow[] = [];
  const invalidRows: InvalidImportRow[] = [];
  let totalDataRows = 0;

  for (let rowIndex = header.rowIndex + 1; rowIndex < records.length; rowIndex += 1) {
    const record = records[rowIndex] ?? [];
    const hasRequiredValue = requiredHeaders.some((headerName) => readCell(record, header.headerIndexes, headerName));

    if (!hasRequiredValue) {
      continue;
    }

    totalDataRows += 1;

    if (totalDataRows > maxImportDataRows) {
      throw new Error(importFileTooLargeMessage);
    }

    const parsedRow = parseDataRow(rowIndex + 1, ownerName, parseRawRow(record, header.headerIndexes));

    if ("reason" in parsedRow) {
      invalidRows.push(parsedRow);
    } else {
      rows.push(parsedRow);
    }
  }

  return { invalidRows, ownerName: ownerName || undefined, rows };
}
```

- [ ] **Step 4: Run parser tests and verify pass**

Run:

```powershell
npm run test:unit -- tests/unit/alipay-import.test.ts
```

Expected: PASS.

- [ ] **Step 5: Run existing payment parser regression tests**

Run:

```powershell
npm run test:unit -- tests/unit/wechat-pay-import.test.ts tests/unit/sui-shou-ji-import.test.ts
```

Expected: PASS.

- [ ] **Step 6: Commit**

```powershell
git add src/lib/imports/sources/alipay.ts tests/unit/alipay-import.test.ts
git commit -m "v0.20.0 解析支付宝官方 CSV" -m "新增支付宝 CSV 解析器，覆盖 GB18030、表头识别、行过滤、备注和来源指纹。"
```

## Task 3: Wire Alipay into Import Draft Services

**Files:**
- Modify: `src/lib/imports/drafts.ts`
- Modify: `tests/integration/import-drafts.test.ts`

- [ ] **Step 1: Write failing integration tests and helpers**

In `tests/integration/import-drafts.test.ts`, change the import:

```ts
import { ALIPAY_SOURCE, WECHAT_PAY_SOURCE } from "@/lib/imports/types";
```

Add the helper after `buildWechatPayWorkbook`:

```ts
function buildAlipayCsv(ownerName = "老公", orderId = "alipay-draft-order") {
  const headers = [
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
    "",
  ];
  const row = [
    "2026-05-07 12:17:13",
    "餐饮美食",
    "示例商户",
    "/",
    "示例商户",
    "支出",
    "22.85",
    "示例银行信用卡(0000)&红包",
    "交易成功",
    orderId,
    `${orderId}-merchant`,
    "/",
    "",
  ];

  return Buffer.from(
    [
      "导出信息：",
      `姓名：${ownerName}`,
      "------------------------支付宝支付科技有限公司  电子客户回单------------------------",
      headers.join(","),
      row.join(","),
    ].join("\n"),
    "utf8",
  );
}
```

Add these tests inside `describe("import draft services", ...)` near the existing WeChat Pay tests:

```ts
  it("creates an Alipay draft with owner inferred from the file header", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const draft = await services.createAlipayImportDraft({
      buffer: buildAlipayCsv("老公"),
      fileName: "alipay.csv",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.source).toBe(ALIPAY_SOURCE);
    expect(summary.counts.total).toBe(1);
    expect(summary.rows[0]).toMatchObject({
      actorFallbackApplied: false,
      actorMemberId: husbandMember.id,
      amountFen: 2285,
      createdByMemberId: husbandMember.id,
      creatorFallbackApplied: false,
      mappingKey: "alipay|EXPENSE|餐饮美食|示例商户",
      primaryCategory: "餐饮美食",
      secondaryCategory: "示例商户",
      status: ImportDraftRowStatus.NEEDS_MAPPING,
      transactionType: TransactionType.EXPENSE,
    });
  });

  it("updates payment draft owner member for Alipay rows before confirmation", async () => {
    const { sessionUser, wifeMember } = await createHouseholdFixture();
    const draft = await services.createAlipayImportDraft({
      buffer: buildAlipayCsv("老公"),
      fileName: "alipay-owner.csv",
      sessionUser,
    });

    await services.savePaymentImportDraftOwnerMember(draft.id, wifeMember.id, sessionUser);
    const summary = await services.getImportDraftSummary(draft.id, sessionUser);

    expect(summary.rows[0]).toMatchObject({
      actorFallbackApplied: false,
      actorMemberId: wifeMember.id,
      createdByMemberId: wifeMember.id,
      creatorFallbackApplied: false,
    });
  });

  it("confirms mapped Alipay rows into transactions with source metadata", async () => {
    const { husbandMember, sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const draft = await services.createAlipayImportDraft({
      buffer: buildAlipayCsv("老公", "alipay-confirm-order"),
      fileName: "alipay-confirm.csv",
      sessionUser,
    });

    await services.saveImportDraftMappings(
      draft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "alipay|EXPENSE|餐饮美食|示例商户",
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
          source: ALIPAY_SOURCE,
        },
      }),
    ).resolves.toMatchObject({
      actorMemberId: husbandMember.id,
      amountFen: 2285,
      categoryId: expenseCategory.id,
      createdByMemberId: husbandMember.id,
      source: ALIPAY_SOURCE,
      type: TransactionType.EXPENSE,
    });
  });

  it("reuses household Alipay category mappings on the next draft", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const firstDraft = await services.createAlipayImportDraft({
      buffer: buildAlipayCsv("老公", "alipay-reuse-first"),
      fileName: "alipay-first.csv",
      sessionUser,
    });

    await services.saveImportDraftMappings(
      firstDraft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "alipay|EXPENSE|餐饮美食|示例商户",
        },
      ],
      sessionUser,
    );

    const secondDraft = await services.createAlipayImportDraft({
      buffer: buildAlipayCsv("老公", "alipay-reuse-second"),
      fileName: "alipay-second.csv",
      sessionUser,
    });
    const summary = await services.getImportDraftSummary(secondDraft.id, sessionUser);

    expect(summary.counts.needsMapping).toBe(0);
    expect(summary.rows[0]).toMatchObject({
      categoryId: expenseCategory.id,
      status: ImportDraftRowStatus.READY,
    });
  });

  it("marks repeated Alipay source fingerprints as source duplicates", async () => {
    const { sessionUser } = await createHouseholdFixture();
    const { expenseCategory } = await getSeededCategories();
    const firstDraft = await services.createAlipayImportDraft({
      buffer: buildAlipayCsv("老公", "alipay-duplicate-order"),
      fileName: "alipay-first-duplicate.csv",
      sessionUser,
    });
    await services.saveImportDraftMappings(
      firstDraft.id,
      [
        {
          categoryId: expenseCategory.id,
          mappingKey: "alipay|EXPENSE|餐饮美食|示例商户",
        },
      ],
      sessionUser,
    );
    await services.confirmImportDraft(firstDraft.id, sessionUser);

    const secondDraft = await services.createAlipayImportDraft({
      buffer: buildAlipayCsv("老公", "alipay-duplicate-order"),
      fileName: "alipay-second-duplicate.csv",
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

- [ ] **Step 2: Run integration tests and verify failure**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; $env:AUTH_SECRET='replace-me'; npm run test:integration -- tests/integration/import-drafts.test.ts
```

Expected: FAIL because `createAlipayImportDraft` and `savePaymentImportDraftOwnerMember` are missing.

- [ ] **Step 3: Import Alipay parser and source**

In `src/lib/imports/drafts.ts`, add:

```ts
import { parseAlipayCsv } from "@/lib/imports/sources/alipay";
```

Update the imports from `types`:

```ts
  ALIPAY_SOURCE,
  SUI_SHOU_JI_SOURCE,
  WECHAT_PAY_SOURCE,
```

- [ ] **Step 4: Allow Alipay mapping keys**

In `parseMappingKey`, update the source guard:

```ts
  if (
    (source !== SUI_SHOU_JI_SOURCE && source !== WECHAT_PAY_SOURCE && source !== ALIPAY_SOURCE) ||
    (transactionType !== TransactionType.EXPENSE && transactionType !== TransactionType.INCOME) ||
    primaryCategory === undefined ||
    secondaryCategory === undefined
  ) {
    throw new Error("Invalid import mapping key");
  }
```

- [ ] **Step 5: Add Alipay draft creation**

Add after `createWechatPayImportDraft`:

```ts
export async function createAlipayImportDraft(input: {
  buffer: Buffer;
  fileName: string;
  sessionUser: SessionUser;
}) {
  return createImportDraft({
    ...input,
    parseWorkbook: parseAlipayCsv,
    source: ALIPAY_SOURCE,
  });
}
```

- [ ] **Step 6: Replace WeChat-only owner update with payment owner update**

Replace `saveWechatPayDraftOwnerMember` with:

```ts
const paymentImportSources = [WECHAT_PAY_SOURCE, ALIPAY_SOURCE] as const;

export async function savePaymentImportDraftOwnerMember(
  draftId: string,
  ownerMemberId: string,
  sessionUser: SessionUser,
) {
  await requireHouseholdMember(sessionUser);

  await db.$transaction(async (tx) => {
    const lockedDraftRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "ImportDraft"
      WHERE "id" = ${draftId}
        AND "household_id" = ${sessionUser.householdId}
        AND "source" IN (${Prisma.join(paymentImportSources)})
      FOR UPDATE
    `);

    if (lockedDraftRows.length === 0) {
      throw new Error("Import draft not found");
    }

    const [draft, ownerMember] = await Promise.all([
      tx.importDraft.findFirst({
        where: {
          householdId: sessionUser.householdId,
          id: draftId,
          source: { in: [...paymentImportSources] },
        },
        select: { id: true, status: true },
      }),
      tx.householdMember.findFirst({
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

    await tx.importDraftRow.updateMany({
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
  });
}

export async function saveWechatPayDraftOwnerMember(
  draftId: string,
  ownerMemberId: string,
  sessionUser: SessionUser,
) {
  return savePaymentImportDraftOwnerMember(draftId, ownerMemberId, sessionUser);
}
```

- [ ] **Step 7: Run focused integration tests and verify pass**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; $env:AUTH_SECRET='replace-me'; npm run test:integration -- tests/integration/import-drafts.test.ts
```

Expected: PASS.

- [ ] **Step 8: Commit**

```powershell
git add src/lib/imports/drafts.ts tests/integration/import-drafts.test.ts
git commit -m "v0.20.0 接入支付宝导入草稿" -m "支付宝复用草稿、成员归属、分类映射、确认写入和同源去重服务。"
```

## Task 4: Add Alipay Upload and Page UI

**Files:**
- Modify: `src/app/(app)/records/import/actions.ts`
- Modify: `src/app/(app)/records/import/page.tsx`
- Modify: `src/lib/i18n.ts`
- Modify: `tests/unit/i18n.test.ts`
- Modify: `tests/integration/import-page-and-actions.test.ts`

- [ ] **Step 1: Write failing i18n expectations**

In `tests/unit/i18n.test.ts`, update the import-related assertion to include:

```ts
    expect(zh.import.sources.alipay).toBe("支付宝");
    expect(en.import.sources.alipay).toBe("Alipay");
    expect(zh.import.errors["unrecognized-alipay-file"]).toBe("无法识别支付宝账单格式。");
    expect(en.import.errors["unrecognized-alipay-file"]).toBe(
      "Could not recognize the Alipay bill format.",
    );
    expect(zh.import.errors["unsupported-alipay-file"]).toBe("支付宝仅支持 .csv 文件。");
    expect(en.import.errors["unsupported-alipay-file"]).toBe("Alipay only supports .csv files.");
```

- [ ] **Step 2: Write failing action tests**

In `tests/integration/import-page-and-actions.test.ts`, extend hoisted mocks:

```ts
  createAlipayImportDraftMock: vi.fn(),
  savePaymentImportDraftOwnerMemberMock: vi.fn(),
```

Expose them from the mocked draft module:

```ts
  createAlipayImportDraft: createAlipayImportDraftMock,
  savePaymentImportDraftOwnerMember: savePaymentImportDraftOwnerMemberMock,
```

Reset them in the actions `beforeEach`:

```ts
    createAlipayImportDraftMock.mockReset();
    savePaymentImportDraftOwnerMemberMock.mockReset();
```

Add these action tests:

```ts
  it("uploads an Alipay .csv file when the selected source is Alipay", async () => {
    createAlipayImportDraftMock.mockResolvedValue({ id: "alipay-draft" });
    const formData = new FormData();
    formData.set("source", "alipay");
    formData.set("file", new File([new Uint8Array([1, 2, 3])], "alipay.csv"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=alipay-draft",
    );
    expect(createAlipayImportDraftMock).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      fileName: "alipay.csv",
      sessionUser,
    });
    expect(createSuiShouJiImportDraftMock).not.toHaveBeenCalled();
    expect(createWechatPayImportDraftMock).not.toHaveBeenCalled();
  });

  it("rejects Alipay uploads that are not .csv files", async () => {
    const formData = new FormData();
    formData.set("source", "alipay");
    formData.set("file", new File([new Uint8Array([1])], "alipay.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unsupported-alipay-file",
    );
    expect(createAlipayImportDraftMock).not.toHaveBeenCalled();
  });

  it("keeps .xlsx validation for Sui Shou Ji and WeChat Pay", async () => {
    const formData = new FormData();
    formData.set("source", "wechat_pay");
    formData.set("file", new File([new Uint8Array([1])], "wechat.csv"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unsupported-file",
    );
    expect(createWechatPayImportDraftMock).not.toHaveBeenCalled();
  });

  it("maps Alipay unrecognized CSV errors to the Alipay error redirect", async () => {
    createAlipayImportDraftMock.mockRejectedValue(new Error("无法识别支付宝账单格式"));
    const formData = new FormData();
    formData.set("source", "alipay");
    formData.set("file", new File([new Uint8Array([1])], "alipay.csv"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unrecognized-alipay-file",
    );
  });

  it("saves payment owner member selection and redirects back to the draft", async () => {
    const formData = new FormData();
    formData.set("draftId", "draft-1");
    formData.set("ownerMemberId", "member-2");

    const { savePaymentOwnerMember } = await import("@/app/(app)/records/import/actions");

    await expect(savePaymentOwnerMember(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );
    expect(savePaymentImportDraftOwnerMemberMock).toHaveBeenCalledWith(
      "draft-1",
      "member-2",
      sessionUser,
    );
  });
```

- [ ] **Step 3: Write failing page tests**

In `tests/integration/import-page-and-actions.test.ts`, update the upload form test assertions:

```ts
    expect(markup).toContain('required="" type="radio" name="source" value="alipay"');
    expect(markup).toContain("支付宝");
    expect(markup).toContain('accept=".xlsx,.csv"');
```

Add an Alipay owner selector render test:

```ts
  it("renders payment owner member selector for pending Alipay drafts", async () => {
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
            mappingKey: "alipay|EXPENSE|餐饮美食|示例商户",
            primaryCategory: "餐饮美食",
            secondaryCategory: "示例商户",
          },
        ],
        source: "alipay",
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
```

- [ ] **Step 4: Run focused tests and verify failure**

Run:

```powershell
npm run test:unit -- tests/unit/i18n.test.ts
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; $env:AUTH_SECRET='replace-me'; npm run test:integration -- tests/integration/import-page-and-actions.test.ts
```

Expected: FAIL because UI messages, action wiring, and page rendering are missing.

- [ ] **Step 5: Add i18n messages**

In `src/lib/i18n.ts`, update Chinese import copy:

```ts
      description: "选择来源并上传对应文件，补齐分类映射后确认入账。",
      uploadDescription: "随手记和微信支付使用 .xlsx，支付宝使用 .csv。",
      sources: {
        suiShouJi: "随手记",
        wechatPay: "微信支付",
        alipay: "支付宝",
      },
      ownerMemberDescription:
        "支付账单没有独立成员字段，这里选择的成员会用于这份草稿的所有可导入记录。",
```

Add Chinese error keys:

```ts
        "unrecognized-alipay-file": "无法识别支付宝账单格式。",
        "unsupported-alipay-file": "支付宝仅支持 .csv 文件。",
```

Update English import copy:

```ts
      description: "Choose a source, upload the matching file, map categories, then confirm the import.",
      uploadDescription: "Sui Shou Ji and WeChat Pay use .xlsx. Alipay uses .csv.",
      sources: {
        suiShouJi: "Sui Shou Ji",
        wechatPay: "WeChat Pay",
        alipay: "Alipay",
      },
      ownerMemberDescription:
        "Payment bills do not include separate member fields. This member is used for all importable rows in this draft.",
```

Add English error keys:

```ts
        "unrecognized-alipay-file": "Could not recognize the Alipay bill format.",
        "unsupported-alipay-file": "Alipay only supports .csv files.",
```

- [ ] **Step 6: Update upload action**

In `src/app/(app)/records/import/actions.ts`, import Alipay and generic member save:

```ts
  createAlipayImportDraft,
  savePaymentImportDraftOwnerMember,
```

and:

```ts
import { ALIPAY_SOURCE, SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE, type ImportSource } from "@/lib/imports/types";
```

Replace `isXlsxFile` with:

```ts
function isFileWithExtension(value: FormDataEntryValue | null, extension: string): value is File {
  return value instanceof File && value.name.toLowerCase().endsWith(extension);
}
```

Update `readImportSource`:

```ts
  if (source === SUI_SHOU_JI_SOURCE || source === WECHAT_PAY_SOURCE || source === ALIPAY_SOURCE) {
    return source;
  }
```

Replace the file type guard in `uploadImportDraft`:

```ts
  const file = formData.get("file");

  if (source === ALIPAY_SOURCE) {
    if (!isFileWithExtension(file, ".csv")) {
      redirect("/records/import?error=unsupported-alipay-file");
    }
  } else if (!isFileWithExtension(file, ".xlsx")) {
    redirect("/records/import?error=unsupported-file");
  }
```

Replace draft dispatch:

```ts
    const draft =
      source === ALIPAY_SOURCE
        ? await createAlipayImportDraft(input)
        : source === WECHAT_PAY_SOURCE
          ? await createWechatPayImportDraft(input)
          : await createSuiShouJiImportDraft(input);
```

Add Alipay error mapping:

```ts
    if (error instanceof Error && error.message === "无法识别支付宝账单格式") {
      redirect("/records/import?error=unrecognized-alipay-file");
    }
```

Add the generic payment owner action and keep the old WeChat action as a wrapper:

```ts
export async function savePaymentOwnerMember(formData: FormData) {
  const draftId = readDraftId(formData);
  const ownerMemberId = String(formData.get("ownerMemberId") ?? "").trim();

  if (!ownerMemberId) {
    redirectToDraft(draftId);
  }

  const sessionUser = await requireAppSession();

  await savePaymentImportDraftOwnerMember(draftId, ownerMemberId, sessionUser);

  redirectToDraft(draftId);
}

export async function saveWechatPayOwnerMember(formData: FormData) {
  return savePaymentOwnerMember(formData);
}
```

- [ ] **Step 7: Update import page**

In `src/app/(app)/records/import/page.tsx`, import Alipay and generic action:

```ts
import { ALIPAY_SOURCE, SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE } from "@/lib/imports/types";
```

and:

```ts
  savePaymentOwnerMember,
```

Update `sourceLabel`:

```ts
      alipay: string;
      suiShouJi: string;
      wechatPay: string;
```

and:

```ts
  if (source === ALIPAY_SOURCE) {
    return labels.sources.alipay;
  }
```

Replace `shouldShowWechatOwnerForm` with:

```ts
  const shouldShowPaymentOwnerForm =
    summary?.status === ImportDraftStatus.PENDING &&
    (summary.source === WECHAT_PAY_SOURCE || summary.source === ALIPAY_SOURCE);
```

Use `shouldShowPaymentOwnerForm` wherever members are loaded:

```ts
  const members = shouldShowPaymentOwnerForm
    ? await db.householdMember.findMany({
        where: { householdId: sessionUser.householdId },
        orderBy: { joinedAt: "asc" },
        select: { id: true, memberName: true },
      }) as MemberOption[]
    : [];
```

Replace `wechatOwnerMemberId` with:

```ts
  const paymentOwnerMemberId =
    shouldShowPaymentOwnerForm
      ? (summary.rows.find(
          (row) =>
            row.status !== ImportDraftRowStatus.INVALID &&
            row.status !== ImportDraftRowStatus.SOURCE_DUPLICATE &&
            row.actorMemberId,
        )?.actorMemberId ?? sessionUser.memberId)
      : null;
```

Update source grid and file input:

```tsx
            <div className="grid grid-cols-1 gap-2 sm:grid-cols-3">
              <label className="flex items-center justify-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-2 text-sm font-medium">
                <input name="source" required type="radio" value={SUI_SHOU_JI_SOURCE} />
                {messages.import.sources.suiShouJi}
              </label>
              <label className="flex items-center justify-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-2 text-sm font-medium">
                <input name="source" required type="radio" value={WECHAT_PAY_SOURCE} />
                {messages.import.sources.wechatPay}
              </label>
              <label className="flex items-center justify-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-2 text-sm font-medium">
                <input name="source" required type="radio" value={ALIPAY_SOURCE} />
                {messages.import.sources.alipay}
              </label>
            </div>
```

```tsx
              accept=".xlsx,.csv"
```

Replace the owner form condition and action:

```tsx
          {shouldShowPaymentOwnerForm && paymentOwnerMemberId ? (
            <form action={savePaymentOwnerMember} className="ios-panel space-y-4 p-5">
```

and:

```tsx
                  defaultValue={paymentOwnerMemberId}
```

- [ ] **Step 8: Run focused tests and verify pass**

Run:

```powershell
npm run test:unit -- tests/unit/i18n.test.ts
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; $env:AUTH_SECRET='replace-me'; npm run test:integration -- tests/integration/import-page-and-actions.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit**

```powershell
git add src/app/(app)/records/import/actions.ts src/app/(app)/records/import/page.tsx src/lib/i18n.ts tests/unit/i18n.test.ts tests/integration/import-page-and-actions.test.ts
git commit -m "v0.20.0 显示支付宝导入入口" -m "上传页支持支付宝 CSV，支付账单成员下拉复用微信路径并补齐双语错误文案。"
```

## Task 5: Add Alipay E2E Coverage

**Files:**
- Create: `tests/e2e/import-alipay.spec.ts`

- [ ] **Step 1: Create the E2E test**

Create `tests/e2e/import-alipay.spec.ts`:

```ts
import { writeFile } from "node:fs/promises";

import { expect, test, type Page, type TestInfo } from "@playwright/test";

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
  const value = (type: string) => parts.find((part) => part.type === type)?.value ?? "";

  return `${value("year")}-${value("month")}-${value("day")} ${value("hour")}:${value("minute")}:${value("second")}`;
}

async function createAlipayCsv(testInfo: TestInfo) {
  const orderId = `alipay-e2e-${Date.now()}`;
  const csv = [
    "------------------------------------------------------------------------------------",
    "导出信息：",
    "姓名：老公",
    "支付宝账户：example-alipay-account",
    "------------------------支付宝支付科技有限公司  电子客户回单------------------------",
    [...alipayHeaders, ""].join(","),
    [
      currentShanghaiDateTimeText(),
      "餐饮美食",
      "示例商户",
      "/",
      "示例商户",
      "支出",
      "22.85",
      "示例银行信用卡(0000)&红包",
      "交易成功",
      orderId,
      `${orderId}-merchant`,
      "/",
      "",
    ].join(","),
  ].join("\n");
  const csvPath = testInfo.outputPath("alipay-import.csv");

  await writeFile(csvPath, csv, "utf8");

  return csvPath;
}

test("users can import Alipay records from the records page", async ({ page }, testInfo) => {
  const csvPath = await createAlipayCsv(testInfo);

  await logIn(page);
  await page.goto("/records");
  await page.getByRole("link", { name: "导入" }).click();

  await page.getByLabel("支付宝").check();
  await page.getByLabel("文件").setInputFiles(csvPath);
  await page.getByRole("button", { name: "上传并解析" }).click();

  await expect(page).toHaveURL(/\/records\/import\?draft=/);
  const ownerForm = page.locator("form", {
    has: page.getByRole("heading", { name: "账单归属成员" }),
  });
  await expect(ownerForm).toBeVisible();
  const ownerMemberSelect = ownerForm.getByLabel("成员");
  await expect(ownerMemberSelect.locator("option:checked")).toHaveText("老公");

  const mappingForm = page.locator("form", {
    has: page.getByRole("heading", { name: "分类映射" }),
  });
  const alipayMapping = mappingForm.locator("label", { hasText: "支出 · 餐饮美食 / 示例商户" });
  await expect(alipayMapping).toBeVisible();
  await alipayMapping.getByRole("combobox").selectOption({ label: "餐饮" });
  await mappingForm.getByRole("button", { name: "保存映射" }).click();

  const confirmButton = page.getByRole("button", { name: "确认导入" });
  await expect(confirmButton).toBeEnabled();
  await confirmButton.click();

  await expect(page.getByRole("heading", { name: "导入已完成" })).toBeVisible();
  await page.getByRole("link", { name: "返回记录" }).last().click();

  await expect(page).toHaveURL((url) => url.pathname === "/records" && url.search === "");
  const importedRecord = page.getByRole("link", { name: /-22\.85.*餐饮.*老公/ });
  await expect(importedRecord).toBeVisible();
  await expect(importedRecord).toContainText("-22.85");
  await expect(importedRecord).toContainText("餐饮");
  await expect(importedRecord).toContainText("老公");
});
```

- [ ] **Step 2: Run the new E2E test and verify pass**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; $env:AUTH_SECRET='replace-me'; $env:SEED_USER_A_EMAIL='old-user-a@example.com'; $env:SEED_USER_A_PASSWORD='example-password'; npm run test:e2e -- tests/e2e/import-alipay.spec.ts
```

Expected after Tasks 1-4: PASS. If it fails on source label or mapping text, fix the page or parser so the UI shows `支付宝` and `支出 · 餐饮美食 / 示例商户`.

- [ ] **Step 3: Run existing import E2E regressions**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; $env:AUTH_SECRET='replace-me'; $env:SEED_USER_A_EMAIL='old-user-a@example.com'; $env:SEED_USER_A_PASSWORD='example-password'; npm run test:e2e -- tests/e2e/import-sui-shou-ji.spec.ts tests/e2e/import-wechat-pay.spec.ts
```

Expected: PASS for Sui Shou Ji and WeChat Pay import flows.

- [ ] **Step 4: Commit**

```powershell
git add tests/e2e/import-alipay.spec.ts
git commit -m "v0.20.0 验证支付宝导入流程" -m "端到端覆盖支付宝来源选择、CSV 上传、成员确认、分类映射和导入结果。"
```

## Task 6: Full Verification and Commit Hygiene

**Files:**
- Inspect: `package.json`
- Inspect: `package-lock.json`
- Inspect: all changed files

- [ ] **Step 1: Confirm project version**

Run:

```powershell
node -e "const p=require('./package.json'); const l=require('./package-lock.json'); if(p.version !== '0.20.0' || l.version !== '0.20.0' || l.packages[''].version !== '0.20.0') process.exit(1); console.log(p.version)"
```

Expected:

```text
0.20.0
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
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; $env:AUTH_SECRET='replace-me'; npm run test:unit
```

Expected: PASS.

- [ ] **Step 4: Run integration tests**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; $env:AUTH_SECRET='replace-me'; npm run test:integration
```

Expected: PASS.

- [ ] **Step 5: Run e2e tests**

Run:

```powershell
$env:DATABASE_URL='postgresql://billboard:billboard@127.0.0.1:15432/billboard_dev?schema=public'; $env:AUTH_SECRET='replace-me'; $env:SEED_USER_A_EMAIL='old-user-a@example.com'; $env:SEED_USER_A_PASSWORD='example-password'; $env:SEED_USER_B_EMAIL='old-user-b@example.com'; $env:SEED_USER_B_PASSWORD='example-password'; npm run test:e2e
```

Expected: PASS with the existing 10 E2E tests plus the new Alipay import test.

- [ ] **Step 6: Inspect git history against origin/master**

Run:

```powershell
git log --oneline origin/master..HEAD
git status --short
```

Expected:

```text
<implementation commits for v0.20.0>
<design-commit> v0.19.0 添加支付宝导入设计
```

and no unstaged code changes except intentionally uncommitted plan edits if execution keeps the plan outside the final commit.

- [ ] **Step 7: Squash implementation commits into one feature commit**

If Tasks 1-5 created multiple `v0.20.0` commits, squash only those implementation commits into one commit while preserving the existing `v0.19.0` design commit:

```powershell
$designCommit = Read-Host "Enter the verified v0.19.0 design commit from git log"
git reset --soft $designCommit
git commit -m "v0.20.0 支持支付宝账单导入" -m "新增支付宝官方 CSV 解析、来源上传、成员归属、分类映射复用、去重和端到端导入验证。"
```

Run after the squash:

```powershell
git log --oneline origin/master..HEAD
git status --short
```

Expected:

```text
<new-sha> v0.20.0 支持支付宝账单导入
<design-commit> v0.19.0 添加支付宝导入设计
```

and a clean worktree.

## Self-Review

- Spec coverage: Task 1 covers source identity and version; Task 2 covers GB18030/UTF-8 decoding fallback, header finding, CSV parsing, row filtering, amount/date parsing, mapping key, note, and fingerprint; Task 3 covers draft creation, member inference, member update, mapping reuse, confirmation, source metadata, same-source duplicate handling; Task 4 covers upload source selection, file type errors, Alipay format errors, generic payment owner UI, source labels, and i18n; Task 5 covers end-to-end import; Task 6 covers full verification and commit hygiene.
- Placeholder scan: No unresolved placeholder markers are present. Each code-changing step names exact files and includes concrete code snippets or complete file content.
- Type consistency: Source constant is `ALIPAY_SOURCE`; parser export is `parseAlipayCsv`; draft service export is `createAlipayImportDraft`; generic member service export is `savePaymentImportDraftOwnerMember`; page/action export is `savePaymentOwnerMember`; source string is `alipay`.
