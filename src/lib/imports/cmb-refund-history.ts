import {
  ImportDraftRowStatus,
  ImportDraftStatus,
  ImportRowDecision,
  type Prisma,
  TransactionType,
} from "@prisma/client";
import { Buffer } from "node:buffer";
import { MAX_FINANCIAL_SCAN_BYTES, scanImportTransactions } from "@/lib/encryption/financial-queries";
import { isEncryptedRequest } from "@/lib/encryption/request-context";
import { EncryptionRequestError } from "@/lib/encryption/types";

import {
  CMB_FULLY_REFUNDED,
  CMB_REFUND_MANUAL_REASONS,
  CMB_SOURCE,
} from "@/lib/imports/types";

type CmbHistoryRow = {
  amountFen: number | null;
  primaryCategory: string | null;
  refundOriginalAmountFen?: number | null;
  refundSourceFingerprints?: string[];
  skipReason?: string | null;
  sourceFingerprint: string | null;
  transactionType: TransactionType | null;
};

export type CmbRefundHistoryOutcome = "NONE" | "SOURCE_DUPLICATE" | "MANUAL_ADJUSTMENT";

type RefundClaim = {
  amountFen: number | null;
  id: string;
  refundOriginalAmountFen: number | null;
  refundSourceFingerprints: string[];
  skipReason: string | null;
  sourceFingerprint: string | null;
};
type HistoryClient = Pick<Prisma.TransactionClient, "transaction" | "importDraft" | "importDraftRow">;

function hasRefundMetadata(row: CmbHistoryRow) {
  return row.refundOriginalAmountFen != null || (row.refundSourceFingerprints?.length ?? 0) > 0;
}

function isManualReason(reason: string | null | undefined) {
  return CMB_REFUND_MANUAL_REASONS.some((value) => value === reason);
}

function netAmount(row: Pick<CmbHistoryRow, "amountFen" | "skipReason">) {
  return row.skipReason === CMB_FULLY_REFUNDED ? 0 : row.amountFen;
}

function validRefundMetadata(row: CmbHistoryRow, refundSet: ReadonlySet<string>) {
  const refunds = row.refundSourceFingerprints ?? [];
  const original = row.refundOriginalAmountFen;
  const net = netAmount(row);

  return row.transactionType === TransactionType.EXPENSE &&
    typeof original === "number" && Number.isSafeInteger(original) && original > 0 &&
    typeof row.amountFen === "number" && Number.isSafeInteger(row.amountFen) && row.amountFen > 0 &&
    typeof net === "number" && net >= 0 && net < original &&
    (net !== 0 || row.amountFen === original) &&
    Boolean(row.sourceFingerprint?.match(/^[a-f0-9]{64}$/)) && refunds.length > 0 &&
    refundSet.size === refunds.length &&
    refunds.every((value) => /^[a-f0-9]{64}$/.test(value) && value !== row.sourceFingerprint);
}

function matchesClaim(row: CmbHistoryRow, claim: RefundClaim, refunds: ReadonlySet<string>) {
  return claim.sourceFingerprint === row.sourceFingerprint &&
    claim.refundOriginalAmountFen === row.refundOriginalAmountFen &&
    netAmount(claim) === netAmount(row) &&
    claim.refundSourceFingerprints.length === refunds.size &&
    claim.refundSourceFingerprints.every((value) => refunds.has(value));
}

async function loadEncryptedHistory(
  client: HistoryClient,
  householdId: string,
  fingerprints: Set<string>,
  transactions: Map<string, { amountFen: number; type: TransactionType }>,
  claims: Map<string, RefundClaim>,
) {
  if (fingerprints.size === 0) return;
  for await (const transaction of scanImportTransactions(client, { householdId })) {
    if (transaction.source === CMB_SOURCE && transaction.sourceFingerprint && fingerprints.has(transaction.sourceFingerprint)) {
      transactions.set(transaction.sourceFingerprint, transaction);
    }
  }
  let afterDraftId: string | undefined;
  let byteCount = 0;
  while (true) {
    const drafts = await client.importDraft.findMany({
      where: { householdId, status: ImportDraftStatus.COMPLETED, ...(afterDraftId ? { id: { gt: afterDraftId } } : {}) },
      orderBy: { id: "asc" }, take: 500, select: { id: true, source: true },
    });
    byteCount += Buffer.byteLength(JSON.stringify(drafts), "utf8");
    if (byteCount > MAX_FINANCIAL_SCAN_BYTES) throw new EncryptionRequestError("ENCRYPTION_BUDGET");
    const draftIds = drafts.filter((draft) => draft.source === CMB_SOURCE).map((draft) => draft.id);
    if (draftIds.length > 0) {
      let afterRowId: string | undefined;
      while (true) {
        const rows = await client.importDraftRow.findMany({
          where: {
            draftId: { in: draftIds }, ...(afterRowId ? { id: { gt: afterRowId } } : {}),
            OR: [
              { status: { in: [ImportDraftRowStatus.READY, ImportDraftRowStatus.POSSIBLE_DUPLICATE] }, userDecision: ImportRowDecision.KEEP },
              { status: ImportDraftRowStatus.USER_SKIPPED, userDecision: ImportRowDecision.SKIP },
            ],
          },
          orderBy: { id: "asc" }, take: 500,
          select: { id: true, amountFen: true, refundOriginalAmountFen: true, refundSourceFingerprints: true, skipReason: true, sourceFingerprint: true, status: true },
        });
        byteCount += Buffer.byteLength(JSON.stringify(rows), "utf8");
        if (byteCount > MAX_FINANCIAL_SCAN_BYTES) throw new EncryptionRequestError("ENCRYPTION_BUDGET");
        for (const row of rows) {
          if (row.refundOriginalAmountFen === null || row.refundSourceFingerprints.length === 0 ||
            (row.status === ImportDraftRowStatus.USER_SKIPPED && row.skipReason !== CMB_FULLY_REFUNDED) ||
            (!row.sourceFingerprint || !fingerprints.has(row.sourceFingerprint)) && !row.refundSourceFingerprints.some((value) => fingerprints.has(value))) continue;
          claims.set(row.id, row);
        }
        if (rows.length < 500) break;
        afterRowId = rows[rows.length - 1].id;
      }
    }
    if (drafts.length < 500) return;
    afterDraftId = drafts[drafts.length - 1].id;
  }
}

// Completed refund drafts are durable consumption records, including full refunds
// that never created a transaction. Soft-deleted transactions still participate.
export async function classifyCmbRefundHistory(
  client: HistoryClient,
  householdId: string,
  rows: CmbHistoryRow[],
): Promise<CmbRefundHistoryOutcome[]> {
  const fingerprints = Array.from(new Set(rows.flatMap((row) => [
    ...(row.sourceFingerprint ? [row.sourceFingerprint] : []),
    ...(row.refundSourceFingerprints ?? []),
  ])));
  const transactions = new Map<string, { amountFen: number; type: TransactionType }>();
  const claims = new Map<string, RefundClaim>();

  if (isEncryptedRequest()) await loadEncryptedHistory(client, householdId, new Set(fingerprints), transactions, claims);
  else for (let offset = 0; offset < fingerprints.length; offset += 500) {
    const chunk = fingerprints.slice(offset, offset + 500);
    const [transactionRows, claimRows] = await Promise.all([
      client.transaction.findMany({
        where: { householdId, source: CMB_SOURCE, sourceFingerprint: { in: chunk } },
        select: { amountFen: true, sourceFingerprint: true, type: true },
      }),
      client.importDraftRow.findMany({
        where: {
          draft: { householdId, source: CMB_SOURCE, status: ImportDraftStatus.COMPLETED },
          refundOriginalAmountFen: { not: null },
          refundSourceFingerprints: { isEmpty: false },
          AND: [
            { OR: [
              { sourceFingerprint: { in: chunk } },
              { refundSourceFingerprints: { hasSome: chunk } },
            ] },
            { OR: [
              {
                status: { in: [ImportDraftRowStatus.READY, ImportDraftRowStatus.POSSIBLE_DUPLICATE] },
                userDecision: ImportRowDecision.KEEP,
              },
              {
                status: ImportDraftRowStatus.USER_SKIPPED,
                userDecision: ImportRowDecision.SKIP,
                skipReason: CMB_FULLY_REFUNDED,
              },
            ] },
          ],
        },
        select: {
          amountFen: true,
          id: true,
          refundOriginalAmountFen: true,
          refundSourceFingerprints: true,
          skipReason: true,
          sourceFingerprint: true,
        },
      }),
    ]);

    for (const transaction of transactionRows) {
      if (transaction.sourceFingerprint) transactions.set(transaction.sourceFingerprint, transaction);
    }
    for (const claim of claimRows) claims.set(claim.id, claim);
  }

  const claimsByFingerprint = new Map<string, RefundClaim[]>();
  for (const claim of claims.values()) {
    for (const value of [claim.sourceFingerprint, ...claim.refundSourceFingerprints]) {
      if (!value) continue;
      const existing = claimsByFingerprint.get(value) ?? [];
      existing.push(claim);
      claimsByFingerprint.set(value, existing);
    }
  }

  const outcomes = rows.map((row): CmbRefundHistoryOutcome => {
    const fingerprint = row.sourceFingerprint;
    if (!fingerprint) return hasRefundMetadata(row) ? "MANUAL_ADJUSTMENT" : "NONE";
    const transaction = transactions.get(fingerprint);
    const relatedClaims = claimsByFingerprint.get(fingerprint) ?? [];

    if (!hasRefundMetadata(row)) {
      if (transaction || relatedClaims.length > 0) return "SOURCE_DUPLICATE";
      // Pending drafts from before refund support must not import refunds as income.
      return row.transactionType === TransactionType.INCOME &&
        row.primaryCategory?.replace(/\s+/g, "") === "快捷退款" && !isManualReason(row.skipReason)
        ? "MANUAL_ADJUSTMENT" : "NONE";
    }

    const refunds = row.refundSourceFingerprints ?? [];
    const refundSet = new Set(refunds);
    if (!validRefundMetadata(row, refundSet)) return "MANUAL_ADJUSTMENT";
    const refundClaims = refunds.flatMap((value) => claimsByFingerprint.get(value) ?? []);
    const allClaims = new Map([...relatedClaims, ...refundClaims].map((claim) => [claim.id, claim]));

    if (refunds.some((value) => transactions.has(value)) ||
      Array.from(allClaims.values()).some((claim) => !matchesClaim(row, claim, refundSet))) {
      return "MANUAL_ADJUSTMENT";
    }
    if (relatedClaims.length > 0) {
      return transaction && (transaction.amountFen !== netAmount(row) || transaction.type !== TransactionType.EXPENSE)
        ? "MANUAL_ADJUSTMENT" : "SOURCE_DUPLICATE";
    }
    // Equal transaction amounts cannot prove which refunds were applied.
    return transaction ? "MANUAL_ADJUSTMENT" : "NONE";
  });

  const ownersByFingerprint = new Map<string, number[]>();
  rows.forEach((row, index) => {
    if (outcomes[index] !== "NONE" || isManualReason(row.skipReason)) return;
    for (const value of [row.sourceFingerprint, ...(row.refundSourceFingerprints ?? [])]) {
      if (!value) continue;
      const owners = ownersByFingerprint.get(value) ?? [];
      owners.push(index);
      ownersByFingerprint.set(value, owners);
    }
  });
  for (const owners of ownersByFingerprint.values()) {
    if (owners.length > 1 && owners.some((index) => hasRefundMetadata(rows[index]))) {
      for (const index of owners) outcomes[index] = "MANUAL_ADJUSTMENT";
    }
  }

  return outcomes;
}
