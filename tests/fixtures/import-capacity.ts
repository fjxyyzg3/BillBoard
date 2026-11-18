import { Uint8ArrayReader, Uint8ArrayWriter, ZipReader, ZipWriter } from "@zip.js/zip.js";
import { MAX_IMPORT_FILE_BYTES } from "../../src/lib/imports/limits";

export async function workbookAtUploadBoundary(original: Uint8Array): Promise<Buffer> {
  const reader = new ZipReader(new Uint8ArrayReader(original), { useWebWorkers: false });
  const writer = new ZipWriter(new Uint8ArrayWriter(), { level: 0, useWebWorkers: false });
  try {
    for (const entry of await reader.getEntries()) {
      if (!entry.directory) await writer.add(entry.filename, new Uint8ArrayReader(await entry.getData!(new Uint8ArrayWriter())));
    }
    // A stored, unused media entry exercises HTTP bytes without inflating business row counts.
    await writer.add("xl/media/upload-boundary.bin", new Uint8ArrayReader(new Uint8Array(MAX_IMPORT_FILE_BYTES - 64 * 1024)));
    const bytes = Buffer.from(await writer.close());
    if (bytes.length <= MAX_IMPORT_FILE_BYTES - 128 * 1024 || bytes.length > MAX_IMPORT_FILE_BYTES) throw new Error("Unexpected synthetic upload size");
    return bytes;
  } finally { await reader.close(); }
}
