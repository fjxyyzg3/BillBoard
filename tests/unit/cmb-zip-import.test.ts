import { Uint8ArrayReader, Uint8ArrayWriter, ZipWriter } from "@zip.js/zip.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { parseCmbPdf } from "@/lib/imports/sources/cmb";
import {
  CMB_ZIP_PASSWORD_REQUIRED_MESSAGE,
  CMB_ZIP_UNREADABLE_MESSAGE,
  parseCmbZip,
} from "@/lib/imports/sources/cmb-zip";
import { MAX_IMPORT_FILE_BYTES } from "@/lib/imports/limits";

const zipPassword = "fixture-password";

function fixture(name: string) {
  return readFile(path.join(process.cwd(), "tests", "fixtures", "imports", "cmb", name));
}

async function createZip(
  entries: Array<{ data?: Uint8Array; name: string }>,
  options: { encrypted?: boolean } = {},
) {
  const writer = new Uint8ArrayWriter();
  const zipWriter = new ZipWriter(writer, {
    password: options.encrypted === false ? undefined : zipPassword,
    useWebWorkers: false,
    zipCrypto: options.encrypted === false ? undefined : true,
  });

  for (const entry of entries) {
    await zipWriter.add(
      entry.name,
      entry.data ? new Uint8ArrayReader(entry.data) : undefined,
    );
  }

  return Buffer.from(await zipWriter.close());
}

describe("CMB ZIP import", () => {
  it("does not decrypt a cancelled import", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(parseCmbZip(Buffer.from("zip"), zipPassword, controller.signal)).rejects.toThrow("xlsx-timeout");
  });

  it("decrypts one password-protected PDF and reuses the PDF parser", async () => {
    const pdf = await fixture("statement-single-page.pdf");
    const zip = await createZip([{ data: pdf, name: "招商银行交易流水.pdf" }]);

    const fromPdf = await parseCmbPdf(pdf);
    const fromZip = await parseCmbZip(zip, zipPassword);

    expect(fromZip).toEqual(fromPdf);
  });

  it("requires a password without exposing it in the error", async () => {
    const pdf = await fixture("statement-single-page.pdf");
    const zip = await createZip([{ data: pdf, name: "statement.pdf" }]);

    await expect(parseCmbZip(zip, "")).rejects.toThrow(CMB_ZIP_PASSWORD_REQUIRED_MESSAGE);
    await expect(parseCmbZip(zip, "wrong-password")).rejects.toThrow(CMB_ZIP_UNREADABLE_MESSAGE);

    await expect(parseCmbZip(zip, "wrong-password")).rejects.toThrowError(
      new RegExp(`^(?!.*wrong-password).*${CMB_ZIP_UNREADABLE_MESSAGE}$`),
    );
  });

  it.each([
    {
      description: "an empty archive",
      entries: [],
    },
    {
      description: "an archive with more than one entry",
      entries: [
        { data: Buffer.from("first"), name: "first.pdf" },
        { data: Buffer.from("second"), name: "second.pdf" },
      ],
    },
    {
      description: "an archive with a non-PDF entry",
      entries: [{ data: Buffer.from("not a PDF"), name: "statement.txt" }],
    },
    {
      description: "a directory entry",
      entries: [{ name: "folder/" }],
    },
    {
      description: "an encrypted PDF entry without a PDF header",
      entries: [{ data: Buffer.from("not a PDF"), name: "statement.pdf" }],
    },
    {
      description: "an unencrypted archive",
      entries: [{ data: Buffer.from("not a PDF"), name: "statement.pdf" }],
      encrypted: false,
    },
  ])("rejects $description", async ({ entries, encrypted }) => {
    const zip = await createZip(entries, { encrypted });

    await expect(parseCmbZip(zip, zipPassword)).rejects.toThrow(CMB_ZIP_UNREADABLE_MESSAGE);
  });

  it("rejects a corrupt archive and a decompressed entry over the shared limit", async () => {
    await expect(parseCmbZip(Buffer.from("not a zip"), zipPassword)).rejects.toThrow(
      CMB_ZIP_UNREADABLE_MESSAGE,
    );

    const oversized = await createZip([
      { data: new Uint8Array(MAX_IMPORT_FILE_BYTES + 1), name: "statement.pdf" },
    ]);

    await expect(parseCmbZip(oversized, zipPassword)).rejects.toThrow("Import file is too large");
  });

  it("keeps a PDF layout error distinct from a ZIP read error", async () => {
    const zip = await createZip([{ data: Buffer.from("%PDF-invalid"), name: "statement.pdf" }]);

    await expect(parseCmbZip(zip, zipPassword)).rejects.toThrow("无法识别招商银行流水格式");
    await expect(parseCmbZip(zip, zipPassword)).rejects.not.toThrow(CMB_ZIP_UNREADABLE_MESSAGE);
  });
});
