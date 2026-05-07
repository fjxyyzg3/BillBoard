import { TransactionType } from "@prisma/client";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { buildImportCategoryMappingKey } from "@/lib/imports/category-mapping";
import { createSourceFingerprint } from "@/lib/imports/fingerprint";
import { resolveImportedMember } from "@/lib/imports/member-mapping";
import { parseSuiShouJiWorkbook } from "@/lib/imports/sources/sui-shou-ji";
import { SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE } from "@/lib/imports/types";

const members = [
  { id: "husband-member", memberName: "老公" },
  { id: "wife-member", memberName: "老婆" },
];

async function buildWorkbookBuffer(sheets: Record<string, unknown[][]>): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();

  for (const [sheetName, rows] of Object.entries(sheets)) {
    const sheet = workbook.addWorksheet(sheetName);
    sheet.addRows(rows);
  }

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("resolveImportedMember", () => {
  it("maps known aliases and falls back to the current member", () => {
    expect(resolveImportedMember("李环宇", members, "current-member")).toEqual({
      memberId: "husband-member",
      fallbackApplied: false,
    });
    expect(resolveImportedMember("老公", members, "current-member")).toEqual({
      memberId: "husband-member",
      fallbackApplied: false,
    });
    expect(resolveImportedMember("晶晶", members, "current-member")).toEqual({
      memberId: "wife-member",
      fallbackApplied: false,
    });
    expect(resolveImportedMember("老婆", members, "current-member")).toEqual({
      memberId: "wife-member",
      fallbackApplied: false,
    });
    expect(resolveImportedMember("朋友", members, "current-member")).toEqual({
      memberId: "current-member",
      fallbackApplied: true,
    });
    expect(resolveImportedMember("  ", members, "current-member")).toEqual({
      memberId: "current-member",
      fallbackApplied: true,
    });
  });
});

describe("buildImportCategoryMappingKey", () => {
  it("joins the source, transaction type, and normalized imported categories", () => {
    expect(
      buildImportCategoryMappingKey({
        source: SUI_SHOU_JI_SOURCE,
        transactionType: TransactionType.EXPENSE,
        primaryCategory: "餐饮",
        secondaryCategory: "三餐  ",
      }),
    ).toBe("sui_shou_ji|EXPENSE|餐饮|三餐");
  });

  it("supports distinct source prefixes for each import source", () => {
    expect(SUI_SHOU_JI_SOURCE).toBe("sui_shou_ji");
    expect(WECHAT_PAY_SOURCE).toBe("wechat_pay");
    expect(
      buildImportCategoryMappingKey({
        source: WECHAT_PAY_SOURCE,
        transactionType: TransactionType.EXPENSE,
        primaryCategory: "扫二维码付款",
        secondaryCategory: "阿泉食杂店",
      }),
    ).toBe("wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店");
  });
});

describe("createSourceFingerprint", () => {
  it("returns a stable lowercase SHA-256 fingerprint for normalized source rows", () => {
    const first = createSourceFingerprint({
      source: SUI_SHOU_JI_SOURCE,
      transactionType: TransactionType.EXPENSE,
      occurredAtText: " 2026-05-06 13:23:02 ",
      amountText: "176",
      memberName: " 晶晶",
      createdByName: "晶晶 ",
      primaryCategory: " 餐饮",
      rawAccount: " 现金",
      rawCurrency: "CNY ",
      rawMerchant: " 小店",
      secondaryCategory: "三餐  ",
      note: "午饭 ",
    });
    const second = createSourceFingerprint({
      source: SUI_SHOU_JI_SOURCE,
      transactionType: TransactionType.EXPENSE,
      occurredAtText: "2026-05-06 13:23:02",
      amountText: "176",
      memberName: "晶晶",
      createdByName: "晶晶",
      primaryCategory: "餐饮",
      rawAccount: "现金",
      rawCurrency: "CNY",
      rawMerchant: "小店",
      secondaryCategory: "三餐",
      note: "午饭",
    });

    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(first).toBe(second);
  });

  it("separates fingerprints when only the raw account or merchant differs", () => {
    const base = {
      source: SUI_SHOU_JI_SOURCE,
      transactionType: TransactionType.EXPENSE,
      occurredAtText: "2026-05-06 13:23:02",
      amountText: "176",
      memberName: "晶晶",
      createdByName: "晶晶",
      primaryCategory: "餐饮",
      rawCurrency: "CNY",
      secondaryCategory: "三餐",
      note: "午饭",
    };

    const cashFingerprint = createSourceFingerprint({
      ...base,
      rawAccount: "现金",
      rawMerchant: "小店",
    });
    const cardFingerprint = createSourceFingerprint({
      ...base,
      rawAccount: "银行卡",
      rawMerchant: "小店",
    });
    const otherMerchantFingerprint = createSourceFingerprint({
      ...base,
      rawAccount: "现金",
      rawMerchant: "另一家店",
    });

    expect(cashFingerprint).not.toBe(cardFingerprint);
    expect(cashFingerprint).not.toBe(otherMerchantFingerprint);
  });
});

describe("parseSuiShouJiWorkbook", () => {
  const headers = [
    "交易类型",
    "日期",
    "一级分类",
    "二级分类",
    "账户1",
    "账户币种",
    "金额",
    "成员",
    "商家",
    "记账人",
    "备注",
  ];

  it("parses expense and income sheets into normalized import rows", async () => {
    const buffer = await buildWorkbookBuffer({
      支出: [
        headers,
        [
          "支出",
          "2026-05-06 13:23:02",
          "餐饮",
          "三餐  ",
          "现金",
          "CNY",
          "176",
          "晶晶",
          "小店",
          "晶晶",
          "午饭",
        ],
      ],
      收入: [
        headers,
        [
          "收入",
          "2026-04-30 12:30:49",
          "职业收入",
          "工资  ",
          "银行卡",
          "CNY",
          "56276.72",
          "",
          "",
          "李环宇",
          "",
        ],
      ],
    });

    const result = await parseSuiShouJiWorkbook(buffer);

    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0]).toMatchObject({
      rowNumber: 2,
      sheetName: "支出",
      transactionType: TransactionType.EXPENSE,
      amountFen: 17600,
      occurredAtText: "2026-05-06 13:23:02",
      occurredAt: new Date("2026-05-06T05:23:02.000Z"),
      occurredAtDate: "2026-05-06",
      primaryCategory: "餐饮",
      secondaryCategory: "三餐",
      rawAmount: "176",
      rawCreatedBy: "晶晶",
      rawCurrency: "CNY",
      rawDate: "2026-05-06 13:23:02",
      rawMember: "晶晶",
      rawTransactionType: "支出",
      mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐",
      note: "午饭\n随手记：餐饮 / 三餐；成员：晶晶；记账人：晶晶；账户：现金；商家：小店",
    });
    expect(result.rows[0]?.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
    expect(result.rows[1]).toMatchObject({
      rowNumber: 2,
      sheetName: "收入",
      transactionType: TransactionType.INCOME,
      amountFen: 5627672,
      occurredAtText: "2026-04-30 12:30:49",
      occurredAt: new Date("2026-04-30T04:30:49.000Z"),
      occurredAtDate: "2026-04-30",
      primaryCategory: "职业收入",
      secondaryCategory: "工资",
      rawAmount: "56276.72",
      rawCreatedBy: "李环宇",
      rawCurrency: "CNY",
      rawDate: "2026-04-30 12:30:49",
      rawMember: "",
      rawTransactionType: "收入",
      mappingKey: "sui_shou_ji|INCOME|职业收入|工资",
      note: "随手记：职业收入 / 工资；记账人：李环宇；账户：银行卡",
    });
  });

  it("throws when the workbook has more than the supported total data rows", async () => {
    const rows = Array.from({ length: 20_001 }, () => [
      "支出",
      "2026-05-06 13:23:02",
      "餐饮",
      "三餐",
      "现金",
      "CNY",
      "176",
      "晶晶",
      "小店",
      "晶晶",
      "午饭",
    ]);
    const buffer = await buildWorkbookBuffer({
      支出: [headers, ...rows],
    });

    await expect(parseSuiShouJiWorkbook(buffer)).rejects.toThrow("Import file is too large");
  });

  it("returns invalid rows for unsupported currency", async () => {
    const buffer = await buildWorkbookBuffer({
      支出: [
        headers,
        [
          "支出",
          "2026-05-06 13:23:02",
          "餐饮",
          "三餐",
          "现金",
          "USD",
          "176",
          "晶晶",
          "",
          "晶晶",
          "",
        ],
      ],
    });

    const result = await parseSuiShouJiWorkbook(buffer);

    expect(result.rows).toEqual([]);
    expect(result.invalidRows).toMatchObject([
      {
        rowNumber: 2,
        sheetName: "支出",
        reason: "Unsupported currency",
        rawCurrency: "USD",
      },
    ]);
  });

  it("returns invalid rows for invalid amounts", async () => {
    const buffer = await buildWorkbookBuffer({
      支出: [
        headers,
        [
          "支出",
          "2026-05-06 13:23:02",
          "餐饮",
          "三餐",
          "现金",
          "CNY",
          "0",
          "晶晶",
          "",
          "晶晶",
          "",
        ],
      ],
    });

    const result = await parseSuiShouJiWorkbook(buffer);

    expect(result.rows).toEqual([]);
    expect(result.invalidRows).toMatchObject([
      {
        rowNumber: 2,
        sheetName: "支出",
        reason: "Invalid amount",
        rawAmount: "0",
      },
    ]);
  });

  it("returns invalid rows for impossible local dates", async () => {
    const buffer = await buildWorkbookBuffer({
      支出: [
        headers,
        [
          "支出",
          "2026-02-31 10:00:00",
          "餐饮",
          "三餐",
          "现金",
          "CNY",
          "176",
          "晶晶",
          "",
          "晶晶",
          "",
        ],
      ],
    });

    const result = await parseSuiShouJiWorkbook(buffer);

    expect(result.rows).toEqual([]);
    expect(result.invalidRows).toMatchObject([
      {
        rowNumber: 2,
        sheetName: "支出",
        reason: "Invalid date",
        rawDate: "2026-02-31 10:00:00",
      },
    ]);
  });

  it("throws when no Sui Shou Ji sheets are present", async () => {
    const buffer = await buildWorkbookBuffer({
      Sheet1: [["交易类型", "日期"]],
    });

    await expect(parseSuiShouJiWorkbook(buffer)).rejects.toThrow("无法识别随手记导出格式");
  });

  it("throws when a present Sui Shou Ji sheet is missing required headers", async () => {
    const buffer = await buildWorkbookBuffer({
      支出: [["交易类型", "日期"]],
    });

    await expect(parseSuiShouJiWorkbook(buffer)).rejects.toThrow("无法识别随手记导出格式");
  });
});
