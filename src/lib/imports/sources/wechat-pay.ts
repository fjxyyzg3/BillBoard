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

function normalizeWechatNote(value: string): string {
  return value === "/" ? "" : value;
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
      createdByName: "",
      memberName: "",
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
