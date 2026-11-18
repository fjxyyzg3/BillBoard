import {
  Uint8ArrayReader,
  ZipReader,
  Writer,
  type FileEntry,
} from "@zip.js/zip.js";

import { IMPORT_FILE_TOO_LARGE_MESSAGE, MAX_IMPORT_FILE_BYTES } from "../limits";
import type { ParsedImportWorkbook } from "../types";
import { XLSX_TIMEOUT } from "../xlsx";
import { parseCmbPdf } from "./cmb";

export const CMB_ZIP_PASSWORD_REQUIRED_MESSAGE = "招商银行 ZIP 账单需要输入解压密码";
export const CMB_ZIP_UNREADABLE_MESSAGE = "无法读取招商银行 ZIP 账单";

class BoundedUint8ArrayWriter extends Writer<Uint8Array<ArrayBuffer>> {
  private readonly chunks: Uint8Array[] = [];

  private written = 0;

  constructor(private readonly maxBytes: number) {
    super();
  }

  override async init(): Promise<void> {
    this.chunks.length = 0;
    this.written = 0;
    this.size = 0;
    super.init?.();
  }

  override async writeUint8Array(array: Uint8Array): Promise<void> {
    if (this.written + array.length > this.maxBytes) {
      throw new Error(IMPORT_FILE_TOO_LARGE_MESSAGE);
    }

    this.chunks.push(array.slice());
    this.written += array.length;
    this.size = this.written;
  }

  override async getData(): Promise<Uint8Array<ArrayBuffer>> {
    const output = new Uint8Array(this.written);
    let offset = 0;

    for (const chunk of this.chunks) {
      output.set(chunk, offset);
      offset += chunk.length;
    }

    return output;
  }
}

function isSinglePdfEntry(entry: FileEntry | { directory: true }) {
  return !entry.directory && entry.filename.toLowerCase().endsWith(".pdf");
}

export async function parseCmbZip(buffer: Buffer, password: string, signal?: AbortSignal): Promise<ParsedImportWorkbook> {
  if (signal?.aborted) throw new Error(XLSX_TIMEOUT);
  if (!password) {
    throw new Error(CMB_ZIP_PASSWORD_REQUIRED_MESSAGE);
  }
  if (buffer.length > MAX_IMPORT_FILE_BYTES) {
    throw new Error(IMPORT_FILE_TOO_LARGE_MESSAGE);
  }

  let reader: ZipReader<unknown> | undefined;
  let pdf: Buffer | undefined;

  try {
    reader = new ZipReader(new Uint8ArrayReader(new Uint8Array(buffer)), {
      checkOverlappingEntry: true,
      password,
      strictness: "strict",
      useWebWorkers: false,
    });
    const entries = await reader.getEntries();
    if (signal?.aborted) throw new Error(XLSX_TIMEOUT);
    if (entries.length !== 1 || !isSinglePdfEntry(entries[0]) || !entries[0].encrypted) {
      throw new Error(CMB_ZIP_UNREADABLE_MESSAGE);
    }

    const entry = entries[0] as FileEntry;
    if (
      !Number.isFinite(entry.uncompressedSize) ||
      entry.uncompressedSize < 0 ||
      entry.uncompressedSize > MAX_IMPORT_FILE_BYTES
    ) {
      throw new Error(IMPORT_FILE_TOO_LARGE_MESSAGE);
    }

    const writer = new BoundedUint8ArrayWriter(MAX_IMPORT_FILE_BYTES);
    pdf = Buffer.from(await entry.getData(writer, { signal }));
  } catch (error) {
    if (signal?.aborted) throw new Error(XLSX_TIMEOUT);
    if (error instanceof Error && error.message === IMPORT_FILE_TOO_LARGE_MESSAGE) {
      throw error;
    }
    throw new Error(CMB_ZIP_UNREADABLE_MESSAGE);
  } finally {
    await reader?.close().catch(() => undefined);
  }

  if (!pdf || !pdf.subarray(0, 5).equals(Buffer.from("%PDF-", "ascii"))) {
    throw new Error(CMB_ZIP_UNREADABLE_MESSAGE);
  }

  return parseCmbPdf(pdf, signal);
}
