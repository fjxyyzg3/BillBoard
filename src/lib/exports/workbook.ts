import * as fs from "node:fs/promises";
import { constants } from "node:fs";
import { Writable } from "node:stream";
import ExcelJS from "exceljs";
import { getCategoryDisplayName, getLedgerDisplayName, getMemberDisplayName, getMessages, type Locale } from "@/lib/i18n";
import { formatFen } from "@/lib/money";
import { RecordExportError } from "./input";
import { exportCipher } from "./encrypted-file";

export const MAX_RECORD_EXPORT_ROWS = 100_000;
export const MAX_RECORD_EXPORT_BYTES = 32 * 1024 * 1024;
const MAX_RECORD_EXPORT_TEXT_BYTES = 16 * 1024 * 1024;

export type RecordExportRow = {
  ledgerName: string;
  ledgerArchived: boolean;
  actorMemberName: string;
  actorMemberInactive: boolean;
  createdByMemberName: string;
  createdByMemberInactive: boolean;
  type: "INCOME" | "EXPENSE";
  categoryName: string;
  amountFen: number;
  occurredAt: Date;
  note: string | null;
  source: string | null;
};

function shanghaiTimestamp(date: Date) {
  if (!Number.isFinite(date.getTime())) throw new RecordExportError("unavailable");
  return new Date(date.getTime() + 8 * 60 * 60 * 1000).toISOString().replace("T", " ").replace(/Z$/, "");
}

function financialCells(row: RecordExportRow, locale: Locale): Array<string | number> {
  const messages = getMessages(locale);
  const labels = messages.safeguards.exports;
  if (!Number.isSafeInteger(row.amountFen) || row.amountFen <= 0 || row.amountFen > 2_147_483_647) {
    throw new RecordExportError("unavailable");
  }
  const knownSource = row.source && ["sui_shou_ji", "wechat_pay", "alipay", "cmb"].includes(row.source) ? row.source : undefined;
  return [
    `${getLedgerDisplayName(row.ledgerName, locale)}${row.ledgerArchived ? ` · ${messages.ledgers.archived}` : ""}`,
    getMemberDisplayName(row.actorMemberName, row.actorMemberInactive, locale),
    getMemberDisplayName(row.createdByMemberName, row.createdByMemberInactive, locale),
    row.type === "INCOME" ? labels.income : labels.expense,
    getCategoryDisplayName(row.categoryName, locale),
    formatFen(row.amountFen), row.amountFen, shanghaiTimestamp(row.occurredAt), row.note ?? "",
    knownSource ?? (row.source ? labels.imported : labels.manual),
  ];
}

export async function writeRecordExportWorkbook(
  filename: string,
  rows: AsyncIterable<RecordExportRow>,
  locale: Locale,
  options: { signal?: AbortSignal; encryptionKey?: Buffer } = {},
) {
  if (options.signal?.aborted) throw new RecordExportError("cancelled");
  const labels = getMessages(locale).safeguards.exports;
  const file = await fs.open(/* turbopackIgnore: true */ filename, constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | (constants.O_NOFOLLOW ?? 0), 0o600);
  const encrypted = options.encryptionKey ? exportCipher(options.encryptionKey) : null;
  if (encrypted) await file.writeFile(encrypted.header);
  let outputBytes = 0;
  let failure: Error | undefined;
  // Keep the ZIP writer settling even after a disk limit. Discarding further bounded
  // output avoids orphaned compression work or an ExcelJS error before commit listens.
  const output = new Writable({
    write(chunk: Buffer, _encoding, callback) {
      outputBytes += chunk.byteLength;
      if (outputBytes > MAX_RECORD_EXPORT_BYTES) failure ??= new RecordExportError("too_large");
      if (failure) { callback(); return; }
      file.writeFile(encrypted ? encrypted.cipher.update(chunk) : chunk).then(() => callback(), () => { failure ??= new RecordExportError("unavailable"); callback(); });
    },
    final(callback) {
      const finish = async () => {
        if (encrypted && !failure) await file.writeFile(Buffer.concat([encrypted.cipher.final(), encrypted.cipher.getAuthTag()]));
        await file.close();
      };
      finish().then(() => callback(), () => { failure ??= new RecordExportError("unavailable"); callback(); });
    },
  });
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({ stream: output, useSharedStrings: false, useStyles: true });
  workbook.creator = "BillBoard";
  workbook.lastModifiedBy = "BillBoard";
  const sheet = workbook.addWorksheet(labels.worksheet);
  const keys = ["ledger", "actor", "createdBy", "type", "category", "amountYuan", "amountFen", "occurredAt", "note", "source"] as const;
  sheet.columns = keys.map((key) => ({ header: labels.columns[key], width: key === "note" ? 48 : key === "occurredAt" ? 29 : 20 }));
  sheet.getColumn(6).numFmt = "@";
  sheet.getColumn(7).numFmt = "0";
  sheet.getRow(1).font = { bold: true };
  sheet.getRow(1).commit();
  let count = 0;
  let textBytes = 0;
  try {
    for await (const row of rows) {
      if (options.signal?.aborted) throw new RecordExportError("cancelled");
      if (++count > MAX_RECORD_EXPORT_ROWS) throw new RecordExportError("too_large");
      const cells = financialCells(row, locale);
      for (const value of cells) {
        if (typeof value !== "string") continue;
        if (value.length > 32_767) throw new RecordExportError("too_large");
        textBytes += Buffer.byteLength(value, "utf8");
      }
      if (textBytes > MAX_RECORD_EXPORT_TEXT_BYTES) throw new RecordExportError("too_large");
      if (failure) throw failure;
      // Plain strings remain XLSX strings, including leading =, +, -, @ and URLs.
      sheet.addRow(cells).commit();
      if (count % 500 === 0) await new Promise<void>((resolve) => setImmediate(resolve));
    }
  } catch (error) {
    failure ??= error instanceof Error ? error : new RecordExportError("unavailable");
  }
  try { await workbook.commit(); }
  catch { failure ??= new RecordExportError("unavailable"); }
  finally { await file.close().catch(() => undefined); }
  if (options.signal?.aborted) failure ??= new RecordExportError("cancelled");
  if (failure) throw failure;
  return { rowCount: count, byteLength: outputBytes };
}
