import { TransactionType } from "@prisma/client";
import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";

import { applyCmbRefunds, type CmbInvalidPayment } from "@/lib/imports/sources/cmb-refunds";
import {
  CMB_FULLY_REFUNDED,
  CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
  type ParsedImportRow,
} from "@/lib/imports/types";

function payment(overrides: Partial<ParsedImportRow> = {}): ParsedImportRow {
  const amountFen = overrides.amountFen ?? 10_000;
  const date = overrides.occurredAtDate ?? "2026-04-01";
  const primaryCategory = overrides.primaryCategory ?? "快捷支付";
  const secondaryCategory = overrides.secondaryCategory ?? "测试商户 A";
  const rowNumber = overrides.rowNumber ?? 1;

  return {
    amountFen,
    mappingKey: `cmb|EXPENSE|${primaryCategory}|${secondaryCategory}`,
    note: `招商银行：${primaryCategory}；对手信息：${secondaryCategory}`,
    occurredAt: new Date(`${date}T00:00:00+08:00`),
    occurredAtDate: date,
    occurredAtText: date,
    primaryCategory,
    rawAmount: `-${(amountFen / 100).toFixed(2)}`,
    rawCreatedBy: "示例户名",
    rawCurrency: "CNY",
    rawDate: date,
    rawMember: "示例户名",
    rawTransactionType: "支出",
    rowNumber,
    secondaryCategory,
    sheetName: "招商银行",
    sourceFingerprint: createHash("sha256").update(`synthetic-payment-${rowNumber}`).digest("hex"),
    transactionType: TransactionType.EXPENSE,
    ...overrides,
  };
}

function refund(overrides: Partial<ParsedImportRow> = {}): ParsedImportRow {
  const result = payment({
    amountFen: 2_500,
    occurredAtDate: "2026-04-02",
    primaryCategory: "快捷退款",
    rowNumber: 2,
    transactionType: TransactionType.INCOME,
    ...overrides,
  });

  return {
    ...result,
    mappingKey: `cmb|INCOME|${result.primaryCategory}|${result.secondaryCategory}`,
    rawAmount: `+${(result.amountFen / 100).toFixed(2)}`,
    rawTransactionType: "收入",
    sourceFingerprint: overrides.sourceFingerprint ?? createHash("sha256")
      .update(`synthetic-refund-${result.rowNumber}`)
      .digest("hex"),
  };
}

function invalidPayment(overrides: Partial<CmbInvalidPayment> = {}): CmbInvalidPayment {
  return {
    occurredAtDate: null,
    primaryCategory: "快捷支付",
    rawCurrency: "CNY",
    secondaryCategory: "测试商户 A",
    ...overrides,
  };
}

function expectManual(row: ParsedImportRow, reason: string) {
  expect(row).toMatchObject({ defaultSkipReason: reason, refundHandling: "CMB_MANUAL" });
}

describe("CMB refund matching", () => {
  it("nets a unique earlier payment while preserving its date, category, note, and fingerprint", () => {
    const original = payment();
    const returned = refund();
    const result = applyCmbRefunds([returned, original]);

    expect(result).toEqual([{
      ...original,
      amountFen: 7_500,
      refundHandling: "CMB_PARTIAL",
      refundOriginalAmountFen: 10_000,
      refundSourceFingerprints: [returned.sourceFingerprint],
    }]);
    expect(original.amountFen).toBe(10_000);
    expect(original.refundHandling).toBeUndefined();
  });

  it("retains the original amount and skips a fully refunded payment", () => {
    const original = payment();
    const returned = refund({ amountFen: 10_000 });

    expect(applyCmbRefunds([original, returned])).toEqual([{
      ...original,
      defaultSkipReason: CMB_FULLY_REFUNDED,
      refundHandling: "CMB_FULL",
      refundOriginalAmountFen: 10_000,
      refundSourceFingerprints: [returned.sourceFingerprint],
    }]);
  });

  it("accumulates distinct refunds across days and sorts their fingerprints", () => {
    const original = payment();
    const first = refund({ amountFen: 3_000, sourceFingerprint: "z".repeat(64) });
    const second = refund({ amountFen: 2_000, occurredAtDate: "2026-04-03", rowNumber: 3, sourceFingerprint: "a".repeat(64) });

    expect(applyCmbRefunds([second, original, first])).toEqual([{
      ...original,
      amountFen: 5_000,
      refundHandling: "CMB_PARTIAL",
      refundOriginalAmountFen: 10_000,
      refundSourceFingerprints: [second.sourceFingerprint, first.sourceFingerprint],
    }]);
  });

  it("counts repeated refund fingerprints once but counts distinct same-day equal refunds separately", () => {
    const first = refund({ amountFen: 3_000 });
    const second = refund({ amountFen: 3_000, rowNumber: 3 });
    const duplicate = { ...first, rowNumber: 4 };
    const result = applyCmbRefunds([payment(), first, second, duplicate]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      amountFen: 4_000,
      refundHandling: "CMB_PARTIAL",
      refundOriginalAmountFen: 10_000,
      refundSourceFingerprints: [first.sourceFingerprint, second.sourceFingerprint].sort(),
    });
  });

  it("does not prefer an exact amount when a larger eligible payment also exists", () => {
    const first = payment();
    const second = payment({ amountFen: 15_000, rowNumber: 2 });
    const returned = refund({ amountFen: 10_000, rowNumber: 3 });
    const result = applyCmbRefunds([first, second, returned]);

    expect(result.slice(0, 2)).toEqual([first, second]);
    expectManual(result[2], "CMB_REFUND_PAYMENT_AMBIGUOUS");
  });

  it("requires a strictly earlier date even when a same-day payment is adjacent", () => {
    const original = payment({ occurredAtDate: "2026-04-02" });
    const result = applyCmbRefunds([original, refund()]);

    expect(result[0]).toEqual(original);
    expectManual(result[1], "CMB_REFUND_SAME_DAY");
  });

  it("includes a same-day payment when deciding whether an earlier candidate is unique", () => {
    const earlier = payment();
    const sameDay = payment({ occurredAtDate: "2026-04-02", rowNumber: 2 });
    const result = applyCmbRefunds([earlier, sameDay, refund({ rowNumber: 3 })]);

    expect(result.slice(0, 2)).toEqual([earlier, sameDay]);
    expectManual(result[2], "CMB_REFUND_PAYMENT_AMBIGUOUS");
  });

  it.each([false, true])("takes one candidate snapshot for a day's refunds (reversed: %s)", (reverse) => {
    const larger = payment();
    const smaller = payment({ amountFen: 5_000, rowNumber: 2 });
    const full = refund({ amountFen: 10_000, rowNumber: 3 });
    const ambiguous = refund({ amountFen: 5_000, rowNumber: 4 });
    const batch = reverse ? [ambiguous, full] : [full, ambiguous];
    const result = applyCmbRefunds([larger, smaller, ...batch]);

    expect(result).toHaveLength(3);
    expect(result[0]).toMatchObject({ amountFen: 10_000, refundHandling: "CMB_FULL" });
    expect(result[1]).toEqual(smaller);
    expectManual(result[2], "CMB_REFUND_PAYMENT_AMBIGUOUS");
  });

  it.each([false, true])("rejects every refund assigned to an over-limit daily batch (reversed: %s)", (reverse) => {
    const original = payment();
    const first = refund({ amountFen: 6_000 });
    const second = refund({ amountFen: 6_000, rowNumber: 3 });
    const batch = reverse ? [second, first] : [first, second];
    const result = applyCmbRefunds([original, ...batch]);

    expect(result[0]).toEqual(original);
    expect(result).toHaveLength(3);
    for (const returned of result.slice(1)) {
      expectManual(returned, "CMB_REFUND_EXCEEDS_PAYMENT");
    }
  });

  it("excludes a fully refunded payment from later candidates", () => {
    const original = payment();
    const full = refund({ amountFen: 10_000 });
    const later = refund({ occurredAtDate: "2026-04-03", rowNumber: 3 });
    const result = applyCmbRefunds([original, full, later]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ refundHandling: "CMB_FULL" });
    expectManual(result[1], "CMB_REFUND_PAYMENT_NOT_FOUND");
  });

  it("allows a later unique payment after an older payment has been fully refunded", () => {
    const original = payment();
    const full = refund({ amountFen: 10_000 });
    const newer = payment({ occurredAtDate: "2026-04-03", rowNumber: 3 });
    const later = refund({ occurredAtDate: "2026-04-04", rowNumber: 4 });
    const result = applyCmbRefunds([original, full, newer, later]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ refundHandling: "CMB_FULL" });
    expect(result[1]).toMatchObject({ amountFen: 7_500, refundHandling: "CMB_PARTIAL", sourceFingerprint: newer.sourceFingerprint });
  });

  it("uses the remaining amount rather than the original amount to find unique candidates", () => {
    const smaller = payment();
    const larger = payment({ amountFen: 20_000, rowNumber: 2 });
    const first = refund({ amountFen: 15_000, rowNumber: 3 });
    const later = refund({ amountFen: 7_500, occurredAtDate: "2026-04-03", rowNumber: 4 });
    const result = applyCmbRefunds([smaller, larger, first, later]);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({ amountFen: 2_500, refundSourceFingerprints: [later.sourceFingerprint] });
    expect(result[1]).toMatchObject({ amountFen: 5_000, refundSourceFingerprints: [first.sourceFingerprint] });
  });

  it("keeps unmatched and future-payment refunds for manual handling", () => {
    const original = payment({ occurredAtDate: "2026-04-03" });
    const result = applyCmbRefunds([original, refund()]);

    expect(result[0]).toEqual(original);
    expectManual(result[1], "CMB_REFUND_PAYMENT_NOT_FOUND");
    expectManual(applyCmbRefunds([refund()])[0], "CMB_REFUND_PAYMENT_NOT_FOUND");
  });

  it("reports a refund larger than every matching payment as exceeding capacity", () => {
    const result = applyCmbRefunds([payment(), refund({ amountFen: 12_000 })]);

    expect(result[0]).toEqual(payment());
    expectManual(result[1], "CMB_REFUND_EXCEEDS_PAYMENT");
  });

  it("retains an earlier partial refund when a later refund exceeds the remainder", () => {
    const first = refund({ amountFen: 7_000 });
    const later = refund({ amountFen: 4_000, occurredAtDate: "2026-04-03", rowNumber: 3 });
    const result = applyCmbRefunds([payment(), first, later]);

    expect(result[0]).toMatchObject({ amountFen: 3_000, refundSourceFingerprints: [first.sourceFingerprint] });
    expectManual(result[1], "CMB_REFUND_EXCEEDS_PAYMENT");
  });

  it("allows UnionPay quick payments and counts them when checking ambiguity", () => {
    const unionPay = payment({ primaryCategory: "银联快捷支付", rowNumber: 2 });

    expect(applyCmbRefunds([unionPay, refund()])[0]).toMatchObject({ amountFen: 7_500, primaryCategory: "银联快捷支付" });
    const result = applyCmbRefunds([payment(), unionPay, refund({ rowNumber: 3 })]);
    expectManual(result[2], "CMB_REFUND_PAYMENT_AMBIGUOUS");
  });

  it("matches complete non-empty counterparties after NFKC and PDF whitespace normalization", () => {
    const original = payment({ secondaryCategory: "Ｔｅｓｔ 商\n户Ａ" });
    const returned = refund({ secondaryCategory: "Test商户A" });

    expect(applyCmbRefunds([original, returned])[0]).toMatchObject({ amountFen: 7_500, secondaryCategory: original.secondaryCategory });
  });

  it.each([
    { paymentMerchant: "测试商户 A 分店", refundMerchant: "测试商户 A" },
    { paymentMerchant: "", refundMerchant: "" },
    { paymentMerchant: "测试商户 B", refundMerchant: "测试商户 A" },
  ])("does not match incomplete or different merchants: $paymentMerchant", ({ paymentMerchant, refundMerchant }) => {
    const original = payment({ secondaryCategory: paymentMerchant });
    const result = applyCmbRefunds([original, refund({ secondaryCategory: refundMerchant })]);

    expect(result[0]).toEqual(original);
    expectManual(result[1], "CMB_REFUND_PAYMENT_NOT_FOUND");
  });

  it("does not match payments in a different currency", () => {
    const original = payment({ rawCurrency: "USD" });
    const result = applyCmbRefunds([original, refund()]);

    expect(result[0]).toEqual(original);
    expectManual(result[1], "CMB_REFUND_PAYMENT_NOT_FOUND");
  });

  it("requires the exact payment and refund types and signs", () => {
    const unrelated = [
      payment({ primaryCategory: "转账汇款" }),
      payment({ primaryCategory: "快捷支付", transactionType: TransactionType.INCOME, rowNumber: 2 }),
      refund({ primaryCategory: "普通退款", rowNumber: 3 }),
      refund({ transactionType: TransactionType.EXPENSE, rowNumber: 4 }),
    ];

    expect(applyCmbRefunds(unrelated)).toEqual(unrelated);
  });

  it.each([null, "2026-04-01"])("blocks automatic matching when a related invalid payment may be eligible (%s)", (date) => {
    const original = payment();
    const result = applyCmbRefunds([original, refund()], [invalidPayment({ occurredAtDate: date })]);

    expect(result[0]).toEqual(original);
    expectManual(result[1], CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT);
  });

  it.each([
    { secondaryCategory: "测试商户 B" },
    { rawCurrency: "USD" },
    { occurredAtDate: "2026-04-03" },
    { primaryCategory: "转账汇款" },
  ])("does not let an unrelated invalid payment block a valid match (%j)", (overrides) => {
    const result = applyCmbRefunds([payment(), refund()], [invalidPayment(overrides)]);

    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ amountFen: 7_500, refundHandling: "CMB_PARTIAL" });
  });
});
