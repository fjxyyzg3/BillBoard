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

async function buildWorkbookBuffer(rows: unknown[][], ownerName = "老公"): Promise<Buffer> {
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
  it("parses summaries with empty merged cells without changing transaction data or fingerprints", async () => {
    const buffer = await buildWorkbookBuffer([
      [
        "2026-05-05 18:54:18",
        "商户消费",
        "示例商户",
        "示例商品",
        "支出",
        "12.34",
        "零钱",
        "支付成功",
        "merged-summary-order",
        "merged-summary-merchant-order",
        "/",
      ],
    ]);
    const expected = await parseWechatPayWorkbook(buffer);
    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.load(buffer);
    const sheet = workbook.getWorksheet("Sheet1")!;
    for (let row = 1; row <= 5; row += 1) {
      sheet.mergeCells(`A${row}:K${row}`);
    }

    const result = await parseWechatPayWorkbook(Buffer.from(await workbook.xlsx.writeBuffer()));

    expect(expected.rows).toHaveLength(1);
    expect(expected.invalidRows).toEqual([]);
    expect(result).toEqual(expected);
  });

  it("parses WeChat Pay expense rows with counterparty and product notes", async () => {
    const buffer = await buildWorkbookBuffer([
      [
        new Date("2026-05-02T09:22:40.000Z"),
        "扫二维码付款",
        "示例商户",
        "示例商品",
        "支出",
        "30",
        "示例银行储蓄卡(0000)",
        "已转账",
        "wechat-order-example-1",
        "wechat-merchant-order-example-1",
        "/",
      ],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.ownerName).toBe("老公");
    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      amountFen: 3000,
      mappingKey: "wechat_pay|EXPENSE|扫二维码付款|示例商户",
      occurredAt: new Date("2026-05-02T09:22:40.000Z"),
      occurredAtDate: "2026-05-02",
      occurredAtText: "2026-05-02 17:22:40",
      primaryCategory: "扫二维码付款",
      rawAmount: "30",
      rawCreatedBy: "老公",
      rawCurrency: "CNY",
      rawDate: "2026-05-02 17:22:40",
      rawMember: "老公",
      rawTransactionType: "支出",
      rowNumber: 7,
      secondaryCategory: "示例商户",
      sheetName: "Sheet1",
      transactionType: TransactionType.EXPENSE,
    });
    expect(result.rows[0]?.note).toBe("交易对方：示例商户；商品：示例商品");
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
    const husbandBuffer = await buildWorkbookBuffer([row], "老公");
    const wifeBuffer = await buildWorkbookBuffer([row], "老婆");

    const husbandResult = await parseWechatPayWorkbook(husbandBuffer);
    const wifeResult = await parseWechatPayWorkbook(wifeBuffer);

    expect(husbandResult.ownerName).toBe("老公");
    expect(wifeResult.ownerName).toBe("老婆");
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

  it("nets a partial refund from the payment status and consumes the refund income", async () => {
    const buffer = await buildWorkbookBuffer([
      [
        "2026-08-22 12:33:33",
        "示例服务有限公司-退款",
        "示例服务有限公司",
        "示例服务有限公司",
        "收入",
        "1.19",
        "零钱",
        "已退款¥1.19",
        "wechat-refund-order",
        "",
        "/",
      ],
      [
        "2026-08-22 06:10:21",
        "商户消费",
        "示例服务有限公司",
        "示例商品",
        "支出",
        "2",
        "零钱",
        "已退款(¥1.19)",
        "wechat-payment-order",
        "wechat-payment-merchant-order",
        "/",
      ],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      amountFen: 81,
      occurredAtText: "2026-08-22 06:10:21",
      primaryCategory: "商户消费",
      refundHandling: "WECHAT_PARTIAL",
      refundOriginalAmountFen: 200,
      secondaryCategory: "示例服务有限公司",
      transactionType: TransactionType.EXPENSE,
    });
  });

  it("nets a partial refund even when the refund income is outside the workbook", async () => {
    const buffer = await buildWorkbookBuffer([
      [
        "2026-08-22 06:10:21",
        "商户消费",
        "示例商户",
        "示例商品",
        "支出",
        "2",
        "零钱",
        "已退款(¥1.19)",
        "wechat-payment-order",
        "wechat-payment-merchant-order",
        "/",
      ],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toMatchObject([
      {
        amountFen: 81,
        refundHandling: "WECHAT_PARTIAL",
        refundOriginalAmountFen: 200,
      },
    ]);
  });

  it("keeps the refund payment fingerprint stable as the refund amount changes or becomes full", async () => {
    const payment = (status: string) => [
      "2026-08-22 06:10:21",
      "商户消费",
      "示例商户",
      "示例商品",
      "支出",
      "2",
      "零钱",
      status,
      "stable-payment-order",
      "stable-merchant-order",
      "/",
    ];
    const partial = await parseWechatPayWorkbook(
      await buildWorkbookBuffer([payment("已退款(¥1.19)")]),
    );
    const increased = await parseWechatPayWorkbook(
      await buildWorkbookBuffer([payment("已退款(￥1.25)")]),
    );
    const full = await parseWechatPayWorkbook(
      await buildWorkbookBuffer([payment("已全额退款")]),
    );

    expect(partial.rows[0]).toMatchObject({
      amountFen: 81,
      refundHandling: "WECHAT_PARTIAL",
      refundOriginalAmountFen: 200,
    });
    expect(increased.rows[0]).toMatchObject({
      amountFen: 75,
      refundHandling: "WECHAT_PARTIAL",
      refundOriginalAmountFen: 200,
    });
    expect(full.rows[0]).toMatchObject({
      amountFen: 200,
      refundHandling: "WECHAT_FULL",
      refundOriginalAmountFen: 200,
    });
    expect(increased.rows[0]?.sourceFingerprint).toBe(partial.rows[0]?.sourceFingerprint);
    expect(full.rows[0]?.sourceFingerprint).toBe(partial.rows[0]?.sourceFingerprint);
  });

  it("aggregates covered refund incomes by non-empty counterparty and emits one residual outcome", async () => {
    const buffer = await buildWorkbookBuffer([
      ["2026-08-22 06:00:00", "商户消费", "商户 A", "商品 1", "支出", "3", "零钱", "已退款(¥1)", "payment-1", "merchant-1", ""],
      ["2026-08-22 06:01:00", "商户消费", "商户 A", "商品 2", "支出", "4", "零钱", "已退款(¥1.50)", "payment-2", "merchant-2", ""],
      ["2026-08-22 07:00:00", "商户 A-退款", "商户 A", "商户 A", "收入", "1", "零钱", "已退款¥1", "refund-1", "", ""],
      ["2026-08-22 07:01:00", "商户 A-退款", "商户 A", "商户 A", "收入", "2", "零钱", "已退款¥2", "refund-2", "", ""],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toHaveLength(3);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amountFen: 200, refundHandling: "WECHAT_PARTIAL" }),
        expect.objectContaining({ amountFen: 250, refundHandling: "WECHAT_PARTIAL" }),
        expect.objectContaining({
          amountFen: 50,
          refundHandling: "WECHAT_MANUAL",
          transactionType: TransactionType.INCOME,
        }),
      ]),
    );
  });

  it("does not let empty counterparties consume each other's refund coverage", async () => {
    const buffer = await buildWorkbookBuffer([
      ["2026-08-22 06:00:00", "商户消费", "", "商品", "支出", "2", "零钱", "已退款(¥1)", "payment-empty", "merchant-empty", ""],
      ["2026-08-22 07:00:00", "示例-退款", "", "退款", "收入", "1", "零钱", "已退款¥1", "refund-empty-1", "", ""],
      ["2026-08-22 07:01:00", "示例-退款", "", "退款", "收入", "1", "零钱", "已退款¥1", "refund-empty-2", "", ""],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.invalidRows).toEqual([]);
    expect(result.rows.map((row) => row.refundHandling)).toEqual([
      "WECHAT_PARTIAL",
      "WECHAT_MANUAL",
      "WECHAT_MANUAL",
    ]);
  });

  it("rejects malformed refund amounts with specific reasons", async () => {
    const buffer = await buildWorkbookBuffer([
      ["2026-08-22 06:00:00", "商户消费", "商户 A", "商品", "支出", "2", "零钱", "已退款(¥2)", "payment-equal", "merchant-equal", ""],
      ["2026-08-22 06:01:00", "商户消费", "商户 B", "商品", "支出", "2", "零钱", "已退款(¥2.01)", "payment-over", "merchant-over", ""],
      ["2026-08-22 07:00:00", "商户 C-退款", "商户 C", "退款", "收入", "1", "零钱", "已退款¥1.01", "refund-mismatch", "", ""],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.rows).toEqual([]);
    expect(result.invalidRows.map((row) => row.reason)).toEqual([
      "WeChat partial refund amount is invalid",
      "WeChat partial refund amount is invalid",
      "WeChat refund status amount does not match row amount",
    ]);
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
        rawCreatedBy: "老公",
        rawCurrency: "CNY",
        rawDate: "2026-05-05 18:54:18",
        rawMember: "老公",
        rawTransactionType: "中性交易",
        reason: "Neutral transaction is not importable",
        rowNumber: 7,
        sheetName: "Sheet1",
      },
    ]);
  });

  it("handles full refunds and keeps closed and failed statuses invalid", async () => {
    const buffer = await buildWorkbookBuffer([
      ["2026-05-05 18:54:18", "商户消费", "商户 A", "商品", "支出", "1", "零钱", "已全额退款", "refund", "", ""],
      ["2026-05-05 18:55:18", "商户消费", "商户 B", "商品", "支出", "2", "零钱", "交易关闭", "closed", "", ""],
      ["2026-05-05 18:56:18", "商户消费", "商户 C", "商品", "支出", "3", "零钱", "支付失败", "failed", "", ""],
    ]);

    const result = await parseWechatPayWorkbook(buffer);

    expect(result.rows).toMatchObject([
      {
        amountFen: 100,
        refundHandling: "WECHAT_FULL",
        refundOriginalAmountFen: 100,
      },
    ]);
    expect(result.invalidRows.map((row) => row.reason)).toEqual([
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
