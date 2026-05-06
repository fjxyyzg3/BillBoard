import { createHash } from "node:crypto";

import type { ImportedRawFingerprintInput } from "./types";

function normalizeFingerprintPart(value: string): string {
  return String(value).trim();
}

export function createSourceFingerprint(input: ImportedRawFingerprintInput): string {
  const payload = [
    input.source,
    input.transactionType,
    input.occurredAtText,
    input.amountText,
    input.memberName,
    input.createdByName,
    input.primaryCategory,
    input.secondaryCategory,
    input.rawAccount,
    input.rawMerchant,
    input.rawCurrency,
    input.note,
  ].map(normalizeFingerprintPart);

  return createHash("sha256").update(JSON.stringify(payload)).digest("hex");
}
