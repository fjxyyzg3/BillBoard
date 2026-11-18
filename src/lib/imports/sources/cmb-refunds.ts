import { TransactionType } from "@prisma/client";

import {
  CMB_FULLY_REFUNDED,
  CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
  type CMB_REFUND_MANUAL_REASONS,
  type ParsedImportRow,
} from "../types";

export type CmbInvalidPayment = {
  occurredAtDate: string | null;
  primaryCategory: string;
  rawCurrency: string;
  secondaryCategory: string;
};

type ManualReason = typeof CMB_REFUND_MANUAL_REASONS[number];

type PaymentState = {
  remainingAmountFen: number;
  refundFingerprints: Set<string>;
  row: ParsedImportRow;
};

type PaymentGroup = {
  invalidDates: Array<string | null>;
  payments: PaymentState[];
};

type Refund = {
  groupKey: string | null;
  row: ParsedImportRow;
};

function normalizePdfText(value: string) {
  return value.normalize("NFKC").replace(/\s+/gu, "");
}

function isPaymentSummary(value: string) {
  return value === "快捷支付" || value === "银联快捷支付";
}

function paymentGroupKey(currency: string, counterparty: string) {
  const merchant = normalizePdfText(counterparty);
  return merchant ? JSON.stringify([currency, merchant]) : null;
}

// The caller validates that all rows belong to one PDF and one bank account.
export function applyCmbRefunds(
  rows: ParsedImportRow[],
  invalidPayments: CmbInvalidPayment[] = [],
): ParsedImportRow[] {
  const groups = new Map<string, PaymentGroup>();
  const paymentStates = new Map<ParsedImportRow, PaymentState>();
  const refundRows = new Set<ParsedImportRow>();
  const refundsByFingerprint = new Map<string, Refund>();
  const consumedRefunds = new Set<string>();
  const manualReasons = new Map<string, ManualReason>();

  function groupFor(key: string) {
    let group = groups.get(key);
    if (!group) {
      group = { invalidDates: [], payments: [] };
      groups.set(key, group);
    }
    return group;
  }

  for (const row of rows) {
    const summary = normalizePdfText(row.primaryCategory);
    if (row.transactionType === TransactionType.EXPENSE && isPaymentSummary(summary)) {
      const key = paymentGroupKey(row.rawCurrency, row.secondaryCategory);
      if (key) {
        const state = { remainingAmountFen: row.amountFen, refundFingerprints: new Set<string>(), row };
        groupFor(key).payments.push(state);
        paymentStates.set(row, state);
      }
    } else if (row.transactionType === TransactionType.INCOME && summary === "快捷退款") {
      refundRows.add(row);
      if (!refundsByFingerprint.has(row.sourceFingerprint)) {
        refundsByFingerprint.set(row.sourceFingerprint, {
          groupKey: paymentGroupKey(row.rawCurrency, row.secondaryCategory),
          row,
        });
      }
    }
  }

  for (const invalid of invalidPayments) {
    if (!isPaymentSummary(normalizePdfText(invalid.primaryCategory))) {
      continue;
    }
    const key = paymentGroupKey(invalid.rawCurrency, invalid.secondaryCategory);
    if (key) {
      groupFor(key).invalidDates.push(invalid.occurredAtDate);
    }
  }

  const refundsByDate = new Map<string, Refund[]>();
  for (const refund of refundsByFingerprint.values()) {
    const batch = refundsByDate.get(refund.row.occurredAtDate) ?? [];
    batch.push(refund);
    refundsByDate.set(refund.row.occurredAtDate, batch);
  }

  for (const [date, batch] of [...refundsByDate].sort(([left], [right]) => left.localeCompare(right))) {
    const assignedRefunds = new Map<PaymentState, ParsedImportRow[]>();

    // Resolve the entire day's candidates before reducing any payment's capacity.
    for (const refund of batch) {
      const group = refund.groupKey ? groups.get(refund.groupKey) : undefined;
      const fingerprint = refund.row.sourceFingerprint;
      if (group?.invalidDates.some((invalidDate) => invalidDate === null || invalidDate <= date)) {
        manualReasons.set(fingerprint, CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT);
        continue;
      }
      const earlierPayments = group?.payments.filter((payment) => payment.row.occurredAtDate <= date) ?? [];
      const candidates = earlierPayments.filter((payment) => payment.remainingAmountFen >= refund.row.amountFen);
      if (candidates.length === 0) {
        manualReasons.set(fingerprint, earlierPayments.some((payment) => payment.remainingAmountFen > 0)
          ? "CMB_REFUND_EXCEEDS_PAYMENT"
          : "CMB_REFUND_PAYMENT_NOT_FOUND");
        continue;
      }
      if (candidates.length > 1) {
        manualReasons.set(fingerprint, "CMB_REFUND_PAYMENT_AMBIGUOUS");
        continue;
      }
      const payment = candidates[0];
      if (payment.row.occurredAtDate === date) {
        manualReasons.set(fingerprint, "CMB_REFUND_SAME_DAY");
        continue;
      }
      const assigned = assignedRefunds.get(payment) ?? [];
      assigned.push(refund.row);
      assignedRefunds.set(payment, assigned);
    }

    for (const [payment, assigned] of assignedRefunds) {
      let totalRefundFen = 0;
      let exceedsPayment = false;
      for (const refund of assigned) {
        if (refund.amountFen > payment.remainingAmountFen - totalRefundFen) {
          exceedsPayment = true;
          break;
        }
        totalRefundFen += refund.amountFen;
      }
      if (exceedsPayment) {
        for (const refund of assigned) {
          manualReasons.set(refund.sourceFingerprint, "CMB_REFUND_EXCEEDS_PAYMENT");
        }
        continue;
      }
      payment.remainingAmountFen -= totalRefundFen;
      for (const refund of assigned) {
        consumedRefunds.add(refund.sourceFingerprint);
        payment.refundFingerprints.add(refund.sourceFingerprint);
      }
    }
  }

  return rows.flatMap((row) => {
    if (refundRows.has(row)) {
      if (consumedRefunds.has(row.sourceFingerprint)) {
        return [];
      }
      return [{ ...row, defaultSkipReason: manualReasons.get(row.sourceFingerprint), refundHandling: "CMB_MANUAL" as const }];
    }
    const payment = paymentStates.get(row);
    if (!payment?.refundFingerprints.size) {
      return [row];
    }
    const fullyRefunded = payment.remainingAmountFen === 0;
    return [{
      ...row,
      amountFen: fullyRefunded ? row.amountFen : payment.remainingAmountFen,
      ...(fullyRefunded ? { defaultSkipReason: CMB_FULLY_REFUNDED } : {}),
      refundHandling: fullyRefunded ? "CMB_FULL" as const : "CMB_PARTIAL" as const,
      refundOriginalAmountFen: row.amountFen,
      refundSourceFingerprints: [...payment.refundFingerprints].sort(),
    }];
  });
}
