import { TransactionType } from "@prisma/client";
import ExcelJS from "exceljs";

import { buildImportCategoryMappingKey, normalizeImportedCategory } from "../category-mapping";
import { createSourceFingerprint } from "../fingerprint";
import {
  type InvalidImportRow,
  type ParsedImportRow,
  type ParsedImportWorkbook,
  SUI_SHOU_JI_SOURCE,
} from "../types";

const readableSheetNames = ["支出", "收入"] as const;
const requiredHeaders = [
  "交易类型",
  "日期",
  "一级分类",
  "二级分类",
  "账户币种",
  "金额",
  "成员",
  "记账人",
  "备注",
] as const;

const unrecognizedWorkbookMessage = "无法识别随手记导出格式";
const importFileTooLargeMessage = "Import file is too large";
const maxImportDataRows = 20_000;

type HeaderName = (typeof requiredHeaders)[number] | "账户1" | "商家";
type HeaderIndexes = Partial<Record<HeaderName, number>>;
type RawRow = {
  rawAccount: string;
  rawAmount: string;
  rawCreatedBy: string;
  rawCurrency: string;
  rawDate: string;
  rawMember: string;
  rawMerchant: string;
  rawNote: string;
  rawPrimaryCategory: string;
  rawSecondaryCategory: string;
  rawTransactionType: string;
};

function cellText(value: unknown): string {
  return String(value ?? "").trim();
}

function getHeaderIndexes(headerRow: unknown[]): HeaderIndexes {
  const indexes: HeaderIndexes = {};

  headerRow.forEach((header, index) => {
    const headerText = cellText(header) as HeaderName;
    indexes[headerText] = index;
  });

  for (const header of requiredHeaders) {
    if (indexes[header] === undefined) {
      throw new Error(unrecognizedWorkbookMessage);
    }
  }

  return indexes;
}

function readCell(row: unknown[], indexes: HeaderIndexes, header: HeaderName): string {
  const index = indexes[header];

  return index === undefined ? "" : cellText(row[index]);
}

function parseRawRow(row: unknown[], indexes: HeaderIndexes): RawRow {
  return {
    rawAccount: readCell(row, indexes, "账户1"),
    rawAmount: readCell(row, indexes, "金额"),
    rawCreatedBy: readCell(row, indexes, "记账人"),
    rawCurrency: readCell(row, indexes, "账户币种"),
    rawDate: readCell(row, indexes, "日期"),
    rawMember: readCell(row, indexes, "成员"),
    rawMerchant: readCell(row, indexes, "商家"),
    rawNote: readCell(row, indexes, "备注"),
    rawPrimaryCategory: readCell(row, indexes, "一级分类"),
    rawSecondaryCategory: readCell(row, indexes, "二级分类"),
    rawTransactionType: readCell(row, indexes, "交易类型"),
  };
}

function invalidRow(
  sheetName: string,
  rowNumber: number,
  rawRow: RawRow,
  reason: string,
): InvalidImportRow {
  return {
    rawAmount: rawRow.rawAmount,
    rawCreatedBy: rawRow.rawCreatedBy,
    rawCurrency: rawRow.rawCurrency,
    rawDate: rawRow.rawDate,
    rawMember: rawRow.rawMember,
    rawTransactionType: rawRow.rawTransactionType,
    reason,
    rowNumber,
    sheetName,
  };
}

function parseTransactionType(value: string): TransactionType | null {
  if (value === "支出") {
    return TransactionType.EXPENSE;
  }

  if (value === "收入") {
    return TransactionType.INCOME;
  }

  return null;
}

function parseAmountFen(value: string): number | null {
  if (!/^\d+(?:\.\d{1,2})?$/.test(value)) {
    return null;
  }

  const [yuanText, fenText = ""] = value.split(".");
  const yuan = Number(yuanText);
  const fen = Number(fenText.padEnd(2, "0"));
  const amountFen = yuan * 100 + fen;

  return amountFen > 0 ? amountFen : null;
}

function parseShanghaiDate(value: string): { occurredAt: Date; occurredAtDate: string } | null {
  const match = /^(\d{4})-(\d{2})-(\d{2}) (\d{2}):(\d{2}):(\d{2})$/.exec(value);

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

function buildImportNote(rawRow: RawRow, primaryCategory: string, secondaryCategory: string): string {
  const sourceParts = [`随手记：${primaryCategory} / ${secondaryCategory}`];

  if (rawRow.rawMember) {
    sourceParts.push(`成员：${rawRow.rawMember}`);
  }

  if (rawRow.rawCreatedBy) {
    sourceParts.push(`记账人：${rawRow.rawCreatedBy}`);
  }

  if (rawRow.rawAccount) {
    sourceParts.push(`账户：${rawRow.rawAccount}`);
  }

  if (rawRow.rawMerchant) {
    sourceParts.push(`商家：${rawRow.rawMerchant}`);
  }

  const sourceNote = sourceParts.join("；");

  return rawRow.rawNote ? `${rawRow.rawNote}\n${sourceNote}` : sourceNote;
}

function parseDataRow(sheetName: string, rowNumber: number, rawRow: RawRow): ParsedImportRow | InvalidImportRow {
  const transactionType = parseTransactionType(rawRow.rawTransactionType);

  if (!transactionType) {
    return invalidRow(sheetName, rowNumber, rawRow, "Unsupported transaction type");
  }

  if (rawRow.rawCurrency !== "CNY") {
    return invalidRow(sheetName, rowNumber, rawRow, "Unsupported currency");
  }

  const amountFen = parseAmountFen(rawRow.rawAmount);

  if (amountFen === null) {
    return invalidRow(sheetName, rowNumber, rawRow, "Invalid amount");
  }

  const parsedDate = parseShanghaiDate(rawRow.rawDate);

  if (!parsedDate) {
    return invalidRow(sheetName, rowNumber, rawRow, "Invalid date");
  }

  const primaryCategory = normalizeImportedCategory(rawRow.rawPrimaryCategory);
  const secondaryCategory = normalizeImportedCategory(rawRow.rawSecondaryCategory);

  return {
    amountFen,
    mappingKey: buildImportCategoryMappingKey({
      source: SUI_SHOU_JI_SOURCE,
      transactionType,
      primaryCategory,
      secondaryCategory,
    }),
    note: buildImportNote(rawRow, primaryCategory, secondaryCategory),
    occurredAt: parsedDate.occurredAt,
    occurredAtDate: parsedDate.occurredAtDate,
    occurredAtText: rawRow.rawDate,
    primaryCategory,
    rawAmount: rawRow.rawAmount,
    rawCreatedBy: rawRow.rawCreatedBy,
    rawCurrency: rawRow.rawCurrency,
    rawDate: rawRow.rawDate,
    rawMember: rawRow.rawMember,
    rawTransactionType: rawRow.rawTransactionType,
    rowNumber,
    secondaryCategory,
    sheetName,
    sourceFingerprint: createSourceFingerprint({
      amountText: rawRow.rawAmount,
      createdByName: rawRow.rawCreatedBy,
      memberName: rawRow.rawMember,
      note: rawRow.rawNote,
      occurredAtText: rawRow.rawDate,
      primaryCategory,
      rawAccount: rawRow.rawAccount,
      rawCurrency: rawRow.rawCurrency,
      rawMerchant: rawRow.rawMerchant,
      secondaryCategory,
      source: SUI_SHOU_JI_SOURCE,
      transactionType,
    }),
    transactionType,
  };
}

function getWorksheetRowValues(row: ExcelJS.Row): unknown[] {
  const values = [];

  for (let cellIndex = 1; cellIndex <= row.cellCount; cellIndex += 1) {
    values.push(row.getCell(cellIndex).text);
  }

  return values;
}

export async function parseSuiShouJiWorkbook(buffer: Buffer): Promise<ParsedImportWorkbook> {
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(buffer);

  const rows: ParsedImportRow[] = [];
  const invalidRows: InvalidImportRow[] = [];
  const hasReadableSheet = readableSheetNames.some((sheetName) => workbook.getWorksheet(sheetName));
  let totalDataRows = 0;

  if (!hasReadableSheet) {
    throw new Error(unrecognizedWorkbookMessage);
  }

  for (const sheetName of readableSheetNames) {
    const sheet = workbook.getWorksheet(sheetName);

    if (!sheet) {
      continue;
    }

    const headerRow = getWorksheetRowValues(sheet.getRow(1));

    if (headerRow.length === 0) {
      throw new Error(unrecognizedWorkbookMessage);
    }

    const headerIndexes = getHeaderIndexes(headerRow);

    for (let rowNumber = 2; rowNumber <= sheet.rowCount; rowNumber += 1) {
      const sheetRow = sheet.getRow(rowNumber);

      if (!sheetRow.hasValues) {
        continue;
      }

      totalDataRows += 1;

      if (totalDataRows > maxImportDataRows) {
        throw new Error(importFileTooLargeMessage);
      }

      const rawRow = parseRawRow(getWorksheetRowValues(sheetRow), headerIndexes);
      const parsedRow = parseDataRow(sheetName, rowNumber, rawRow);

      if ("reason" in parsedRow) {
        invalidRows.push(parsedRow);
      } else {
        rows.push(parsedRow);
      }
    }
  }

  return { invalidRows, rows };
}
