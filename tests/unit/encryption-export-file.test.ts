import { mkdtemp, readFile, rm, rmdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { expect, it } from "vitest";
import { writeRecordExportWorkbook, type RecordExportRow } from "@/lib/exports/workbook";
it("writes XLSX bytes through authenticated encryption without a plaintext temporary workbook", async () => {
  const directory = await mkdtemp(path.join(tmpdir(), "billboard-encrypted-workbook-")), filename = path.join(directory, "records.xlsx");
  const key = randomBytes(32);
  try {
    const row: RecordExportRow = { ledgerName: "PRIVATE_EXPORT_LEDGER", ledgerArchived: false, actorMemberName: "A", actorMemberInactive: false, createdByMemberName: "A", createdByMemberInactive: false, type: "EXPENSE", categoryName: "Dining", amountFen: 12345, occurredAt: new Date(), note: "PRIVATE_EXPORT_NOTE", source: null };
    const result = await writeRecordExportWorkbook(filename, (async function* () { yield row; })(), "zh-CN", { encryptionKey: key } as Parameters<typeof writeRecordExportWorkbook>[3]);
    const stored = await readFile(filename);
    expect(stored.subarray(0, 6).toString()).toBe("BBEF1\n");
    expect(stored.includes(Buffer.from("PRIVATE_EXPORT_NOTE"))).toBe(false);
    const { decryptExportFile } = await import("@/lib/exports/encrypted-file");
    const plain = decryptExportFile(stored, key);
    expect(plain.subarray(0, 2).toString()).toBe("PK");
    expect(plain.length).toBe(result.byteLength);
    stored[stored.length - 1] ^= 1;
    expect(() => decryptExportFile(stored, key)).toThrow();
  } finally { key.fill(0); await rm(filename, { force: true }); await rmdir(directory); }
});
