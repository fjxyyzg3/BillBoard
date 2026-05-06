import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";

describe("import data model", () => {
  it("declares import draft models and transaction source metadata", () => {
    const schema = readFileSync(path.resolve(process.cwd(), "prisma/schema.prisma"), "utf8");

    expect(schema).toContain("enum ImportDraftStatus");
    expect(schema).toContain("enum ImportDraftRowStatus");
    expect(schema).toContain("enum ImportRowDecision");
    expect(schema).toContain("model ImportCategoryMapping");
    expect(schema).toContain("model ImportDraft");
    expect(schema).toContain("model ImportDraftRow");
    expect(schema).toContain("sourceFingerprint String?");
    expect(schema).toContain(
      '@@unique([householdId, source, transactionType, primaryCategory, secondaryCategory], name: "household_source_type_primary_secondary", map: "household_source_type_primary_secondary")',
    );
  });

  it("uses exceljs for server-side workbook reads without the vulnerable xlsx package", () => {
    const packageJson = JSON.parse(
      readFileSync(path.resolve(process.cwd(), "package.json"), "utf8"),
    ) as { dependencies?: Record<string, string> };

    expect(packageJson.dependencies?.exceljs).toEqual(expect.any(String));
    expect(packageJson.dependencies?.xlsx).toBeUndefined();
  });
});
