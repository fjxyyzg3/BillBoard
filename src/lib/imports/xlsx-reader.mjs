import ExcelJS from "exceljs";
import { Uint8ArrayReader, Uint8ArrayWriter, Writer, ZipReader, ZipWriter } from "@zip.js/zip.js";

// This process receives only the uploaded bytes, never application credentials.
const maxInputBytes = 20 * 1024 * 1024;
const maxEntryBytes = 32 * 1024 * 1024;
const maxExpandedBytes = 64 * 1024 * 1024;
const maxResultBytes = 32 * 1024 * 1024;
const resourceLimit = "xlsx-resource-limit";

async function boundArchive(buffer) {
  const reader = new ZipReader(new Uint8ArrayReader(buffer), {
    checkOverlappingEntry: true,
    strictness: "strict",
    useWebWorkers: false,
  });
  const normalized = new ZipWriter(new Uint8ArrayWriter(), { level: 0, useWebWorkers: false });
  const names = new Set();
  let declaredTotal = 0;
  let expandedTotal = 0;

  class BoundedEntryWriter extends Writer {
    written = 0;
    chunks = [];

    async writeUint8Array(chunk) {
      this.written += chunk.length;
      expandedTotal += chunk.length;
      if (this.written > maxEntryBytes || expandedTotal > maxExpandedBytes) {
        throw new Error(resourceLimit);
      }
      this.chunks.push(chunk);
    }

    async getData() {
      return Buffer.concat(this.chunks, this.written);
    }
  }

  try {
    for await (const entry of reader.getEntriesGenerator()) {
      if (names.size >= 2048) throw new Error(resourceLimit);
      if (Buffer.byteLength(entry.filename) > 1024) throw new Error(resourceLimit);
      if (names.has(entry.filename) || entry.encrypted) throw new Error("unreadable-xlsx-file");
      names.add(entry.filename);
      declaredTotal += entry.uncompressedSize;
      if (!Number.isSafeInteger(entry.uncompressedSize) || entry.uncompressedSize < 0 ||
          entry.uncompressedSize > maxEntryBytes || declaredTotal > maxExpandedBytes) {
        throw new Error(resourceLimit);
      }
      if (entry.directory) {
        if (!entry.filename.endsWith("/") || entry.uncompressedSize !== 0 || entry.compressedSize !== 0) {
          throw new Error("unreadable-xlsx-file");
        }
        continue;
      }
      // Count actual inflated chunks too: ZIP metadata alone is not a boundary.
      const data = await entry.getData(new BoundedEntryWriter(), { checkSignature: true });
      await normalized.add(entry.filename, new Uint8ArrayReader(data));
    }
    // ExcelJS uses a different ZIP decoder. Give it only the bytes checked above,
    // with fresh directory metadata, so decoder differences cannot bypass limits.
    return Buffer.from(await normalized.close());
  } finally {
    await reader.close();
  }
}

function scalarValue(value) {
  if (value instanceof Date) return { date: value.toISOString() };
  if (value && typeof value === "object") {
    if ("text" in value) return String(value.text ?? "");
    if ("richText" in value) return value.richText.map((part) => part.text ?? "").join("");
    if ("result" in value) return scalarValue(value.result);
    return String(value);
  }
  return value ?? null;
}

async function readWorkbook(buffer) {
  const normalized = await boundArchive(buffer);
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(normalized);
  if (workbook.worksheets.length > 16) throw new Error(resourceLimit);
  let rowCount = 0;
  let cellCount = 0;
  let resultBytes = 0;
  const worksheets = workbook.worksheets.map((sheet) => {
    if (sheet.rowCount > 25_000) throw new Error(resourceLimit);
    const rows = [];
    sheet.eachRow((row) => {
      rowCount += 1;
      cellCount += row.cellCount;
      if (rowCount > 25_000 || row.cellCount > 128 || cellCount > 500_000) {
        throw new Error(resourceLimit);
      }
      const values = [];
      const texts = [];
      for (let column = 1; column <= row.cellCount; column += 1) {
        const cell = row.getCell(column);
        values.push(scalarValue(cell.value));
        // ExcelJS cannot stringify merged cells whose master is empty.
        texts.push(cell.value == null ? "" : cell.text);
      }
      const result = { number: row.number, values, texts };
      resultBytes += Buffer.byteLength(JSON.stringify(result));
      if (resultBytes > maxResultBytes) throw new Error(resourceLimit);
      rows.push(result);
    });
    return { name: sheet.name, rows };
  });
  const result = JSON.stringify({ worksheets });
  if (Buffer.byteLength(result) > maxResultBytes) throw new Error(resourceLimit);
  return result;
}

try {
  const chunks = [];
  let size = 0;
  for await (const chunk of process.stdin) {
    size += chunk.length;
    if (size > maxInputBytes) throw new Error(resourceLimit);
    chunks.push(chunk);
  }
  process.stdout.write(await readWorkbook(Buffer.concat(chunks)));
} catch (error) {
  // Do not send parser internals, uploaded values, or stack traces to the parent.
  process.stdout.write(JSON.stringify({
    error: error instanceof Error && error.message === resourceLimit ? resourceLimit : "unreadable-xlsx-file",
  }));
}
