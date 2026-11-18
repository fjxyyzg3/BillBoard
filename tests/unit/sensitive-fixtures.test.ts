import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const scannedFiles = [
  "src/lib/imports/member-mapping.ts",
  "src/lib/imports/sources/cmb.ts",
  "src/lib/imports/sources/cmb-zip.ts",
  "tests/unit/alipay-import.test.ts",
  "tests/unit/wechat-pay-import.test.ts",
  "tests/unit/sui-shou-ji-import.test.ts",
  "tests/unit/cmb-import.test.ts",
  "tests/unit/cmb-import-errors.test.ts",
  "tests/unit/cmb-zip-import.test.ts",
  "tests/e2e/import-alipay.spec.ts",
  "tests/e2e/import-wechat-pay.spec.ts",
  "tests/e2e/import-sui-shou-ji.spec.ts",
  "tests/e2e/import-cmb.spec.ts",
  "docs/superpowers/specs/2026-05-06-import-sui-shou-ji-design.md",
  "docs/superpowers/specs/2026-05-07-import-wechat-pay-design.md",
  "docs/superpowers/specs/2026-05-08-import-alipay-design.md",
  "docs/superpowers/specs/2026-07-13-import-cmb-pdf-design.md",
  "docs/superpowers/plans/2026-05-07-import-wechat-pay-implementation.md",
  "docs/superpowers/plans/2026-05-08-import-alipay-implementation.md",
  "docs/superpowers/plans/2026-07-13-import-cmb-pdf-implementation.md",
  "docs/scope/2026-10-10-cmb-zip-import.md",
  "docs/plans/2026-10-10-cmb-zip-import/plan-cmb-zip-import.md",
  "docs/wiki/import-cmb.md",
];

const sensitiveFields = [
  { label: "unmasked mobile number", pattern: /(?<![a-z0-9])1[3-9][0-9]{9}(?![a-z0-9])/iu },
  { label: "unmasked account or order identifier", pattern: /(?<![a-z0-9])(?:[0-9]{15,32}|[0-9]{17}x)(?![a-z0-9])/iu },
  { label: "non-example card suffix", pattern: /(?:借记卡|信用卡|储蓄卡)\s*[(（](?!0000[)）])[0-9]{4}[)）]/u },
];

function findSensitiveFields(content: string) {
  const findings = sensitiveFields.filter(({ pattern }) => pattern.test(content)).map(({ label }) => label);
  const addresses = content.matchAll(/[a-z0-9._%+-]+@((?:[a-z0-9-]+\.)+[a-z]{2,})/giu);
  for (const [, domain] of addresses) {
    if (!/(?:^|\.)example\.(?:com|net|org)$|\.(?:example|test|invalid)$/iu.test(domain)) {
      findings.push("non-example email address");
      break;
    }
  }
  return findings;
}

// These digests cover whole, reviewed synthetic PDFs, including text layers and metadata.
const reviewedPdfs = [
  { file: "tests/fixtures/imports/cmb/statement-continuation-pages.pdf", sha256: "af4190ac74360e5286411acee7d192c3ce06b8e31666b25323648ed502c6c849" },
  { file: "tests/fixtures/imports/cmb/statement-multi-page.pdf", sha256: "a90077d8b4e5e458f8426284c71bdc3f99d8d3468ddc6a936438b9775f271619" },
  { file: "tests/fixtures/imports/cmb/statement-refunds.pdf", sha256: "9d147633d5265e37dc9c4a9dd257e7ff0f5dc7094de19189249d3fba16f24064" },
  { file: "tests/fixtures/imports/cmb/statement-single-page.pdf", sha256: "119cdedd1d5991f02f9a020ee5d7c7b8d7e656dc6b1ddbb35f64bee7a800ecdc" },
] as const;

async function extractPdfText(file: string) {
  const { getDocument } = await import("pdfjs-dist/legacy/build/pdf.mjs");
  const assetUrl = (folder: string) =>
    `${join(process.cwd(), "node_modules", "pdfjs-dist", folder).replaceAll("\\", "/")}/`;
  const loadingTask = getDocument({
    cMapPacked: true,
    cMapUrl: assetUrl("cmaps"),
    data: new Uint8Array(readFileSync(join(process.cwd(), file))),
    standardFontDataUrl: assetUrl("standard_fonts"),
  });

  try {
    const document = await loadingTask.promise;
    const text: string[] = [];

    for (let pageNumber = 1; pageNumber <= document.numPages; pageNumber += 1) {
      const page = await document.getPage(pageNumber);
      const content = await page.getTextContent();
      text.push(...content.items.flatMap((item) => ("str" in item ? [item.str] : [])));
    }

    return text.join("\n");
  } finally {
    await loadingTask.destroy();
  }
}

describe("tracked sample data", () => {
  it("flags identifying fields without reporting their values", () => {
    const phone = ["199", "0000", "0000"].join("");
    const account = "1234".repeat(4);
    expect(findSensitiveFields(phone)).toEqual(["unmasked mobile number"]);
    expect(findSensitiveFields(account)).toEqual(["unmasked account or order identifier"]);
    expect(findSensitiveFields("信用卡(1234)")).toEqual(["non-example card suffix"]);
    expect(findSensitiveFields("sample@intranet.local")).toEqual(["non-example email address"]);
    expect(findSensitiveFields("示例银行信用卡(0000) member@example.test")).toEqual([]);
  });

  it.each(scannedFiles)("uses masked identifiers and reserved email domains in %s", (file) => {
    const content = readFileSync(join(process.cwd(), file), "utf8");
    expect(findSensitiveFields(content)).toEqual([]);
  });

  it.each(reviewedPdfs)("contains only the reviewed synthetic statement in $file", async ({ file, sha256 }) => {
    const bytes = readFileSync(join(process.cwd(), file));
    expect(createHash("sha256").update(bytes).digest("hex")).toBe(sha256);
    expect(findSensitiveFields(await extractPdfText(file))).toEqual([]);
  });
});
