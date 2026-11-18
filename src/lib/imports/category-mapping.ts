import type { TransactionType } from "@prisma/client";

import type { ImportSource } from "./types";

export function normalizeImportedCategory(value: string | null | undefined): string {
  return String(value ?? "").trim();
}

export function buildImportCategoryMappingKey(input: {
  primaryCategory: string | null | undefined;
  secondaryCategory: string | null | undefined;
  source: ImportSource;
  transactionType: TransactionType;
}): string {
  return [
    input.source,
    input.transactionType,
    normalizeImportedCategory(input.primaryCategory),
    normalizeImportedCategory(input.secondaryCategory),
  ].join("|");
}
