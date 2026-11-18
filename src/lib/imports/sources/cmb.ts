import path from "node:path";
import { pathToFileURL } from "node:url";

import { TransactionType } from "@prisma/client";

import { buildImportCategoryMappingKey, normalizeImportedCategory } from "../category-mapping";
import { createSourceFingerprint } from "../fingerprint";
import { IMPORT_FILE_TOO_LARGE_MESSAGE } from "../limits";
import { XLSX_TIMEOUT } from "../xlsx";
import {
  CMB_SOURCE,
  type InvalidImportRow,
  type ParsedImportRow,
  type ParsedImportWorkbook,
} from "../types";
import { applyCmbRefunds, type CmbInvalidPayment } from "./cmb-refunds";

const sheetName = "招商银行";
const unrecognizedPdfMessage = "无法识别招商银行流水格式";
const requiredHeaders = ["记账日期", "货币", "交易金额", "联机余额", "交易摘要", "对手信息"] as const;
const maxPdfPages = 500;
const maxImportDataRows = 20_000;
const lineYTolerance = 2;
const minimumTableY = 100;
const expectedHeaderX = [36, 100, 157, 235, 309, 418] as const;
const headerXTolerance = 5;
const englishHeaderLines = [
  ["Date", "Currency", "", "Balance", "Transaction Type", "Counter Party"],
  ["", "", "Amount", "", "", ""],
] as const;
const movementPattern = /转账|汇款|银证|证券|理财|基金|还款|存管|保证金|结汇|购汇/;

type PdfTextItem = {
  str: string;
  transform: number[];
  width: number;
};

type PositionedText = {
  text: string;
  width: number;
  x: number;
  y: number;
};

type TextLine = {
  items: PositionedText[];
  y: number;
};

type RawRow = {
  rawAmount: string;
  rawBalance: string;
  rawCounterparty: string;
  rawCurrency: string;
  rawDate: string;
  rawSummary: string;
  rowNumber: number;
};

function pdfAssetUrl(folder: "cmaps" | "standard_fonts") {
  return `${path.resolve(process.cwd(), "node_modules", "pdfjs-dist", folder).replaceAll("\\", "/")}/`;
}

function pdfWorkerUrl() {
  return pathToFileURL(
    path.resolve(process.cwd(), "node_modules", "pdfjs-dist", "legacy", "build", "pdf.worker.mjs"),
  ).href;
}

function normalizeText(value: string) {
  return value.replace(/\s+/g, " ").trim();
}

function compactText(value: string) {
  return value.replace(/\s+/g, "");
}

function normalizeCategoryPart(value: string) {
  return normalizeImportedCategory(value).replaceAll("|", "｜");
}

function groupTextLines(items: PositionedText[]) {
  const lines: TextLine[] = [];

  for (const item of [...items].sort((a, b) => b.y - a.y || a.x - b.x)) {
    const line = lines.find((candidate) => Math.abs(candidate.y - item.y) <= lineYTolerance);

    if (line) {
      line.items.push(item);
    } else {
      lines.push({ items: [item], y: item.y });
    }
  }

  return lines
    .map((line) => ({ ...line, items: line.items.sort((a, b) => a.x - b.x) }))
    .sort((a, b) => b.y - a.y);
}

function joinItems(items: PositionedText[]) {
  let result = "";
  let previousEnd: number | null = null;

  for (const item of items) {
    const text = item.text.trim();

    if (!text) {
      continue;
    }

    if (result && previousEnd !== null && item.x - previousEnd > 2) {
      result += " ";
    }

    result += text;
    previousEnd = item.x + item.width;
  }

  return normalizeText(result);
}

function parseOwnerAndAccount(lines: TextLine[]) {
  const text = lines.map((line) => joinItems(line.items)).join("\n");
  const ownerName = /户\s*名\s*[:：]\s*(.+?)(?=\s*账\s*号\s*[:：]|\n|$)/.exec(text)?.[1]?.trim();
  const account = /账\s*号\s*[:：]\s*([^\s\n]+)/.exec(text)?.[1]?.trim();

  return { account, ownerName };
}

function parseSignedAmountFen(value: string) {
  const normalized = value
    .replace(/[−–—]/g, "-")
    .replace(/[,+\s]/g, (character) => (character === "+" ? "+" : ""));
  const match = /^([+-]?)(\d+)(?:\.(\d{1,2}))?$/.exec(normalized);

  if (!match) {
    return null;
  }

  const [, signText, yuanText, fenText = ""] = match;
  const absoluteFen = Number(yuanText) * 100 + Number(fenText.padEnd(2, "0"));

  if (!Number.isSafeInteger(absoluteFen) || absoluteFen === 0) {
    return null;
  }

  return signText === "-" ? -absoluteFen : absoluteFen;
}

function isMoneyText(value: string) {
  const normalized = value
    .replace(/[−–—]/g, "-")
    .replace(/[,+\s]/g, (character) => (character === "+" ? "+" : ""));

  return /^[+-]?\d+(?:\.\d{1,2})?$/.test(normalized);
}

function parseShanghaiDate(value: string) {
  const match = /^(\d{4})-(\d{2})-(\d{2})$/.exec(value);

  if (!match) {
    return null;
  }

  const [, yearText, monthText, dayText] = match;
  const year = Number(yearText);
  const month = Number(monthText);
  const day = Number(dayText);
  const occurredAt = new Date(Date.UTC(year, month - 1, day, -8));
  const shanghaiTime = new Date(occurredAt.getTime() + 8 * 60 * 60 * 1000);

  if (
    shanghaiTime.getUTCFullYear() !== year ||
    shanghaiTime.getUTCMonth() !== month - 1 ||
    shanghaiTime.getUTCDate() !== day
  ) {
    return null;
  }

  return { occurredAt, occurredAtDate: value };
}

function appendCell(current: string, next: string) {
  return normalizeText([current, next].filter(Boolean).join(" "));
}

function isEnglishHeaderLine(values: string[]) {
  return englishHeaderLines.some((expected) =>
    expected.every((value, index) => values[index] === value),
  );
}

function extractRowsFromPage(items: PositionedText[], startRowNumber: number) {
  const headerItems = requiredHeaders.map((header) =>
    items.find((item) => compactText(item.text) === header),
  );

  if (headerItems.some((item) => !item)) {
    throw new Error(unrecognizedPdfMessage);
  }

  const headers = headerItems as PositionedText[];
  const headerY = headers[0].y;
  if (
    headers.some(
      (header, index) =>
        Math.abs(header.y - headerY) > lineYTolerance ||
        Math.abs(header.x - expectedHeaderX[index]) > headerXTolerance,
    )
  ) {
    throw new Error(unrecognizedPdfMessage);
  }

  const itemsBelowHeader = items.filter((item) => item.y < headerY - 20 && item.y > 35);
  if (
    itemsBelowHeader.some(
      (item) => item.y <= minimumTableY && /^\d{4}-\d{2}-\d{2}$/.test(normalizeText(item.text)),
    )
  ) {
    throw new Error(unrecognizedPdfMessage);
  }
  const lines = groupTextLines(itemsBelowHeader.filter((item) => item.y > minimumTableY));
  const tableLines = lines.map((line) => {
    const cells = requiredHeaders.map(() => [] as PositionedText[]);

    for (const item of line.items) {
      let column = 0;
      for (let index = 1; index < headers.length; index += 1) {
        if (item.x >= headers[index].x) {
          column = index;
        }
      }
      cells[column].push(item);
    }

    return { values: cells.map(joinItems), y: line.y };
  });
  const anchors: { row: RawRow; y: number }[] = [];

  for (const { values, y } of tableLines) {
    if (/^\d{4}-\d{2}-\d{2}$/.test(values[0])) {
      if (
        values.slice(0, 4).some((value) => value === "") ||
        !/^[A-Z]{3}$/.test(values[1]) ||
        !isMoneyText(values[3])
      ) {
        throw new Error(unrecognizedPdfMessage);
      }
      anchors.push({
        row: {
          rawAmount: values[2],
          rawBalance: values[3],
          rawCounterparty: "",
          rawCurrency: values[1],
          rawDate: values[0],
          rawSummary: "",
          rowNumber: startRowNumber + anchors.length,
        },
        y,
      });
    }
  }

  for (const { values, y } of tableLines) {
    if ((!anchors[0] || y > anchors[0].y) && isEnglishHeaderLine(values)) {
      continue;
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(values[0]) && values.slice(0, 4).some(Boolean)) {
      throw new Error(unrecognizedPdfMessage);
    }
    if (!values[4] && !values[5]) {
      continue;
    }

    // Wrapped cells can sit above or below their transaction's numeric baseline.
    let nearest: RawRow | undefined;
    let nearestDistance = Infinity;
    let nextDistance = Infinity;
    for (const anchor of anchors) {
      const distance = Math.abs(anchor.y - y);
      if (distance < nearestDistance) {
        nextDistance = nearestDistance;
        nearestDistance = distance;
        nearest = anchor.row;
      } else {
        nextDistance = Math.min(nextDistance, distance);
      }
    }
    if (!nearest || nextDistance - nearestDistance <= lineYTolerance) {
      throw new Error(unrecognizedPdfMessage);
    }
    nearest.rawSummary = appendCell(nearest.rawSummary, values[4]);
    nearest.rawCounterparty = appendCell(nearest.rawCounterparty, values[5]);
  }

  if (anchors.some(({ row }) => !row.rawSummary)) {
    throw new Error(unrecognizedPdfMessage);
  }
  return anchors.map(({ row }) => row);
}

function invalidRow(rawRow: RawRow, ownerName: string, reason: string): InvalidImportRow {
  return {
    rawAmount: rawRow.rawAmount,
    rawCreatedBy: ownerName,
    rawCurrency: rawRow.rawCurrency,
    rawDate: rawRow.rawDate,
    rawMember: ownerName,
    rawTransactionType: rawRow.rawAmount,
    reason,
    rowNumber: rawRow.rowNumber,
    sheetName,
  };
}

function parseRawRow(
  rawRow: RawRow,
  ownerName: string,
  account: string,
): ParsedImportRow | InvalidImportRow {
  if (rawRow.rawCurrency !== "CNY") {
    return invalidRow(rawRow, ownerName, "Unsupported currency");
  }

  const signedAmountFen = parseSignedAmountFen(rawRow.rawAmount);
  if (signedAmountFen === null) {
    return invalidRow(rawRow, ownerName, "Invalid amount");
  }

  const parsedDate = parseShanghaiDate(rawRow.rawDate);
  if (!parsedDate) {
    return invalidRow(rawRow, ownerName, "Invalid date");
  }

  const primaryCategory = normalizeCategoryPart(rawRow.rawSummary);
  const secondaryCategory = normalizeCategoryPart(rawRow.rawCounterparty);
  if (!primaryCategory) {
    return invalidRow(rawRow, ownerName, "Missing transaction summary");
  }

  const transactionType =
    signedAmountFen < 0 ? TransactionType.EXPENSE : TransactionType.INCOME;
  const noteParts = [`招商银行：${primaryCategory}`];
  if (secondaryCategory) {
    noteParts.push(`对手信息：${secondaryCategory}`);
  }
  const defaultSkipReason =
    movementPattern.test(primaryCategory) ||
    (secondaryCategory !== "" && secondaryCategory === normalizeCategoryPart(ownerName))
      ? "Suggested bank transfer-like transaction"
      : undefined;

  return {
    amountFen: Math.abs(signedAmountFen),
    defaultSkipReason,
    mappingKey: buildImportCategoryMappingKey({
      primaryCategory,
      secondaryCategory,
      source: CMB_SOURCE,
      transactionType,
    }),
    note: noteParts.join("；"),
    occurredAt: parsedDate.occurredAt,
    occurredAtDate: parsedDate.occurredAtDate,
    occurredAtText: rawRow.rawDate,
    primaryCategory,
    rawAmount: rawRow.rawAmount,
    rawCreatedBy: ownerName,
    rawCurrency: rawRow.rawCurrency,
    rawDate: rawRow.rawDate,
    rawMember: ownerName,
    rawTransactionType: signedAmountFen < 0 ? "支出" : "收入",
    rowNumber: rawRow.rowNumber,
    secondaryCategory,
    sheetName,
    sourceFingerprint: createSourceFingerprint({
      amountText: String(signedAmountFen),
      createdByName: "",
      memberName: ownerName,
      note: rawRow.rawSummary,
      occurredAtText: rawRow.rawDate,
      primaryCategory,
      rawAccount: account,
      rawCurrency: `${rawRow.rawCurrency}|${rawRow.rawBalance}`,
      rawMerchant: secondaryCategory,
      secondaryCategory,
      source: CMB_SOURCE,
      transactionType,
    }),
    transactionType,
  };
}

export async function parseCmbPdf(buffer: Buffer, signal?: AbortSignal): Promise<ParsedImportWorkbook> {
  let loadingTask: { destroy(): Promise<void>; promise: Promise<unknown> } | undefined;
  const assertNotCancelled = () => { if (signal?.aborted) throw new Error(XLSX_TIMEOUT); };
  const abort = () => { void loadingTask?.destroy().catch(() => undefined); };

  try {
    assertNotCancelled();
    const { getDocument, GlobalWorkerOptions } = await import(
      "pdfjs-dist/legacy/build/pdf.mjs"
    );
    GlobalWorkerOptions.workerSrc = pdfWorkerUrl();
    loadingTask = getDocument({
      cMapPacked: true,
      cMapUrl: pdfAssetUrl("cmaps"),
      data: new Uint8Array(buffer),
      standardFontDataUrl: pdfAssetUrl("standard_fonts"),
    });
    signal?.addEventListener("abort", abort, { once: true });
    if (signal?.aborted) { abort(); assertNotCancelled(); }
    const document = (await loadingTask.promise) as {
      getPage(pageNumber: number): Promise<{
        getTextContent(): Promise<{ items: Array<PdfTextItem | { type: string }> }>;
        getViewport(input: { scale: number }): { height: number; width: number };
      }>;
      numPages: number;
    };

    if (document.numPages < 1 || document.numPages > maxPdfPages) {
      throw new Error(IMPORT_FILE_TOO_LARGE_MESSAGE);
    }

    let ownerName = "";
    let account = "";
    const rawRows: RawRow[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      assertNotCancelled();
      const page = await document.getPage(pageNumber);
      const viewport = page.getViewport({ scale: 1 });
      if (viewport.width < 590 || viewport.width > 600 || viewport.height < 835 || viewport.height > 848) {
        throw new Error(unrecognizedPdfMessage);
      }

      const textContent = await page.getTextContent();
      assertNotCancelled();
      const items = textContent.items.flatMap((item) => {
        if (!("str" in item) || !item.str.trim()) {
          return [];
        }
        return [{ text: item.str, width: item.width, x: item.transform[4], y: item.transform[5] }];
      });
      if (
        pageNumber === 1 &&
        !items.some((item) => compactText(item.text) === "招商银行交易流水")
      ) {
        throw new Error(unrecognizedPdfMessage);
      }

      const pageIdentity = parseOwnerAndAccount(groupTextLines(items));
      if (
        (ownerName && pageIdentity.ownerName && ownerName !== pageIdentity.ownerName) ||
        (account && pageIdentity.account && account !== pageIdentity.account)
      ) {
        throw new Error(unrecognizedPdfMessage);
      }
      ownerName ||= pageIdentity.ownerName ?? "";
      account ||= pageIdentity.account ?? "";
      const pageRows = extractRowsFromPage(items, rawRows.length + 1);
      rawRows.push(...pageRows);
      if (rawRows.length > maxImportDataRows) {
        throw new Error(IMPORT_FILE_TOO_LARGE_MESSAGE);
      }
    }

    if (!ownerName || !account || rawRows.length === 0) {
      throw new Error(unrecognizedPdfMessage);
    }

    const rows: ParsedImportRow[] = [];
    const invalidRows: InvalidImportRow[] = [];
    const invalidPayments: CmbInvalidPayment[] = [];
    for (const rawRow of rawRows) {
      assertNotCancelled();
      const parsed = parseRawRow(rawRow, ownerName, account);
      if ("reason" in parsed) {
        invalidRows.push(parsed);
        const signedAmountFen = parseSignedAmountFen(rawRow.rawAmount);
        if (signedAmountFen === null || signedAmountFen < 0) {
          invalidPayments.push({
            occurredAtDate: parseShanghaiDate(rawRow.rawDate)?.occurredAtDate ?? null,
            primaryCategory: rawRow.rawSummary,
            rawCurrency: rawRow.rawCurrency,
            secondaryCategory: rawRow.rawCounterparty,
          });
        }
      } else {
        rows.push(parsed);
      }
    }

    return { invalidRows, ownerName, rows: applyCmbRefunds(rows, invalidPayments) };
  } catch (error) {
    assertNotCancelled();
    if (error instanceof Error && error.message === IMPORT_FILE_TOO_LARGE_MESSAGE) {
      throw error;
    }
    throw new Error(unrecognizedPdfMessage, { cause: error });
  } finally {
    signal?.removeEventListener("abort", abort);
    await loadingTask?.destroy().catch(() => undefined);
  }
}
