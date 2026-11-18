import { TransactionType } from "@prisma/client";
import { describe, expect, it, vi } from "vitest";

import { parseAlipayCsv } from "@/lib/imports/sources/alipay";

const headers = [
  "交易时间",
  "交易分类",
  "交易对方",
  "对方账号",
  "商品说明",
  "收/支",
  "金额",
  "收/付款方式",
  "交易状态",
  "交易订单号",
  "商家订单号",
  "备注",
];

function buildUtf8Csv(rows: string[][], ownerName = "老公") {
  return Buffer.from(
    [
      "------------------------------------------------------------------------------------",
      "导出信息：",
      `姓名：${ownerName}`,
      "支付宝账户：example-alipay-account",
      "------------------------支付宝支付科技有限公司  电子客户回单------------------------",
      [...headers, ""].join(","),
      ...rows.map((row) => [...row, ""].join(",")),
    ].join("\n"),
    "utf8",
  );
}

function normalExpenseRow(overrides: Partial<Record<string, string>> = {}) {
  return [
    overrides.rawOccurredAt ?? "2026-05-07 12:17:13",
    overrides.rawCategory ?? "餐饮美食",
    overrides.rawCounterparty ?? "示例商户",
    overrides.rawCounterpartyAccount ?? "/",
    overrides.rawProduct ?? "示例商户",
    overrides.rawTransactionType ?? "支出",
    overrides.rawAmount ?? "22.85",
    overrides.rawPaymentMethod ?? "示例银行信用卡(0000)&红包",
    overrides.rawStatus ?? "交易成功",
    overrides.rawOrderId ?? "alipay-order-1\t",
    overrides.rawMerchantOrderId ?? "merchant-order-1\t",
    overrides.rawNote ?? "/",
  ];
}

function successfulRefundRow(overrides: Partial<Record<string, string>> = {}) {
  return normalExpenseRow({
    rawAmount: "1.15",
    rawCategory: "退款",
    rawOccurredAt: "2026-05-07 18:17:13",
    rawOrderId: "alipay-refund-order-1\t",
    rawProduct: "退款-示例商品",
    rawStatus: "退款成功",
    rawTransactionType: "不计收支",
    ...overrides,
  });
}

describe("parseAlipayCsv", () => {
  it("parses official CSV-like expense rows with counterparty and product notes", async () => {
    const result = await parseAlipayCsv(
      buildUtf8Csv([
        normalExpenseRow({
          rawCounterparty: "示例交易对方",
          rawNote: "示例账单备注",
          rawProduct: "示例商品",
        }),
      ]),
    );

    expect(result.ownerName).toBe("老公");
    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      amountFen: 2285,
      mappingKey: "alipay|EXPENSE|餐饮美食|",
      occurredAt: new Date("2026-05-07T04:17:13.000Z"),
      occurredAtDate: "2026-05-07",
      occurredAtText: "2026-05-07 12:17:13",
      primaryCategory: "餐饮美食",
      rawCreatedBy: "老公",
      rawCurrency: "CNY",
      rawDate: "2026-05-07 12:17:13",
      rawMember: "老公",
      rawTransactionType: "支出",
      rowNumber: 7,
      secondaryCategory: "示例交易对方",
      sheetName: "支付宝",
      transactionType: TransactionType.EXPENSE,
    });
    expect(result.rows[0]?.note).toBe("交易对方：示例交易对方；商品：示例商品");
    expect(result.rows[0]?.note).not.toContain("示例账单备注");
    expect(result.rows[0]?.sourceFingerprint).toMatch(/^[0-9a-f]{64}$/);
  });

  it("parses UTF-8 income rows and treats unknown non-error statuses as importable", async () => {
    const buffer = buildUtf8Csv([
      normalExpenseRow({
        rawAmount: "88.66",
        rawCategory: "转账红包",
        rawCounterparty: "朋友",
        rawProduct: "红包",
        rawStatus: "新的成功状态",
        rawTransactionType: "收入",
      }),
    ]);

    const result = await parseAlipayCsv(buffer);

    expect(result.invalidRows).toEqual([]);
    expect(result.rows[0]).toMatchObject({
      amountFen: 8866,
      mappingKey: "alipay|INCOME|转账红包|",
      transactionType: TransactionType.INCOME,
    });
  });

  it("uses the Alipay transaction category but not the counterparty for mapping keys", async () => {
    const buffer = buildUtf8Csv([
      normalExpenseRow({ rawCounterparty: "示例商户" }),
      normalExpenseRow({ rawCounterparty: "示例商户B", rawOrderId: "alipay-order-2\t" }),
    ]);

    const result = await parseAlipayCsv(buffer);

    expect(result.invalidRows).toEqual([]);
    expect(result.rows.map((row) => row.mappingKey)).toEqual([
      "alipay|EXPENSE|餐饮美食|",
      "alipay|EXPENSE|餐饮美食|",
    ]);
    expect(result.rows.map((row) => row.secondaryCategory)).toEqual([
      "示例商户",
      "示例商户B",
    ]);
  });

  it("marks non-income-expense transactions and zero amounts as invalid", async () => {
    const buffer = buildUtf8Csv([
      normalExpenseRow({ rawTransactionType: "不计收支" }),
      normalExpenseRow({ rawAmount: "0.00" }),
    ]);

    const result = await parseAlipayCsv(buffer);

    expect(result.rows).toEqual([]);
    expect(result.invalidRows.map((row) => row.reason)).toEqual([
      "Non-income-expense transaction is not importable",
      "Invalid amount",
    ]);
  });

  it("marks refund, closed, and failed statuses as invalid", async () => {
    const buffer = buildUtf8Csv([
      normalExpenseRow({ rawStatus: "交易退款" }),
      normalExpenseRow({ rawStatus: "交易关闭" }),
      normalExpenseRow({ rawStatus: "支付失败" }),
    ]);

    const result = await parseAlipayCsv(buffer);

    expect(result.rows).toEqual([]);
    expect(result.invalidRows.map((row) => row.reason)).toEqual([
      "Refunded or unsuccessful transaction",
      "Refunded or unsuccessful transaction",
      "Refunded or unsuccessful transaction",
    ]);
  });

  it("nets a strict successful refund into its payment regardless of row order", async () => {
    const payment = normalExpenseRow({
      rawAmount: "1.80",
      rawMerchantOrderId: "merchant-refund-partial\t",
    });
    const refund = successfulRefundRow({
      rawMerchantOrderId: "merchant-refund-partial\t",
    });
    const original = await parseAlipayCsv(buildUtf8Csv([payment]));
    const result = await parseAlipayCsv(buildUtf8Csv([refund, payment]));

    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({
      amountFen: 65,
      occurredAtText: "2026-05-07 12:17:13",
      primaryCategory: "餐饮美食",
      refundHandling: "ALIPAY_PARTIAL",
      secondaryCategory: "示例商户",
      transactionType: TransactionType.EXPENSE,
    });
    expect(result.rows[0]?.sourceFingerprint).toBe(original.rows[0]?.sourceFingerprint);
  });

  it("aggregates multiple successful refunds and preserves the original amount for full refunds", async () => {
    const result = await parseAlipayCsv(
      buildUtf8Csv([
        normalExpenseRow({
          rawAmount: "1.80",
          rawMerchantOrderId: "merchant-refund-multiple\t",
          rawOrderId: "payment-multiple\t",
        }),
        successfulRefundRow({
          rawAmount: "0.50",
          rawMerchantOrderId: "merchant-refund-multiple\t",
          rawOrderId: "refund-multiple-1\t",
        }),
        successfulRefundRow({
          rawAmount: "0.65",
          rawMerchantOrderId: "merchant-refund-multiple\t",
          rawOrderId: "refund-multiple-2\t",
        }),
        normalExpenseRow({
          rawAmount: "2.00",
          rawMerchantOrderId: "merchant-refund-full\t",
          rawOrderId: "payment-full\t",
        }),
        successfulRefundRow({
          rawAmount: "2.00",
          rawMerchantOrderId: "merchant-refund-full\t",
          rawOrderId: "refund-full\t",
        }),
      ]),
    );

    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ amountFen: 65, refundHandling: "ALIPAY_PARTIAL" }),
        expect.objectContaining({ amountFen: 200, refundHandling: "ALIPAY_FULL" }),
      ]),
    );
  });

  it("rejects every row in over-refunded and ambiguous payment groups", async () => {
    const result = await parseAlipayCsv(
      buildUtf8Csv([
        normalExpenseRow({
          rawAmount: "1.00",
          rawMerchantOrderId: "merchant-refund-over\t",
          rawOrderId: "payment-over\t",
        }),
        successfulRefundRow({
          rawAmount: "1.01",
          rawMerchantOrderId: "merchant-refund-over\t",
          rawOrderId: "refund-over\t",
        }),
        normalExpenseRow({
          rawMerchantOrderId: "merchant-refund-ambiguous\t",
          rawOrderId: "payment-ambiguous-1\t",
        }),
        normalExpenseRow({
          rawMerchantOrderId: "merchant-refund-ambiguous\t",
          rawOrderId: "payment-ambiguous-2\t",
        }),
        successfulRefundRow({
          rawMerchantOrderId: "merchant-refund-ambiguous\t",
          rawOrderId: "refund-ambiguous\t",
        }),
      ]),
    );

    expect(result.rows).toEqual([]);
    expect(result.invalidRows.map((row) => row.reason)).toEqual([
      "Alipay refund exceeds payment amount",
      "Alipay refund exceeds payment amount",
      "Alipay refund payment is ambiguous",
      "Alipay refund payment is ambiguous",
      "Alipay refund payment is ambiguous",
    ]);
  });

  it("rejects unmatched, missing-order, and invalid successful refund groups without changing unrelated payments", async () => {
    const result = await parseAlipayCsv(
      buildUtf8Csv([
        normalExpenseRow({ rawAmount: "3.00", rawMerchantOrderId: "ordinary-payment\t" }),
        successfulRefundRow({ rawMerchantOrderId: "missing-payment\t" }),
        successfulRefundRow({ rawMerchantOrderId: "" }),
        normalExpenseRow({
          rawAmount: "4.00",
          rawMerchantOrderId: "invalid-refund-data\t",
          rawOrderId: "payment-invalid-refund-data\t",
        }),
        successfulRefundRow({
          rawAmount: "bad",
          rawMerchantOrderId: "invalid-refund-data\t",
          rawOrderId: "refund-invalid-data\t",
        }),
      ]),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.rows[0]).toMatchObject({ amountFen: 300 });
    expect(result.rows[0]?.refundHandling).toBeUndefined();
    expect(result.invalidRows.map((row) => row.reason)).toEqual([
      "Alipay refund payment was not found",
      "Alipay refund merchant order id is missing",
      "Alipay refund group contains invalid data",
      "Alipay refund group contains invalid data",
    ]);
  });

  it("does not net rows that fail any strict successful refund field", async () => {
    const result = await parseAlipayCsv(
      buildUtf8Csv([
        normalExpenseRow({
          rawAmount: "1.80",
          rawMerchantOrderId: "refund-processing\t",
          rawOrderId: "payment-processing\t",
        }),
        successfulRefundRow({
          rawMerchantOrderId: "refund-processing\t",
          rawStatus: "退款处理中",
        }),
        normalExpenseRow({
          rawAmount: "2.80",
          rawMerchantOrderId: "refund-income\t",
          rawOrderId: "payment-income\t",
        }),
        successfulRefundRow({
          rawMerchantOrderId: "refund-income\t",
          rawTransactionType: "收入",
        }),
        normalExpenseRow({
          rawAmount: "3.80",
          rawMerchantOrderId: "refund-category\t",
          rawOrderId: "payment-category\t",
        }),
        successfulRefundRow({
          rawCategory: "其它",
          rawMerchantOrderId: "refund-category\t",
        }),
      ]),
    );

    expect(result.rows.map((row) => row.amountFen)).toEqual([180, 280, 380]);
    expect(result.rows.every((row) => row.refundHandling === undefined)).toBe(true);
    expect(result.invalidRows).toHaveLength(3);
  });

  it("keeps multiple ordinary payments with the same merchant order id", async () => {
    const result = await parseAlipayCsv(
      buildUtf8Csv([
        normalExpenseRow({ rawOrderId: "ordinary-shared-1\t" }),
        normalExpenseRow({ rawOrderId: "ordinary-shared-2\t" }),
      ]),
    );

    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toHaveLength(2);
    expect(result.rows.every((row) => row.amountFen === 2285)).toBe(true);
  });

  it("keeps source fingerprints stable when only the file owner name changes", async () => {
    const row = normalExpenseRow();
    const husbandResult = await parseAlipayCsv(buildUtf8Csv([row], "老公"));
    const wifeResult = await parseAlipayCsv(buildUtf8Csv([row], "老婆"));

    expect(husbandResult.ownerName).toBe("老公");
    expect(wifeResult.ownerName).toBe("老婆");
    expect(husbandResult.rows[0]?.sourceFingerprint).toBe(wifeResult.rows[0]?.sourceFingerprint);
  });

  it("parses quoted CSV fields containing commas", async () => {
    const buffer = buildUtf8Csv([
      normalExpenseRow({
        rawCounterparty: "\"隆江,猪脚饭\"",
        rawProduct: "\"套餐,加饭\"",
      }),
    ]);

    const result = await parseAlipayCsv(buffer);

    expect(result.invalidRows).toEqual([]);
    expect(result.rows[0]?.mappingKey).toBe("alipay|EXPENSE|餐饮美食|");
    expect(result.rows[0]?.note).toBe("交易对方：隆江,猪脚饭；商品：套餐,加饭");
  });

  it("skips non-transaction footer lines after the detail rows", async () => {
    const result = await parseAlipayCsv(
      Buffer.from(
        [
          "姓名：老公",
          [...headers, ""].join(","),
          [...normalExpenseRow(), ""].join(","),
          "------------------------支付宝支付科技有限公司  电子客户回单------------------------",
          "说明：本明细仅供个人对账使用。",
        ].join("\n"),
        "utf8",
      ),
    );

    expect(result.rows).toHaveLength(1);
    expect(result.invalidRows).toEqual([]);
  });

  it("throws for CSV without an Alipay detail header", async () => {
    const buffer = Buffer.from("导出信息：\n交易类型,日期\n", "utf8");

    await expect(parseAlipayCsv(buffer)).rejects.toThrow("无法识别支付宝账单格式");
  });

  it("keeps other requests responsive while grouping 20,000 payment and refund rows", async () => {
    const input = buildUtf8Csv(Array.from({ length: 10_000 }, (_, index) => [
      normalExpenseRow({ rawMerchantOrderId: `merchant-${index}`, rawOrderId: `payment-${index}` }),
      successfulRefundRow({ rawMerchantOrderId: `merchant-${index}`, rawOrderId: `refund-${index}` }),
    ]).flat());
    let anotherRequestRan = false;
    const otherRequest = new Promise<void>((resolve) => setImmediate(() => { anotherRequestRan = true; resolve(); }));
    const result = await parseAlipayCsv(input);
    expect(anotherRequestRan).toBe(true);
    await otherRequest;
    expect(result.invalidRows).toEqual([]);
    expect(result.rows).toHaveLength(10_000);
    expect(result.rows.every(({ amountFen, refundHandling }) => amountFen === 2170 && refundHandling === "ALIPAY_PARTIAL")).toBe(true);
    expect(result.rows[0]).toMatchObject({ rowNumber: 7, occurredAt: new Date("2026-05-07T04:17:13.000Z") });
    expect(result.rows.at(-1)?.rowNumber).toBe(20_005);
  }, 15_000);

  it("observes cancellation during parsing before returning any financial rows", async () => {
    const input = buildUtf8Csv(Array.from({ length: 20_000 }, (_, index) => normalExpenseRow({ rawOrderId: `cancel-${index}` })));
    const controller = new AbortController();
    setImmediate(() => controller.abort());
    await expect(parseAlipayCsv(input, controller.signal)).rejects.toThrow("xlsx-timeout");
  });

  it("rejects an already cancelled CSV admission and bounds direct parser input", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(parseAlipayCsv(buildUtf8Csv([normalExpenseRow()]), controller.signal)).rejects.toThrow("xlsx-timeout");
    await expect(parseAlipayCsv(Buffer.alloc(20 * 1024 * 1024 + 1))).rejects.toThrow("Import file is too large");
  });

  it("stops actual parsing at its 30-second deadline instead of returning partial results", async () => {
    let now = 0;
    const clock = vi.spyOn(performance, "now").mockImplementation(() => now);
    const input = buildUtf8Csv([normalExpenseRow()]);
    setImmediate(() => { now = 30_000; });
    try {
      await expect(parseAlipayCsv(input)).rejects.toThrow("xlsx-timeout");
    } finally { clock.mockRestore(); }
  });

  it("bounds pathological CSV shapes before allocating unlimited row or column arrays", async () => {
    await expect(parseAlipayCsv(Buffer.from(",".repeat(100_000)))).rejects.toThrow("xlsx-resource-limit");
    await expect(parseAlipayCsv(Buffer.from("\n".repeat(25_001)))).rejects.toThrow("xlsx-resource-limit");
  });
});
