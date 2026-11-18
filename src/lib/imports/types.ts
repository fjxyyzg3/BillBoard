import type { TransactionType } from "@prisma/client";

export const SUI_SHOU_JI_SOURCE = "sui_shou_ji" as const;
export const WECHAT_PAY_SOURCE = "wechat_pay" as const;
export const ALIPAY_SOURCE = "alipay" as const;
export const CATEGORY_MAPPING_IGNORED = "CATEGORY_MAPPING_IGNORED" as const;
export const ALIPAY_FULLY_REFUNDED = "ALIPAY_FULLY_REFUNDED" as const;
export const ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT =
  "ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT" as const;
export const WECHAT_FULLY_REFUNDED = "WECHAT_FULLY_REFUNDED" as const;
export const WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT =
  "WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT" as const;
export const CMB_SOURCE = "cmb" as const;
export const CMB_FULLY_REFUNDED = "CMB_FULLY_REFUNDED" as const;
export const CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT =
  "CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT" as const;
export const CMB_REFUND_MANUAL_REASONS = [
  CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
  "CMB_REFUND_PAYMENT_NOT_FOUND",
  "CMB_REFUND_PAYMENT_AMBIGUOUS",
  "CMB_REFUND_SAME_DAY",
  "CMB_REFUND_EXCEEDS_PAYMENT",
] as const;

export type ImportSource =
  | typeof SUI_SHOU_JI_SOURCE
  | typeof WECHAT_PAY_SOURCE
  | typeof ALIPAY_SOURCE
  | typeof CMB_SOURCE;

export type HouseholdMemberOption = {
  id: string;
  memberName: string;
};

export type ImportedRawFingerprintInput = {
  amountText: string;
  createdByName: string;
  memberName: string;
  note: string;
  occurredAtText: string;
  primaryCategory: string;
  rawAccount: string;
  rawCurrency: string;
  rawMerchant: string;
  secondaryCategory: string;
  source: ImportSource;
  transactionType: TransactionType;
};

export type ParsedImportRow = {
  amountFen: number;
  defaultSkipReason?: string;
  mappingKey: string;
  note: string | null;
  occurredAt: Date;
  occurredAtDate: string;
  occurredAtText: string;
  primaryCategory: string;
  rawAmount: string;
  rawCreatedBy: string;
  rawCurrency: string;
  rawDate: string;
  rawMember: string;
  rawTransactionType: string;
  refundHandling?:
    | "ALIPAY_PARTIAL"
    | "ALIPAY_FULL"
    | "WECHAT_PARTIAL"
    | "WECHAT_FULL"
    | "WECHAT_MANUAL"
    | "CMB_PARTIAL"
    | "CMB_FULL"
    | "CMB_MANUAL";
  refundOriginalAmountFen?: number;
  refundSourceFingerprints?: string[];
  rowNumber: number;
  secondaryCategory: string;
  sheetName: string;
  sourceFingerprint: string;
  transactionType: TransactionType;
};

export type InvalidImportRow = {
  rawAmount?: string;
  rawCreatedBy?: string;
  rawCurrency?: string;
  rawDate?: string;
  rawMember?: string;
  rawTransactionType?: string;
  reason: string;
  rowNumber?: number;
  sheetName?: string;
};

export type ParsedImportWorkbook = {
  invalidRows: InvalidImportRow[];
  ownerName?: string;
  rows: ParsedImportRow[];
};
