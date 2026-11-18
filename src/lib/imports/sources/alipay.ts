import { TransactionType } from "@prisma/client";
import { setImmediate as yieldToEventLoop } from "node:timers/promises";

import { buildImportCategoryMappingKey, normalizeImportedCategory } from "../category-mapping";
import { createSourceFingerprint } from "../fingerprint";
import { IMPORT_FILE_TOO_LARGE_MESSAGE, MAX_IMPORT_FILE_BYTES } from "../limits";
import { XLSX_RESOURCE_LIMIT, XLSX_TIMEOUT } from "../xlsx";
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
const maxImportDataRows = 20_000;
const maxCsvRecords = 25_000;
const maxCsvCells = 500_000;
const maxCsvColumns = 128;
const invalidStatusPattern = /退款|关闭|失败/;

class ParseBudget {
  private readonly deadline = performance.now() + 30_000;
  private nextYield = performance.now();

  constructor(private readonly signal?: AbortSignal) {}

  check() {
    if (this.signal?.aborted || performance.now() >= this.deadline) throw new Error(XLSX_TIMEOUT);
  }

  shouldYield() {
    this.check();
    return performance.now() >= this.nextYield;
  }

  async yield() {
    await yieldToEventLoop();
    this.check();
    this.nextYield = performance.now() + 4;
  }
}

type HeaderName = (typeof requiredHeaders)[number];
type HeaderIndexes = Partial<Record<HeaderName, number>>;
type CsvRecord = {
  fields: string[];
  rowNumber: number;
};
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
type RawDataRow = {
  rawRow: RawRow;
  rowNumber: number;
};

async function decodeText(buffer: Buffer, encoding: string, budget: ParseBudget): Promise<string> {
  const decoder = new TextDecoder(encoding);
  const chunks: string[] = [];
  for (let offset = 0; offset < buffer.length; offset += 64 * 1024) {
    if (budget.shouldYield()) await budget.yield();
    chunks.push(decoder.decode(buffer.subarray(offset, offset + 64 * 1024), { stream: true }));
  }
  chunks.push(decoder.decode());
  return chunks.join("");
}

async function decodeCsv(buffer: Buffer, budget: ParseBudget): Promise<string> {
  const gb18030Text = await decodeText(buffer, "gb18030", budget);

  if (gb18030Text.includes("交易时间") && gb18030Text.includes("导出信息")) {
    return gb18030Text;
  }

  return decodeText(buffer, "utf-8", budget);
}

function cellText(value: string | undefined): string {
  const text = String(value ?? "").replace(/^\uFEFF/, "").trim();

  return text === "/" ? "" : text;
}

function isEmptyRecord(record: CsvRecord): boolean {
  return record.fields.every((field) => cellText(field) === "");
}

async function parseCsvRecords(text: string, budget: ParseBudget): Promise<CsvRecord[]> {
  const records: CsvRecord[] = [];
  let fields: string[] = [];
  let parts: string[] = [];
  let fieldChunks: string[] = [];
  let fieldStart = 0;
  let cellCount = 0;
  let recordCount = 0;
  let lineNumber = 1;
  let recordLineNumber = 1;
  let inQuotes = false;
  let nextCheckpoint = 0;

  const finishField = (end: number) => {
    parts.push(text.slice(fieldStart, end));
    if (fieldChunks.length > 0) {
      fieldChunks.push(parts.join(""));
      fields.push(fieldChunks.join(""));
      fieldChunks = [];
    } else fields.push(parts.length === 1 ? parts[0] : parts.join(""));
    parts = [];
    cellCount += 1;
    if (fields.length > maxCsvColumns || cellCount > maxCsvCells) throw new Error(XLSX_RESOURCE_LIMIT);
  };
  const finishRecord = () => {
    recordCount += 1;
    if (recordCount > maxCsvRecords) throw new Error(XLSX_RESOURCE_LIMIT);
    const record = { fields, rowNumber: recordLineNumber };
    if (!isEmptyRecord(record)) records.push(record);
    fields = [];
  };

  for (let index = 0; index < text.length; index += 1) {
    if (index >= nextCheckpoint) {
      // A single heavily escaped field must not accumulate millions of array
      // entries and then join them in one uninterrupted operation.
      if (parts.length >= 1024) {
        fieldChunks.push(parts.join(""));
        parts = [];
      }
      if (budget.shouldYield()) await budget.yield();
      nextCheckpoint = index + 2048;
    }
    const char = text[index];
    const nextChar = text[index + 1];

    if (char === "\"") {
      parts.push(text.slice(fieldStart, index));
      if (inQuotes && nextChar === "\"") {
        parts.push("\"");
        index += 1;
      } else {
        inQuotes = !inQuotes;
      }
      fieldStart = index + 1;
      continue;
    }

    if (char === "," && !inQuotes) {
      finishField(index);
      fieldStart = index + 1;
      continue;
    }

    if ((char === "\n" || char === "\r") && !inQuotes) {
      finishField(index);
      finishRecord();

      if (char === "\r" && nextChar === "\n") {
        index += 1;
      }
      fieldStart = index + 1;

      lineNumber += 1;
      recordLineNumber = lineNumber;
      continue;
    }

    if ((char === "\n" || char === "\r") && inQuotes) {
      if (char === "\r" && nextChar === "\n") {
        parts.push(text.slice(fieldStart, index), "\n");
        index += 1;
        fieldStart = index + 1;
      }
      lineNumber += 1;
      continue;
    }
  }

  if (fieldStart < text.length || parts.some((part) => part !== "") || fieldChunks.some((part) => part !== "") || fields.length > 0) {
    finishField(text.length);
    finishRecord();
  }

  return records;
}

function getHeaderIndexes(fields: string[]): HeaderIndexes | null {
  const indexes: HeaderIndexes = {};

  fields.forEach((header, index) => {
    const headerText = cellText(header) as HeaderName;
    indexes[headerText] = index;
  });

  return requiredHeaders.every((header) => indexes[header] !== undefined) ? indexes : null;
}

function readCell(fields: string[], indexes: HeaderIndexes, header: HeaderName): string {
  const index = indexes[header];

  return index === undefined ? "" : cellText(fields[index]);
}

async function parseOwnerName(records: CsvRecord[], budget: ParseBudget): Promise<string | undefined> {
  for (const record of records) {
    if (budget.shouldYield()) await budget.yield();
    const ownerField = record.fields.map(cellText).find((field) => field.startsWith("姓名："));
    const ownerName = ownerField?.replace(/^姓名：/, "").trim();

    if (ownerName) {
      return ownerName;
    }
  }

  return undefined;
}

async function findHeader(records: CsvRecord[], budget: ParseBudget): Promise<{ headerIndexes: HeaderIndexes; recordIndex: number } | null> {
  for (let recordIndex = 0; recordIndex < records.length; recordIndex += 1) {
    if (budget.shouldYield()) await budget.yield();
    const headerIndexes = getHeaderIndexes(records[recordIndex]?.fields ?? []);

    if (headerIndexes) {
      return { headerIndexes, recordIndex };
    }
  }

  return null;
}

function parseRawRow(fields: string[], indexes: HeaderIndexes): RawRow {
  return {
    rawAmount: readCell(fields, indexes, "金额"),
    rawCategory: readCell(fields, indexes, "交易分类"),
    rawCounterparty: readCell(fields, indexes, "交易对方"),
    rawCounterpartyAccount: readCell(fields, indexes, "对方账号"),
    rawMerchantOrderId: readCell(fields, indexes, "商家订单号"),
    rawNote: readCell(fields, indexes, "备注"),
    rawOccurredAt: readCell(fields, indexes, "交易时间"),
    rawOrderId: readCell(fields, indexes, "交易订单号"),
    rawPaymentMethod: readCell(fields, indexes, "收/付款方式"),
    rawProduct: readCell(fields, indexes, "商品说明"),
    rawStatus: readCell(fields, indexes, "交易状态"),
    rawTransactionType: readCell(fields, indexes, "收/支"),
  };
}

function isTransactionLikeRow(rawRow: RawRow): boolean {
  if (parseShanghaiDate(rawRow.rawOccurredAt)) {
    return true;
  }

  return [
    rawRow.rawTransactionType,
    rawRow.rawAmount,
    rawRow.rawOrderId,
    rawRow.rawMerchantOrderId,
  ].some((value) => value !== "");
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

function parseTransactionType(value: string): TransactionType | "NEUTRAL" | null {
  if (value === "支出") {
    return TransactionType.EXPENSE;
  }

  if (value === "收入") {
    return TransactionType.INCOME;
  }

  if (value === "不计收支") {
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

function buildAlipayNote(rawRow: RawRow): string | null {
  return (
    [
      rawRow.rawCounterparty ? `交易对方：${rawRow.rawCounterparty}` : "",
      rawRow.rawProduct ? `商品：${rawRow.rawProduct}` : "",
    ]
      .filter(Boolean)
      .join("；") || null
  );
}

function parseDataRow(
  rowNumber: number,
  ownerName: string,
  rawRow: RawRow,
): ParsedImportRow | InvalidImportRow {
  const transactionType = parseTransactionType(rawRow.rawTransactionType);

  if (transactionType === "NEUTRAL") {
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
      secondaryCategory: "",
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
      memberName: "",
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

function isStrictSuccessfulRefund(rawRow: RawRow) {
  return (
    rawRow.rawTransactionType === "不计收支" &&
    rawRow.rawCategory === "退款" &&
    rawRow.rawStatus === "退款成功"
  );
}

async function processRawDataRows(ownerName: string, rawDataRows: RawDataRow[], budget: ParseBudget): Promise<ParsedImportWorkbook> {
  const refundsByOrder = new Map<string, RawDataRow[]>();
  const paymentsByOrder = new Map<string, RawDataRow[]>();
  const replacements = new Map<RawDataRow, ParsedImportRow>();
  const invalidReasons = new Map<RawDataRow, string>();
  const consumedRefunds = new Set<RawDataRow>();

  // Index each row once. Scanning all payments for every distinct refund order
  // makes a valid 20,000-row file quadratic and blocks unrelated requests.
  for (const row of rawDataRows) {
    if (budget.shouldYield()) await budget.yield();
    const orderId = row.rawRow.rawMerchantOrderId;
    if (row.rawRow.rawTransactionType === "支出") {
      const payments = paymentsByOrder.get(orderId) ?? [];
      payments.push(row);
      paymentsByOrder.set(orderId, payments);
    }
    if (isStrictSuccessfulRefund(row.rawRow)) {
      consumedRefunds.add(row);
      if (!orderId) invalidReasons.set(row, "Alipay refund merchant order id is missing");
      else {
        const refunds = refundsByOrder.get(orderId) ?? [];
        refunds.push(row);
        refundsByOrder.set(orderId, refunds);
      }
    }
  }

  for (const [merchantOrderId, refunds] of refundsByOrder) {
    if (budget.shouldYield()) await budget.yield();
    const payments = paymentsByOrder.get(merchantOrderId) ?? [];

    if (payments.length === 0) {
      for (const refund of refunds) {
        if (budget.shouldYield()) await budget.yield();
        invalidReasons.set(refund, "Alipay refund payment was not found");
      }
      continue;
    }

    if (payments.length !== 1) {
      for (const row of [...payments, ...refunds]) {
        if (budget.shouldYield()) await budget.yield();
        invalidReasons.set(row, "Alipay refund payment is ambiguous");
      }
      continue;
    }

    const payment = payments[0];
    const parsedPayment = parseDataRow(payment.rowNumber, ownerName, payment.rawRow);
    let refundedAmountFen = 0;
    let hasInvalidRefund = false;
    for (const { rawRow } of refunds) {
      if (budget.shouldYield()) await budget.yield();
      const amountFen = parseAmountFen(rawRow.rawAmount);
      if (amountFen === null || !parseShanghaiDate(rawRow.rawOccurredAt)) hasInvalidRefund = true;
      refundedAmountFen += amountFen ?? 0;
    }

    if ("reason" in parsedPayment || hasInvalidRefund) {
      for (const row of [payment, ...refunds]) {
        if (budget.shouldYield()) await budget.yield();
        invalidReasons.set(row, "Alipay refund group contains invalid data");
      }
      continue;
    }

    const netAmountFen = parsedPayment.amountFen - refundedAmountFen;

    if (netAmountFen < 0) {
      for (const row of [payment, ...refunds]) {
        if (budget.shouldYield()) await budget.yield();
        invalidReasons.set(row, "Alipay refund exceeds payment amount");
      }
      continue;
    }

    replacements.set(payment, {
      ...parsedPayment,
      amountFen: netAmountFen === 0 ? parsedPayment.amountFen : netAmountFen,
      refundHandling: netAmountFen === 0 ? "ALIPAY_FULL" : "ALIPAY_PARTIAL",
    });
  }

  const rows: ParsedImportRow[] = [];
  const invalidRows: InvalidImportRow[] = [];

  for (const rawDataRow of rawDataRows) {
    if (budget.shouldYield()) await budget.yield();
    const invalidReason = invalidReasons.get(rawDataRow);

    if (invalidReason) {
      invalidRows.push(
        invalidRow(rawDataRow.rowNumber, ownerName, rawDataRow.rawRow, invalidReason),
      );
      continue;
    }

    const replacement = replacements.get(rawDataRow);

    if (replacement) {
      rows.push(replacement);
      continue;
    }

    if (consumedRefunds.has(rawDataRow)) {
      continue;
    }

    const parsedRow = parseDataRow(rawDataRow.rowNumber, ownerName, rawDataRow.rawRow);

    if ("reason" in parsedRow) {
      invalidRows.push(parsedRow);
    } else {
      rows.push(parsedRow);
    }
  }

  return { invalidRows, ownerName: ownerName || undefined, rows };
}

export async function parseAlipayCsv(buffer: Buffer, signal?: AbortSignal): Promise<ParsedImportWorkbook> {
  if (buffer.length > MAX_IMPORT_FILE_BYTES) throw new Error(IMPORT_FILE_TOO_LARGE_MESSAGE);
  const budget = new ParseBudget(signal);
  budget.check();
  const records = await parseCsvRecords(await decodeCsv(buffer, budget), budget);
  const header = await findHeader(records, budget);

  if (!header) {
    throw new Error(unrecognizedCsvMessage);
  }

  const ownerName = await parseOwnerName(records, budget) ?? "";
  const rawDataRows: RawDataRow[] = [];
  let totalDataRows = 0;

  for (let recordIndex = header.recordIndex + 1; recordIndex < records.length; recordIndex += 1) {
    if (budget.shouldYield()) await budget.yield();
    const record = records[recordIndex];

    if (!record) {
      continue;
    }

    const rawRow = parseRawRow(record.fields, header.headerIndexes);

    if (!isTransactionLikeRow(rawRow)) {
      continue;
    }

    totalDataRows += 1;

    if (totalDataRows > maxImportDataRows) {
      throw new Error(IMPORT_FILE_TOO_LARGE_MESSAGE);
    }

    rawDataRows.push({ rawRow, rowNumber: record.rowNumber });
  }

  const workbook = await processRawDataRows(ownerName, rawDataRows, budget);
  budget.check();
  return workbook;
}
