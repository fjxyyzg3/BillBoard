import type { TransactionType } from "@prisma/client";

export const SUI_SHOU_JI_SOURCE = "sui_shou_ji" as const;
export const WECHAT_PAY_SOURCE = "wechat_pay" as const;

export type ImportSource = typeof SUI_SHOU_JI_SOURCE | typeof WECHAT_PAY_SOURCE;

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
  mappingKey: string;
  note: string;
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
