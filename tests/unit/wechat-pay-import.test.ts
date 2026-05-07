import { TransactionType } from "@prisma/client";
import ExcelJS from "exceljs";
import { describe, expect, it } from "vitest";

import { parseWechatPayWorkbook } from "@/lib/imports/sources/wechat-pay";

const headers = [
  "交易时间",
  "交易类型",
  "交易对方",
  "商品",
  "收/支",
  "金额(元)",
  "支付方式",
  "当前状态",
  "交易单号",
  "商户单号",
  "备注",
];

async function buildWorkbookBuffer(rows: unknown[][], ownerName = "李环宇"): Promise<Buffer> {
  const workbook = new ExcelJS.Workbook();
  const sheet = workbook.addWorksheet("Sheet1");
  sheet.addRows([
    ["微信支付账单明细"],
    [`微信昵称：[${ownerName}]`],
    ["起始时间：[2026-04-30 00:00:00] 终止时间：[2026-05-07 20:26:54]"],
    [],
    ["----------------------微信支付账单明细列表--------------------"],
    headers,
    ...rows,
  ]);

  return Buffer.from(await workbook.xlsx.writeBuffer());
}

describe("parseWechatPayWorkbook", () => {
  it("parses WeChat Pay expense rows with owner name, mapping key, note, and fingerprint", async () => {
    const buffer = await buildWorkbookBuffer([
      [
        new Date("2026-05-02T09:22:40.000Z"),
        "扫二维码付款",
        "阿泉食杂店",
        "收款方备注:二维码收款",
        "支出",
        "30",
        "招商银行储蓄卡(1209)",
        "已转账",
        "53110001409141202605020932752192",
        "10001073012026050201637220123649",
        "/",
      ],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.ownerName).toBe("李环宇");
    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      amountFen: 3000,
      mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
      occurredAt: new Date("2026-05-02T09:22:40.000Z"),
      occurredAtDate: "2026-05-02",
      occurredAtText: "2026-05-02 17:22:40",
      primaryCategory: "扫二维码付款",
      rawAmount: "30",
      rawCreatedBy: "李环宇",
      rawCurrency: "CNY",
      rawDate: "2026-05-02 17:22:40",
      rawMember: "李环宇",
      rawTransactionType: "支出",
      rowNumber: 7,
      secondaryCategory: "阿泉食杂店",
      sheetName: "Sheet1",
      transactionType: TransactionType.EXPENSE,
    });
    expect(result.rows[0]?.note).toContain("微信支付：扫二维码付款");
    expect(result.rows[0]?.note).toContain("交易对方：阿泉食杂店");
    expect(result.rows[0]?.note).toContain("支付方式：招商银行储蓄卡(1209)");
    expect(result.rows[0]?.note).not.toContain("备注：/");
    expect(result.rows[0]?.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("keeps source fingerprints stable when only the file owner nickname changes", async () => {
    const row = [
      "2026-05-05 18:54:18",
      "商户消费",
      "商户 A",
      "商品",
      "支出",
      "1",
      "零钱",
      "支付成功",
      "same-order",
      "same-merchant-order",
      "同一笔交易",
    ];
    const husbandBuffer = await buildWorkbookBuffer([row], "李环宇");
    const wifeBuffer = await buildWorkbookBuffer([row], "晶晶");

    const husbandResult = await parseWechatPayWorkbook(husbandBuffer);
    const wifeResult = await parseWechatPayWorkbook(wifeBuffer);

    expect(husbandResult.ownerName).toBe("李环宇");
    expect(wifeResult.ownerName).toBe("晶晶");
    expect(husbandResult.rows[0]?.sourceFingerprint).toBe(wifeResult.rows[0]?.sourceFingerprint);
  });

  it("parses income rows and treats unknown non-error statuses as importable", async () => {
    const buffer = await buildWorkbookBuffer([
      [
        "2026-05-05 18:54:18",
        "转账",
        "朋友",
        "转账收款",
        "收入",
        "88.66",
        "零钱",
        "新的成功状态",
        "income-order",
        "merchant-order",
        "晚饭 AA",
      ],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.rows[0]).toMatchObject({
      amountFen: 8866,
      mappingKey: "wechat_pay|INCOME|转账|朋友",
      occurredAt: new Date("2026-05-05T10:54:18.000Z"),
      occurredAtDate: "2026-05-05",
      occurredAtText: "2026-05-05 18:54:18",
      transactionType: TransactionType.INCOME,
    });
    expect(result.invalidRows).toEqual([]);
  });

  it("marks neutral transactions as invalid without blocking other rows", async () => {
    const buffer = await buildWorkbookBuffer([
      [
        "2026-05-05 18:54:18",
        "零钱提现",
        "微信支付",
        "提现",
        "中性交易",
        "100",
        "零钱",
        "提现成功",
        "neutral-order",
        "",
        "",
      ],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.rows).toEqual([]);
    expect(result.invalidRows).toMatchObject([
      {
        rawAmount: "100",
        rawCreatedBy: "李环宇",
        rawCurrency: "CNY",
        rawDate: "2026-05-05 18:54:18",
        rawMember: "李环宇",
        rawTransactionType: "中性交易",
        reason: "Neutral transaction is not importable",
        rowNumber: 7,
        sheetName: "Sheet1",
      },
    ]);
  });

  it("marks refund, closed, and failed statuses as invalid", async () => {
    const buffer = await buildWorkbookBuffer([
      ["2026-05-05 18:54:18", "商户消费", "商户 A", "商品", "支出", "1", "零钱", "已全额退款", "refund", "", ""],
      ["2026-05-05 18:55:18", "商户消费", "商户 B", "商品", "支出", "2", "零钱", "交易关闭", "closed", "", ""],
      ["2026-05-05 18:56:18", "商户消费", "商户 C", "商品", "支出", "3", "零钱", "支付失败", "failed", "", ""],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.rows).toEqual([]);
    expect(result.invalidRows.map((row) => row.reason)).toEqual([
      "Refunded or unsuccessful transaction",
      "Refunded or unsuccessful transaction",
      "Refunded or unsuccessful transaction",
    ]);
  });

  it("throws for workbooks without a WeChat Pay detail header", async () => {
    const workbook = new ExcelJS.Workbook();
    workbook.addWorksheet("Sheet1").addRows([["交易类型", "日期"]]);
    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());

    await expect(parseWechatPayWorkbook(buffer)).rejects.toThrow("无法识别微信支付账单格式");
  });
});
