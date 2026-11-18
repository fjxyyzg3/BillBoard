import { TransactionType } from "@prisma/client";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { describe, expect, it } from "vitest";

import { buildImportCategoryMappingKey } from "@/lib/imports/category-mapping";
import { parseCmbPdf } from "@/lib/imports/sources/cmb";
import { CMB_SOURCE } from "@/lib/imports/types";

function fixture(name: string) {
  return readFile(path.join(process.cwd(), "tests", "fixtures", "imports", "cmb", name));
}

describe("CMB import contracts", () => {
  it("uses a stable source prefix for category mappings", () => {
    expect(CMB_SOURCE).toBe("cmb");
    expect(
      buildImportCategoryMappingKey({
        primaryCategory: "快捷支付",
        secondaryCategory: "示例商户",
        source: CMB_SOURCE,
        transactionType: TransactionType.EXPENSE,
      }),
    ).toBe("cmb|EXPENSE|快捷支付|示例商户");
  });

  it("parses signed CNY rows from an official text-layer statement", async () => {
    const result = await parseCmbPdf(await fixture("statement-single-page.pdf"));

    expect(result.ownerName).toBe("示例户名");
    expect(result.rows[0]).toMatchObject({
      amountFen: 123456,
      mappingKey: "cmb|EXPENSE|快捷支付|示例商户 示例门店",
      occurredAt: new Date("2026-07-03T16:00:00.000Z"),
      occurredAtDate: "2026-07-04",
      primaryCategory: "快捷支付",
      rawCurrency: "CNY",
      secondaryCategory: "示例商户 示例门店",
      transactionType: TransactionType.EXPENSE,
    });
    expect(result.rows[1]).toMatchObject({
      amountFen: 800000,
      transactionType: TransactionType.INCOME,
    });
  });

  it("reconstructs rows across repeated multi-page headers", async () => {
    const result = await parseCmbPdf(await fixture("statement-multi-page.pdf"));

    expect(result.rows.map((row) => row.rowNumber)).toEqual([1, 2, 3, 4]);
    expect(result.rows[3]).toMatchObject({
      amountFen: 3940,
      secondaryCategory: "示例出版商户 直营网店",
    });
  });

  it("preserves centered multiline cells across a continuation page without a title", async () => {
    const result = await parseCmbPdf(await fixture("statement-continuation-pages.pdf"));

    expect(result.ownerName).toBe("示例户名");
    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toHaveLength(4);
    expect(result.rows).toMatchObject([
      {
        amountFen: 3210,
        mappingKey: "cmb|EXPENSE|快捷支付 示例早餐|示例早餐店 城西分店",
        note: "招商银行：快捷支付 示例早餐；对手信息：示例早餐店 城西分店",
        occurredAt: new Date("2026-07-07T16:00:00.000Z"),
        occurredAtDate: "2026-07-08",
        primaryCategory: "快捷支付 示例早餐",
        rawCurrency: "CNY",
        rowNumber: 1,
        secondaryCategory: "示例早餐店 城西分店",
        sourceFingerprint: "d801f3472ef93fb154a3c384d198a8bcc86ecde41f5da01ca597cb359e5cd135",
        transactionType: TransactionType.EXPENSE,
      },
      {
        amountFen: 240000,
        mappingKey: "cmb|INCOME|工资 示例补贴|示例公司 财务部",
        note: "招商银行：工资 示例补贴；对手信息：示例公司 财务部",
        occurredAt: new Date("2026-07-08T16:00:00.000Z"),
        occurredAtDate: "2026-07-09",
        primaryCategory: "工资 示例补贴",
        rawCurrency: "CNY",
        rowNumber: 2,
        secondaryCategory: "示例公司 财务部",
        sourceFingerprint: "34844f3b864d8606e6276e418b46f4833a34d7a9a8b2c9c53237d85284251639",
        transactionType: TransactionType.INCOME,
      },
      {
        amountFen: 5820,
        mappingKey: "cmb|EXPENSE|快捷支付 示例图书|示例书店 城东门店",
        note: "招商银行：快捷支付 示例图书；对手信息：示例书店 城东门店",
        occurredAt: new Date("2026-07-09T16:00:00.000Z"),
        occurredAtDate: "2026-07-10",
        primaryCategory: "快捷支付 示例图书",
        rawCurrency: "CNY",
        rowNumber: 3,
        secondaryCategory: "示例书店 城东门店",
        sourceFingerprint: "e7f0906de1951bb6ed69eedd18ed88456b84c586cde98dc345999da194502047",
        transactionType: TransactionType.EXPENSE,
      },
      {
        amountFen: 800,
        mappingKey: "cmb|INCOME|退款 示例退货|示例百货 客服中心",
        note: "招商银行：退款 示例退货；对手信息：示例百货 客服中心",
        occurredAt: new Date("2026-07-10T16:00:00.000Z"),
        occurredAtDate: "2026-07-11",
        primaryCategory: "退款 示例退货",
        rawCurrency: "CNY",
        rowNumber: 4,
        secondaryCategory: "示例百货 客服中心",
        sourceFingerprint: "3a92f40a0d60c55ac7345c8c06c112b49940248f718764115e569f2164d84d3d",
        transactionType: TransactionType.INCOME,
      },
    ]);
  });

  it.each([
    {
      name: "statement-single-page.pdf",
      fingerprints: [
        "7aa8559ad3d05a77cd3e2c56a159291bb16106c72969cc2fd1153c45951655cc",
        "6be5a3fa7c5c4f7f904ef1128c44266149a305cada86f42d4ec85d50c92f0817",
        "d09f8f9faab1e5e7d2a64e196dbf295e85006d607ebca34a2c5e7f6d615390fd",
      ],
    },
    {
      name: "statement-multi-page.pdf",
      fingerprints: [
        "b447ac40f1903dcd08b066408ff2a5d69c258725d7903cb28ead1b4aa3e29431",
        "48e0e40f0b836fe4cc00563aa0d7e7f67829720af7ffc3d049c4e754b31ebef2",
        "baee26d2cd8592dfee6a105af82ae02f0b539635c222cbac877f7a5626a2ad02",
        "e4199d7f706f055cc054927daa549bdcab052f15983d8082b18b6261688974ac",
      ],
    },
  ])("preserves existing source fingerprints in $name", async ({ name, fingerprints }) => {
    const result = await parseCmbPdf(await fixture(name));

    expect(result.rows.map((row) => row.sourceFingerprint)).toEqual(fingerprints);
  });

  it("defaults transfer-like movements to skipped candidates", async () => {
    const result = await parseCmbPdf(await fixture("statement-single-page.pdf"));

    expect(result.rows[2]).toMatchObject({
      amountFen: 200000,
      defaultSkipReason: "Suggested bank transfer-like transaction",
      primaryCategory: "转账汇款",
      secondaryCategory: "示例户名",
    });
  });

  it("keeps non-CNY transactions as invalid rows", async () => {
    const result = await parseCmbPdf(await fixture("statement-single-page.pdf"));

    expect(result.invalidRows).toEqual([
      expect.objectContaining({
        rawCurrency: "USD",
        reason: "Unsupported currency",
        rowNumber: 4,
      }),
    ]);
  });

  it("stores only the approved summary and counterparty note", async () => {
    const result = await parseCmbPdf(await fixture("statement-single-page.pdf"));
    const row = result.rows[0];

    expect(row.note).toBe("招商银行：快捷支付；对手信息：示例商户 示例门店");
    expect(row.note).not.toContain("6214");
    expect(row.note).not.toContain("8,765.44");
    expect(row.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("rejects buffers without the supported official text layout", async () => {
    await expect(parseCmbPdf(Buffer.from("not a PDF", "utf8"))).rejects.toThrow(
      "无法识别招商银行流水格式",
    );
  });
});
