import { TransactionType } from "@prisma/client";
import { loadXlsxWorkbook, type XlsxRow, type XlsxSheet, type XlsxWorkbook } from "../xlsx";

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
type RawDataRow = {
  rawRow: RawRow;
  rowNumber: number;
  sheetName: string;
};

const partialRefundStatusPattern = /^已退款[（(][¥￥](\d+(?:\.\d{1,2})?)[)）]$/;
const refundIncomeStatusPattern = /^已退款[¥￥](\d+(?:\.\d{1,2})?)$/;
const fullRefundStatus = "已全额退款";
const refundIdentityVersion = "WECHAT_REFUND_ID_V1";

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

function getWorksheetRowValues(row: XlsxRow): unknown[] {
  return row.values;
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

function parseOwnerName(workbook: XlsxWorkbook): string | undefined {
  for (const sheet of workbook.worksheets) {
    for (const row of sheet.rows) {
      const rowValues = getWorksheetRowValues(row).map(cellText);
      const ownerCell = rowValues.find((value) => value.includes("微信昵称："));
      const match = ownerCell?.match(/微信昵称：\[([^\]]+)\]/);

      if (match?.[1]) {
        return match[1].trim();
      }
    }
  }

  return undefined;
}

function findHeader(sheet: XlsxSheet): { headerIndexes: HeaderIndexes; rowNumber: number } | null {
  for (const row of sheet.rows) {
    const headerIndexes = getHeaderIndexes(getWorksheetRowValues(row));

    if (headerIndexes) {
      return { headerIndexes, rowNumber: row.number };
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

function buildWechatPayNote(rawRow: RawRow): string | null {
  return (
    [
      rawRow.rawCounterparty ? `交易对方：${rawRow.rawCounterparty}` : "",
      rawRow.rawProduct ? `商品：${rawRow.rawProduct}` : "",
    ]
      .filter(Boolean)
      .join("；") || null
  );
}

function buildParsedRow(input: {
  amountFen: number;
  ownerName: string;
  rawRow: RawRow;
  refundHandling?: ParsedImportRow["refundHandling"];
  refundOriginalAmountFen?: number;
  rowNumber: number;
  sheetName: string;
  stableRefundIdentity?: boolean;
  transactionType: TransactionType;
}): ParsedImportRow | InvalidImportRow {
  const parsedDate = parseShanghaiDate(input.rawRow.rawOccurredAt);

  if (!parsedDate) {
    return invalidRow(
      input.sheetName,
      input.rowNumber,
      input.ownerName,
      input.rawRow,
      "Invalid date",
    );
  }

  const primaryCategory = normalizeImportedCategory(input.rawRow.rawTransactionKind);
  const secondaryCategory = normalizeImportedCategory(input.rawRow.rawCounterparty);

  return {
    amountFen: input.amountFen,
    mappingKey: buildImportCategoryMappingKey({
      primaryCategory,
      secondaryCategory,
      source: WECHAT_PAY_SOURCE,
      transactionType: input.transactionType,
    }),
    note: buildWechatPayNote(input.rawRow),
    occurredAt: parsedDate.occurredAt,
    occurredAtDate: parsedDate.occurredAtDate,
    occurredAtText: input.rawRow.rawOccurredAt,
    primaryCategory,
    rawAmount: input.rawRow.rawAmount,
    rawCreatedBy: input.ownerName,
    rawCurrency: "CNY",
    rawDate: input.rawRow.rawOccurredAt,
    rawMember: input.ownerName,
    rawTransactionType: input.rawRow.rawTransactionType,
    refundHandling: input.refundHandling,
    refundOriginalAmountFen: input.refundOriginalAmountFen,
    rowNumber: input.rowNumber,
    secondaryCategory,
    sheetName: input.sheetName,
    sourceFingerprint: createSourceFingerprint({
      amountText: input.rawRow.rawAmount,
      createdByName: "",
      memberName: "",
      note: input.rawRow.rawNote,
      occurredAtText: input.rawRow.rawOccurredAt,
      primaryCategory,
      rawAccount: input.rawRow.rawPaymentMethod,
      rawCurrency: input.stableRefundIdentity
        ? [refundIdentityVersion, input.rawRow.rawOrderId, input.rawRow.rawMerchantOrderId].join("|")
        : [
            input.rawRow.rawStatus,
            input.rawRow.rawOrderId,
            input.rawRow.rawMerchantOrderId,
          ].join("|"),
      rawMerchant: input.rawRow.rawProduct,
      secondaryCategory,
      source: WECHAT_PAY_SOURCE,
      transactionType: input.transactionType,
    }),
    transactionType: input.transactionType,
  };
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

  return buildParsedRow({
    amountFen,
    ownerName,
    rawRow,
    rowNumber,
    sheetName,
    transactionType,
  });
}

function partialRefundAmountFen(rawRow: RawRow): number | null | undefined {
  if (rawRow.rawTransactionType !== "支出") {
    return undefined;
  }

  const match = partialRefundStatusPattern.exec(rawRow.rawStatus);

  return match ? parseAmountFen(match[1] ?? "") : undefined;
}

function refundIncomeAmountFen(rawRow: RawRow): number | null | undefined {
  if (rawRow.rawTransactionType !== "收入" || !rawRow.rawTransactionKind.endsWith("-退款")) {
    return undefined;
  }

  const match = refundIncomeStatusPattern.exec(rawRow.rawStatus);

  return match ? parseAmountFen(match[1] ?? "") : undefined;
}

function processRawDataRows(ownerName: string, rawDataRows: RawDataRow[]): ParsedImportWorkbook {
  const replacements = new Map<RawDataRow, ParsedImportRow>();
  const invalidReasons = new Map<RawDataRow, string>();
  const consumedRows = new Set<RawDataRow>();
  const coveredRefundFenByCounterparty = new Map<string, number>();
  const refundIncomesByCounterparty = new Map<string, RawDataRow[]>();
  const refundIncomeAmounts = new Map<RawDataRow, number>();

  for (const rawDataRow of rawDataRows) {
    const { rawRow, rowNumber, sheetName } = rawDataRow;
    const originalAmountFen = parseAmountFen(rawRow.rawAmount);
    const partialAmountFen = partialRefundAmountFen(rawRow);
    const isFullRefund =
      rawRow.rawTransactionType === "支出" && rawRow.rawStatus === fullRefundStatus;

    if (partialAmountFen !== undefined || isFullRefund) {
      if (
        originalAmountFen === null ||
        (partialAmountFen !== undefined &&
          (partialAmountFen === null || partialAmountFen >= originalAmountFen))
      ) {
        invalidReasons.set(rawDataRow, "WeChat partial refund amount is invalid");
        continue;
      }

      const refundedAmountFen = isFullRefund ? originalAmountFen : partialAmountFen;

      if (refundedAmountFen === undefined || refundedAmountFen === null) {
        invalidReasons.set(rawDataRow, "WeChat partial refund amount is invalid");
        continue;
      }

      const parsed = buildParsedRow({
        amountFen: isFullRefund ? originalAmountFen : originalAmountFen - refundedAmountFen,
        ownerName,
        rawRow,
        refundHandling: isFullRefund ? "WECHAT_FULL" : "WECHAT_PARTIAL",
        refundOriginalAmountFen: originalAmountFen,
        rowNumber,
        sheetName,
        stableRefundIdentity: true,
        transactionType: TransactionType.EXPENSE,
      });

      if ("reason" in parsed) {
        invalidReasons.set(rawDataRow, parsed.reason);
        continue;
      }

      replacements.set(rawDataRow, parsed);

      if (rawRow.rawCounterparty) {
        coveredRefundFenByCounterparty.set(
          rawRow.rawCounterparty,
          (coveredRefundFenByCounterparty.get(rawRow.rawCounterparty) ?? 0) + refundedAmountFen,
        );
      }
    }
  }

  for (const rawDataRow of rawDataRows) {
    const refundAmountFen = refundIncomeAmountFen(rawDataRow.rawRow);

    if (refundAmountFen === undefined) {
      continue;
    }

    consumedRows.add(rawDataRow);
    const rowAmountFen = parseAmountFen(rawDataRow.rawRow.rawAmount);

    if (refundAmountFen === null || rowAmountFen !== refundAmountFen) {
      invalidReasons.set(rawDataRow, "WeChat refund status amount does not match row amount");
      continue;
    }

    if (!parseShanghaiDate(rawDataRow.rawRow.rawOccurredAt)) {
      invalidReasons.set(rawDataRow, "Invalid date");
      continue;
    }

    refundIncomeAmounts.set(rawDataRow, refundAmountFen);

    if (!rawDataRow.rawRow.rawCounterparty) {
      const parsed = buildParsedRow({
        amountFen: refundAmountFen,
        ownerName,
        rawRow: rawDataRow.rawRow,
        refundHandling: "WECHAT_MANUAL",
        rowNumber: rawDataRow.rowNumber,
        sheetName: rawDataRow.sheetName,
        transactionType: TransactionType.INCOME,
      });

      if ("reason" in parsed) {
        invalidReasons.set(rawDataRow, parsed.reason);
      } else {
        replacements.set(rawDataRow, parsed);
      }
      continue;
    }

    const group = refundIncomesByCounterparty.get(rawDataRow.rawRow.rawCounterparty) ?? [];

    group.push(rawDataRow);
    refundIncomesByCounterparty.set(rawDataRow.rawRow.rawCounterparty, group);
  }

  for (const [counterparty, refundRows] of refundIncomesByCounterparty) {
    const refundIncomeFen = refundRows.reduce(
      (sum, row) => sum + (refundIncomeAmounts.get(row) ?? 0),
      0,
    );
    const uncoveredAmountFen = Math.max(
      refundIncomeFen - (coveredRefundFenByCounterparty.get(counterparty) ?? 0),
      0,
    );

    if (uncoveredAmountFen === 0) {
      continue;
    }

    const firstRefund = refundRows[0];

    if (!firstRefund) {
      continue;
    }

    const parsed = buildParsedRow({
      amountFen: uncoveredAmountFen,
      ownerName,
      rawRow: firstRefund.rawRow,
      refundHandling: "WECHAT_MANUAL",
      rowNumber: firstRefund.rowNumber,
      sheetName: firstRefund.sheetName,
      transactionType: TransactionType.INCOME,
    });

    if ("reason" in parsed) {
      invalidReasons.set(firstRefund, parsed.reason);
    } else {
      replacements.set(firstRefund, parsed);
    }
  }

  const rows: ParsedImportRow[] = [];
  const invalidRows: InvalidImportRow[] = [];

  for (const rawDataRow of rawDataRows) {
    const invalidReason = invalidReasons.get(rawDataRow);

    if (invalidReason) {
      invalidRows.push(
        invalidRow(
          rawDataRow.sheetName,
          rawDataRow.rowNumber,
          ownerName,
          rawDataRow.rawRow,
          invalidReason,
        ),
      );
      continue;
    }

    const replacement = replacements.get(rawDataRow);

    if (replacement) {
      rows.push(replacement);
      continue;
    }

    if (consumedRows.has(rawDataRow)) {
      continue;
    }

    const parsed = parseDataRow(
      rawDataRow.sheetName,
      rawDataRow.rowNumber,
      ownerName,
      rawDataRow.rawRow,
    );

    if ("reason" in parsed) {
      invalidRows.push(parsed);
    } else {
      rows.push(parsed);
    }
  }

  return { invalidRows, ownerName: ownerName || undefined, rows };
}

export async function parseWechatPayWorkbook(buffer: Buffer, signal?: AbortSignal): Promise<ParsedImportWorkbook> {
  const workbook = await loadXlsxWorkbook(buffer, signal);

  const ownerName = parseOwnerName(workbook) ?? "";
  const rawDataRows: RawDataRow[] = [];
  let totalDataRows = 0;
  let foundHeader = false;

  for (const sheet of workbook.worksheets) {
    const header = findHeader(sheet);

    if (!header) {
      continue;
    }

    foundHeader = true;

    for (const sheetRow of sheet.rows) {
      const rowNumber = sheetRow.number;
      if (rowNumber <= header.rowNumber) {
        continue;
      }

      totalDataRows += 1;

      if (totalDataRows > maxImportDataRows) {
        throw new Error(importFileTooLargeMessage);
      }

      const rawRow = parseRawRow(getWorksheetRowValues(sheetRow), header.headerIndexes);
      rawDataRows.push({ rawRow, rowNumber, sheetName: sheet.name });
    }
  }

  if (!foundHeader) {
    throw new Error(unrecognizedWorkbookMessage);
  }

  return processRawDataRows(ownerName, rawDataRows);
}
