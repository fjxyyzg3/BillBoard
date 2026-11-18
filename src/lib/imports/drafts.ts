import { randomUUID } from "node:crypto";

import {
  CategoryType,
  type ImportDraftRow,
  ImportDraftRowStatus,
  ImportDraftStatus,
  ImportRowDecision,
  Prisma,
  TransactionType,
  UserStatus,
} from "@prisma/client";

import { type HouseholdSession, resolveHouseholdContext } from "@/lib/auth/household-context";
import { db } from "@/lib/db";
import { collectImportSourceAmounts, collectWechatLegacyAmounts, scanImportTransactions, shanghaiFinancialDate } from "@/lib/encryption/financial-queries";
import { isEncryptedRequest } from "@/lib/encryption/request-context";
import { acquireResourceLease, assertResourceLease, ResourceBusyError, runWithResourceLease, withResourceLease, type ResourceLease } from "@/lib/resources/admission";
import { recordLedgerAudit } from "@/lib/transactions/audit";
import { entryContextSchema, type EntryContext } from "@/lib/transactions/entry-context";
import { buildImportCategoryMappingKey } from "@/lib/imports/category-mapping";
import { lockImportCategoryMappingRules, upsertImportCategoryMappingRule } from "@/lib/imports/category-mapping-rules";
import {
  classifyCmbRefundHistory,
  type CmbRefundHistoryOutcome,
} from "@/lib/imports/cmb-refund-history";
import {
  normalizeImportedMemberName,
  resolveImportedMember,
} from "@/lib/imports/member-mapping";
import { parseAlipayCsv } from "@/lib/imports/sources/alipay";
import { parseCmbPdf } from "@/lib/imports/sources/cmb";
import { parseCmbZip } from "@/lib/imports/sources/cmb-zip";
import { parseSuiShouJiWorkbook } from "@/lib/imports/sources/sui-shou-ji";
import { parseWechatPayWorkbook } from "@/lib/imports/sources/wechat-pay";
import {
  ALIPAY_FULLY_REFUNDED,
  ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
  ALIPAY_SOURCE,
  CATEGORY_MAPPING_IGNORED,
  CMB_FULLY_REFUNDED,
  CMB_REFUND_MANUAL_REASONS,
  CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
  CMB_SOURCE,
  type HouseholdMemberOption,
  type ImportSource,
  type InvalidImportRow,
  type ParsedImportRow,
  type ParsedImportWorkbook,
  SUI_SHOU_JI_SOURCE,
  WECHAT_FULLY_REFUNDED,
  WECHAT_PAY_SOURCE,
  WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
} from "@/lib/imports/types";

type SessionUser = HouseholdSession;

export type ImportDraftMappingInput = {
  categoryId: string | null;
  mappingKey: string;
};

type ImportDraftMemberMappingInput = {
  externalName: string;
  memberId: string;
};

type DuplicateCandidate = {
  amountFen: number;
  categoryId: string;
  id: string;
  occurredAt: string;
  source: string | null;
  type: TransactionType;
};

export type ImportDraftRowSummary = {
  actorFallbackApplied: boolean;
  actorExternalName: string | null;
  actorMemberId: string | null;
  amountFen: number | null;
  categoryId: string | null;
  createdByMemberId: string | null;
  creatorExternalName: string | null;
  creatorFallbackApplied: boolean;
  duplicateCandidates: DuplicateCandidate[];
  id: string;
  mappingKey: string | null;
  note: string | null;
  occurredAt: Date | null;
  occurredDate: string | null;
  primaryCategory: string | null;
  rawCreatedBy: string | null;
  rawMember: string | null;
  refundOriginalAmountFen?: number | null;
  rowNumber: number;
  secondaryCategory: string | null;
  skipReason: string | null;
  status: ImportDraftRowStatus;
  transactionType: TransactionType | null;
  userDecision: ImportRowDecision;
};

export type ImportDraftRowDecisionInput = {
  decision: ImportRowDecision;
  rowId: string;
};

export type ImportDuplicateCandidateDetail = {
  actorMemberName: string;
  amountFen: number;
  categoryName: string;
  createdByMemberName: string;
  id: string;
  note: string | null;
  occurredAt: Date;
  source: string | null;
  type: TransactionType;
};

type ImportDraftMemberMappingSummary = {
  count: number;
  externalName: string;
  fallbackApplied: boolean;
  memberId: string;
};

type ImportDraftSummary = {
  blockedReason: "INACTIVE_CREATOR" | "ARCHIVED_LEDGER" | null;
  counts: {
    importable: number;
    invalid: number;
    needsMapping: number;
    possibleDuplicate: number;
    ready: number;
    sourceDuplicate: number;
    total: number;
    userSkipped: number;
  };
  createdAt: Date;
  fileName: string;
  hasUnresolvedMemberMappings: boolean;
  id: string;
  ledgerId: string;
  ledgerName: string;
  ignoredMappings: ImportDraftCategoryMappingSummary[];
  memberMappings: ImportDraftMemberMappingSummary[];
  missingMappings: ImportDraftCategoryMappingSummary[];
  rows: ImportDraftRowSummary[];
  source: ImportSource;
  status: ImportDraftStatus;
};

type ImportDraftCategoryMappingSummary = {
  count: number;
  mappingKey: string;
  primaryCategory: string | null;
  secondaryCategory: string | null;
  transactionType: TransactionType | null;
};

type ConfirmImportDraftResult = {
  completedNow: boolean;
  createdCount: number;
  invalidCount: number;
  needsMappingCount: number;
  requiresReview: boolean;
  source: ImportSource;
  sourceDuplicateCount: number;
  userSkippedCount: number;
};

type MappingKeyParts = {
  primaryCategory: string;
  secondaryCategory: string;
  source: ImportSource;
  transactionType: TransactionType;
};

type ConfirmImportableRow = {
  actorMemberId: string;
  amountFen: number;
  categoryId: string;
  createdByMemberId: string;
  id: string;
  note: string | null;
  occurredAt: Date;
  refundOriginalAmountFen?: number;
  rowNumber: number;
  sourceFingerprint: string;
  transactionType: TransactionType;
};

const confirmImportChunkSize = 500;
const possibleDuplicateLookupChunkSize = 500;

const transactionTypeToCategoryType = {
  [TransactionType.EXPENSE]: CategoryType.EXPENSE,
  [TransactionType.INCOME]: CategoryType.INCOME,
} as const;

function chunkArray<T>(items: T[], size: number): T[][] {
  const chunks: T[][] = [];

  for (let index = 0; index < items.length; index += size) {
    chunks.push(items.slice(index, index + size));
  }

  return chunks;
}

function parseMappingKey(mappingKey: string): MappingKeyParts {
  const parts = mappingKey.split("|");
  const [source, transactionType, primaryCategory, secondaryCategory] = parts;

  if (
    parts.length !== 4 ||
    (source !== SUI_SHOU_JI_SOURCE &&
      source !== WECHAT_PAY_SOURCE &&
      source !== ALIPAY_SOURCE &&
      source !== CMB_SOURCE) ||
    (transactionType !== TransactionType.EXPENSE && transactionType !== TransactionType.INCOME) ||
    primaryCategory === undefined ||
    secondaryCategory === undefined
  ) {
    throw new Error("Invalid import mapping key");
  }

  return {
    primaryCategory,
    secondaryCategory,
    source,
    transactionType,
  };
}

function hasDuplicateCandidates(value: Prisma.JsonValue | null): boolean {
  return Array.isArray(value) && value.length > 0;
}

function toDuplicateCandidates(value: Prisma.JsonValue | null): DuplicateCandidate[] {
  return Array.isArray(value) ? (value as DuplicateCandidate[]) : [];
}

function shanghaiDayBounds(occurredDate: string) {
  const start = new Date(`${occurredDate}T00:00:00+08:00`);
  const nextStart = new Date(start.getTime() + 24 * 60 * 60 * 1000);

  return { nextStart, start };
}

function rowStatusCount(rows: ImportDraftRowSummary[], status: ImportDraftRowStatus) {
  return rows.filter((row) => row.status === status).length;
}

function possibleDuplicateLookupKey(occurredDate: string, amountFen: number) {
  return `${occurredDate}\u0000${amountFen}`;
}

function isImportableRow(row: Pick<ImportDraftRowSummary, "status" | "userDecision">) {
  return (
    row.userDecision === ImportRowDecision.KEEP &&
    (row.status === ImportDraftRowStatus.READY ||
      row.status === ImportDraftRowStatus.POSSIBLE_DUPLICATE)
  );
}

function isDecisionEditableStatus(status: ImportDraftRowStatus) {
  return (
    status === ImportDraftRowStatus.READY ||
    status === ImportDraftRowStatus.NEEDS_MAPPING ||
    status === ImportDraftRowStatus.POSSIBLE_DUPLICATE ||
    status === ImportDraftRowStatus.USER_SKIPPED
  );
}

function isProtectedRefundReason(skipReason: string | null) {
  return skipReason === ALIPAY_FULLY_REFUNDED ||
    skipReason === ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT ||
    skipReason === WECHAT_FULLY_REFUNDED ||
    skipReason === WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT ||
    skipReason === CMB_FULLY_REFUNDED ||
    CMB_REFUND_MANUAL_REASONS.some((reason) => reason === skipReason);
}

function getKeepRowStatus(row: {
  categoryId: string | null;
  duplicateCandidates: Prisma.JsonValue | null;
}) {
  if (!row.categoryId) {
    return ImportDraftRowStatus.NEEDS_MAPPING;
  }

  return hasDuplicateCandidates(row.duplicateCandidates)
    ? ImportDraftRowStatus.POSSIBLE_DUPLICATE
    : ImportDraftRowStatus.READY;
}

async function findExistingSourceAmounts(
  tx: Prisma.TransactionClient,
  householdId: string,
  source: ImportSource,
  fingerprints: string[],
) {
  if (isEncryptedRequest()) return collectImportSourceAmounts(tx, { householdId, source, fingerprints });
  const amountsByFingerprint = new Map<string, number[]>();

  for (const chunk of chunkArray(fingerprints, confirmImportChunkSize)) {
    const rows = await tx.transaction.findMany({
      where: {
        householdId,
        source,
        sourceFingerprint: { in: chunk },
      },
      select: { amountFen: true, sourceFingerprint: true },
    });

    for (const row of rows) {
      if (row.sourceFingerprint) {
        const amounts = amountsByFingerprint.get(row.sourceFingerprint) ?? [];

        amounts.push(row.amountFen);
        amountsByFingerprint.set(row.sourceFingerprint, amounts);
      }
    }
  }

  return amountsByFingerprint;
}

async function markRowsAsSourceDuplicates(
  tx: Prisma.TransactionClient,
  rowIds: string[],
  skipReason = "Source duplicate",
) {
  for (const chunk of chunkArray(rowIds, confirmImportChunkSize)) {
    await tx.importDraftRow.updateMany({
      where: { id: { in: chunk } },
      data: {
        skipReason,
        status: ImportDraftRowStatus.SOURCE_DUPLICATE,
        userDecision: ImportRowDecision.SKIP,
      },
    });
  }
}

async function insertImportTransactions(
  tx: Prisma.TransactionClient,
  householdId: string,
  ledgerId: string,
  source: ImportSource,
  rows: ConfirmImportableRow[],
  importedAt: Date,
) {
  const insertedFingerprints = new Set<string>();

  for (const chunk of chunkArray(rows, confirmImportChunkSize)) {
    if (isEncryptedRequest()) {
      const inserted = await tx.transaction.createManyAndReturn({
        data: chunk.map((row) => ({
          id: randomUUID(), householdId, ledgerId, type: row.transactionType,
          actorMemberId: row.actorMemberId, createdByMemberId: row.createdByMemberId,
          categoryId: row.categoryId, amountFen: row.amountFen, occurredAt: row.occurredAt,
          note: row.note, source, sourceFingerprint: row.sourceFingerprint, sourceImportedAt: importedAt,
        })),
        skipDuplicates: true,
        select: { sourceFingerprint: true },
      });
      for (const row of inserted) {
        if (row.sourceFingerprint) insertedFingerprints.add(row.sourceFingerprint);
      }
      continue;
    }
    const inserted = await tx.$queryRaw<Array<{ sourceFingerprint: string }>>(Prisma.sql`
      INSERT INTO "Transaction" (
        "id",
        "household_id",
        "ledger_id",
        "type",
        "actor_member_id",
        "created_by_member_id",
        "category_id",
        "amount_fen",
        "occurred_at",
        "note",
        "source",
        "source_fingerprint",
        "source_imported_at",
        "created_at",
        "updated_at"
      )
      VALUES ${Prisma.join(
        chunk.map((row) => Prisma.sql`(
          ${randomUUID()},
          ${householdId},
          ${ledgerId},
          CAST(${row.transactionType} AS "TransactionType"),
          ${row.actorMemberId},
          ${row.createdByMemberId},
          ${row.categoryId},
          ${row.amountFen},
          ${row.occurredAt},
          ${row.note},
          ${source},
          ${row.sourceFingerprint},
          ${importedAt},
          CURRENT_TIMESTAMP,
          CURRENT_TIMESTAMP
        )`),
      )}
      ON CONFLICT DO NOTHING
      RETURNING "source_fingerprint" AS "sourceFingerprint"
    `);

    for (const row of inserted) {
      insertedFingerprints.add(row.sourceFingerprint);
    }
  }

  return insertedFingerprints;
}

function buildSummary(draft: {
  blockedReason: ImportDraftSummary["blockedReason"];
  createdAt: Date;
  fileName: string;
  id: string;
  ledger: { name: string };
  ledgerId: string;
  rows: Array<{
    actorFallbackApplied: boolean;
    actorExternalName: string | null;
    actorMemberId: string | null;
    amountFen: number | null;
    categoryId: string | null;
    createdByMemberId: string | null;
    creatorExternalName: string | null;
    creatorFallbackApplied: boolean;
    duplicateCandidates: Prisma.JsonValue | null;
    id: string;
    mappingKey: string | null;
    note: string | null;
    occurredAt: Date | null;
    occurredDate: string | null;
    primaryCategory: string | null;
    rawCreatedBy: string | null;
    rawMember: string | null;
    refundOriginalAmountFen?: number | null;
    rowNumber: number;
    secondaryCategory: string | null;
    skipReason: string | null;
    status: ImportDraftRowStatus;
    transactionType: TransactionType | null;
    userDecision: ImportRowDecision;
  }>;
  source: string;
  status: ImportDraftStatus;
}): ImportDraftSummary {
  const rows = draft.rows.map((row) => ({
    ...row,
    duplicateCandidates: toDuplicateCandidates(row.duplicateCandidates),
  }));
  const missingMappingGroups = new Map<string, ImportDraftCategoryMappingSummary>();
  const ignoredMappingGroups = new Map<string, ImportDraftCategoryMappingSummary>();
  const memberMappingGroups = new Map<string, ImportDraftMemberMappingSummary>();

  function addMemberMappingUsage(input: {
    externalName: string | null;
    fallbackApplied: boolean;
    memberId: string | null;
  }) {
    if (!input.externalName || !input.memberId) {
      return;
    }

    const current = memberMappingGroups.get(input.externalName);

    if (current) {
      current.count += 1;
      current.fallbackApplied ||= input.fallbackApplied;
    } else {
      memberMappingGroups.set(input.externalName, {
        count: 1,
        externalName: input.externalName,
        fallbackApplied: input.fallbackApplied,
        memberId: input.memberId,
      });
    }
  }

  for (const row of rows) {
    if (
      row.status !== ImportDraftRowStatus.INVALID &&
      row.status !== ImportDraftRowStatus.SOURCE_DUPLICATE &&
      row.status !== ImportDraftRowStatus.USER_SKIPPED
    ) {
      addMemberMappingUsage({
        externalName: row.actorExternalName,
        fallbackApplied: row.actorFallbackApplied,
        memberId: row.actorMemberId,
      });
      addMemberMappingUsage({
        externalName: row.creatorExternalName,
        fallbackApplied: row.creatorFallbackApplied,
        memberId: row.createdByMemberId,
      });
    }

    const isMissingMapping = row.status === ImportDraftRowStatus.NEEDS_MAPPING &&
      row.userDecision === ImportRowDecision.KEEP;
    const isIgnoredMapping = row.status === ImportDraftRowStatus.USER_SKIPPED &&
      row.skipReason === CATEGORY_MAPPING_IGNORED;

    if ((!isMissingMapping && !isIgnoredMapping) || !row.mappingKey) {
      continue;
    }

    const mappingGroups = isMissingMapping ? missingMappingGroups : ignoredMappingGroups;
    const current = mappingGroups.get(row.mappingKey);

    if (current) {
      current.count += 1;
    } else {
      const shouldHideSecondaryCategory = row.mappingKey.startsWith(`${ALIPAY_SOURCE}|`);

      mappingGroups.set(row.mappingKey, {
        count: 1,
        mappingKey: row.mappingKey,
        primaryCategory: row.primaryCategory,
        secondaryCategory: shouldHideSecondaryCategory ? null : row.secondaryCategory,
        transactionType: row.transactionType,
      });
    }
  }

  const memberMappings = Array.from(memberMappingGroups.values()).sort((a, b) =>
    a.externalName.localeCompare(b.externalName),
  );

  return {
    blockedReason: draft.blockedReason,
    counts: {
      importable: rows.filter(isImportableRow).length,
      invalid: rowStatusCount(rows, ImportDraftRowStatus.INVALID),
      needsMapping: rowStatusCount(rows, ImportDraftRowStatus.NEEDS_MAPPING),
      possibleDuplicate: rowStatusCount(rows, ImportDraftRowStatus.POSSIBLE_DUPLICATE),
      ready: rowStatusCount(rows, ImportDraftRowStatus.READY),
      sourceDuplicate: rowStatusCount(rows, ImportDraftRowStatus.SOURCE_DUPLICATE),
      total: rows.length,
      userSkipped: rowStatusCount(rows, ImportDraftRowStatus.USER_SKIPPED),
    },
    createdAt: draft.createdAt,
    fileName: draft.fileName,
    hasUnresolvedMemberMappings: rows.some((row) =>
      row.status !== ImportDraftRowStatus.INVALID &&
      row.status !== ImportDraftRowStatus.SOURCE_DUPLICATE &&
      row.status !== ImportDraftRowStatus.USER_SKIPPED &&
      (row.actorFallbackApplied || row.creatorFallbackApplied)),
    id: draft.id,
    ledgerId: draft.ledgerId,
    ledgerName: draft.ledger.name,
    ignoredMappings: Array.from(ignoredMappingGroups.values()).sort((a, b) =>
      a.mappingKey.localeCompare(b.mappingKey),
    ),
    memberMappings,
    missingMappings: Array.from(missingMappingGroups.values()).sort((a, b) =>
      a.mappingKey.localeCompare(b.mappingKey),
    ),
    rows,
    source: draft.source as ImportSource,
    status: draft.status,
  };
}

function buildConfirmResultFromRows(
  rows: Array<Pick<ImportDraftRowSummary, "status" | "userDecision">>,
  source: ImportSource,
  completedNow: boolean,
): ConfirmImportDraftResult {
  return {
    completedNow,
    createdCount: rows.filter(isImportableRow).length,
    invalidCount: rows.filter((row) => row.status === ImportDraftRowStatus.INVALID).length,
    needsMappingCount: rows.filter((row) => row.status === ImportDraftRowStatus.NEEDS_MAPPING)
      .length,
    requiresReview: false,
    source,
    sourceDuplicateCount: rows.filter(
      (row) => row.status === ImportDraftRowStatus.SOURCE_DUPLICATE,
    ).length,
    userSkippedCount: rows.filter((row) => row.status === ImportDraftRowStatus.USER_SKIPPED)
      .length,
  };
}

async function requireHouseholdMember(sessionUser: SessionUser, ledgerId?: string) {
  const context = await resolveHouseholdContext(db, sessionUser, { ledgerId });
  const householdMembers = await db.householdMember.findMany({
    where: {
      householdId: context.householdId,
      leftAt: null,
      user: { status: UserStatus.ACTIVE },
    },
    orderBy: { joinedAt: "asc" },
    select: { id: true, memberName: true },
  });

  return {
    context,
    currentMember: { id: context.memberId },
    householdMembers: householdMembers satisfies HouseholdMemberOption[],
  };
}

async function authorizeDraftMutation(
  tx: Prisma.TransactionClient,
  draftId: string,
  sessionUser: SessionUser,
) {
  // All import writers take the household/member locks before the draft lock.
  await resolveHouseholdContext(tx, sessionUser, { lock: true });
  const draft = await tx.importDraft.findFirst({
    where: { householdId: sessionUser.householdId, id: draftId },
    select: {
      ledgerId: true,
      status: true,
      createdByMember: { select: { leftAt: true, user: { select: { status: true } } } },
    },
  });

  if (!draft) throw new Error("Import draft not found");
  if (draft.status === ImportDraftStatus.PENDING) {
    if (draft.createdByMember.leftAt || draft.createdByMember.user.status !== UserStatus.ACTIVE) {
      throw new Error("Import draft creator is no longer active");
    }
    await resolveHouseholdContext(tx, sessionUser, { lock: true, ledgerId: draft.ledgerId });
  }
}

async function loadCategoryMappings(householdId: string, source: ImportSource, mappingKeys: string[]) {
  const keySet = new Set(mappingKeys);
  const mappings = await db.importCategoryMapping.findMany({
    where: {
      householdId,
      source,
    },
    select: {
      categoryId: true,
      category: { select: { isActive: true, type: true } },
      primaryCategory: true,
      secondaryCategory: true,
      source: true,
      transactionType: true,
    },
  });
  const mappingByKey = new Map<string, string | null>();

  for (const mapping of mappings) {
    if (mapping.categoryId && (!mapping.category?.isActive ||
      mapping.category.type !== transactionTypeToCategoryType[mapping.transactionType])) {
      continue;
    }
    const mappingKey = buildImportCategoryMappingKey({
      primaryCategory: mapping.primaryCategory,
      secondaryCategory: mapping.secondaryCategory,
      source: mapping.source as ImportSource,
      transactionType: mapping.transactionType,
    });

    if (keySet.has(mappingKey)) {
      mappingByKey.set(mappingKey, mapping.categoryId);
    }
  }

  return mappingByKey;
}

async function findSourceDuplicateAmounts(
  householdId: string,
  source: ImportSource,
  fingerprints: string[],
) {
  const amountByFingerprint = new Map<string, number>();
  if (isEncryptedRequest()) {
    const amounts = await collectImportSourceAmounts(db, { householdId, source, fingerprints });
    for (const [fingerprint, values] of amounts) amountByFingerprint.set(fingerprint, values[values.length - 1]);
    return amountByFingerprint;
  }

  for (const chunk of chunkArray(fingerprints, confirmImportChunkSize)) {
    const rows = await db.transaction.findMany({
      where: {
        householdId,
        source,
        sourceFingerprint: { in: chunk },
      },
      select: { amountFen: true, sourceFingerprint: true },
    });

    for (const row of rows) {
      if (row.sourceFingerprint) {
        amountByFingerprint.set(row.sourceFingerprint, row.amountFen);
      }
    }
  }

  return amountByFingerprint;
}

function wechatLegacyOccurredAtKey(occurredAt: Date) {
  return occurredAt.toISOString();
}

async function findWechatLegacyAmountsByOccurredAt(
  householdId: string,
  rows: ParsedImportRow[],
) {
  const amountsByOccurredAt = new Map<string, number[]>();
  const occurredAtValues = Array.from(
    new Map(
      rows
        .filter(
          (row) =>
            (row.refundHandling === "WECHAT_PARTIAL" ||
              row.refundHandling === "WECHAT_FULL") &&
            row.refundOriginalAmountFen !== undefined,
        )
        .map((row) => [wechatLegacyOccurredAtKey(row.occurredAt), row.occurredAt]),
    ).values(),
  );
  if (isEncryptedRequest()) return collectWechatLegacyAmounts(db, { householdId, occurredAt: occurredAtValues });

  for (const chunk of chunkArray(occurredAtValues, confirmImportChunkSize)) {
    const transactions = await db.transaction.findMany({
      where: {
        householdId,
        occurredAt: { in: chunk },
        source: WECHAT_PAY_SOURCE,
        type: TransactionType.EXPENSE,
      },
      select: { amountFen: true, occurredAt: true },
    });

    for (const transaction of transactions) {
      const key = wechatLegacyOccurredAtKey(transaction.occurredAt);
      const amounts = amountsByOccurredAt.get(key) ?? [];

      amounts.push(transaction.amountFen);
      amountsByOccurredAt.set(key, amounts);
    }
  }

  return amountsByOccurredAt;
}

async function findWechatLegacyAmountsByOccurredAtForConfirmation(
  tx: Prisma.TransactionClient,
  householdId: string,
  rows: ConfirmImportableRow[],
) {
  const amountsByOccurredAt = new Map<string, number[]>();
  const occurredAtValues = Array.from(
    new Map(
      rows
        .filter((row) => row.refundOriginalAmountFen !== undefined)
        .map((row) => [wechatLegacyOccurredAtKey(row.occurredAt), row.occurredAt]),
    ).values(),
  );
  if (isEncryptedRequest()) return collectWechatLegacyAmounts(tx, { householdId, occurredAt: occurredAtValues });

  for (const chunk of chunkArray(occurredAtValues, confirmImportChunkSize)) {
    const transactions = await tx.transaction.findMany({
      where: {
        householdId,
        occurredAt: { in: chunk },
        source: WECHAT_PAY_SOURCE,
        type: TransactionType.EXPENSE,
      },
      select: { amountFen: true, occurredAt: true },
    });

    for (const transaction of transactions) {
      const key = wechatLegacyOccurredAtKey(transaction.occurredAt);
      const amounts = amountsByOccurredAt.get(key) ?? [];

      amounts.push(transaction.amountFen);
      amountsByOccurredAt.set(key, amounts);
    }
  }

  return amountsByOccurredAt;
}

function parseWechatRefundOriginalAmountFen(
  source: ImportSource,
  rawAmount: string | null,
  netAmountFen: number,
) {
  if (source !== WECHAT_PAY_SOURCE || !rawAmount || !/^\d+$/.test(rawAmount)) {
    return undefined;
  }

  const originalAmountFen = Number(rawAmount);

  return Number.isSafeInteger(originalAmountFen) && originalAmountFen > netAmountFen
    ? originalAmountFen
    : undefined;
}

function matchingWechatLegacyAmounts(row: ParsedImportRow, amounts: number[]) {
  const originalAmountFen = row.refundOriginalAmountFen;

  if (originalAmountFen === undefined) {
    return [];
  }

  if (row.refundHandling === "WECHAT_PARTIAL") {
    return amounts.filter(
      (amountFen) => amountFen >= row.amountFen && amountFen <= originalAmountFen,
    );
  }

  if (row.refundHandling === "WECHAT_FULL") {
    return amounts.filter((amountFen) => amountFen > 0 && amountFen <= originalAmountFen);
  }

  return [];
}

type WechatRefundHistoryOutcome = "MANUAL_ADJUSTMENT" | "NONE" | "SOURCE_DUPLICATE";

function classifyWechatRefundHistory(input: {
  amountFen: number;
  legacyAmounts: number[];
  refundHandling: ParsedImportRow["refundHandling"];
  stableAmounts: number[];
}): WechatRefundHistoryOutcome {
  if (
    input.refundHandling !== "WECHAT_PARTIAL" &&
    input.refundHandling !== "WECHAT_FULL"
  ) {
    return "NONE";
  }

  const matchedAmounts =
    input.stableAmounts.length > 0 ? input.stableAmounts : input.legacyAmounts;

  if (matchedAmounts.length === 0) {
    return "NONE";
  }

  if (
    input.refundHandling === "WECHAT_PARTIAL" &&
    matchedAmounts.length === 1 &&
    matchedAmounts[0] === input.amountFen
  ) {
    return "SOURCE_DUPLICATE";
  }

  return "MANUAL_ADJUSTMENT";
}

function toDuplicateCandidate(transaction: {
  amountFen: number;
  categoryId: string;
  id: string;
  occurredAt: Date;
  source: string | null;
  type: TransactionType;
}): DuplicateCandidate {
  return {
    amountFen: transaction.amountFen,
    categoryId: transaction.categoryId,
    id: transaction.id,
    occurredAt: transaction.occurredAt.toISOString(),
    source: transaction.source,
    type: transaction.type,
  };
}

async function findPossibleDuplicateCandidatesByKey(input: {
  householdId: string;
  rows: ParsedImportRow[];
  source: ImportSource;
}) {
  const amountsByDate = new Map<string, Set<number>>();
  const candidatesByKey = new Map<string, DuplicateCandidate[]>();

  for (const row of input.rows) {
    const amounts = amountsByDate.get(row.occurredAtDate) ?? new Set<number>();

    amounts.add(row.amountFen);
    amountsByDate.set(row.occurredAtDate, amounts);
  }
  if (amountsByDate.size === 0) return candidatesByKey;

  if (isEncryptedRequest()) {
    for await (const transaction of scanImportTransactions(db, { householdId: input.householdId, excludeDeleted: true })) {
      const occurredDate = shanghaiFinancialDate(transaction.occurredAt);
      if (transaction.source === input.source || !amountsByDate.get(occurredDate)?.has(transaction.amountFen)) continue;
      const key = possibleDuplicateLookupKey(occurredDate, transaction.amountFen);
      const candidates = candidatesByKey.get(key) ?? [];
      candidates.push(toDuplicateCandidate(transaction));
      candidatesByKey.set(key, candidates);
    }
    for (const candidates of candidatesByKey.values()) candidates.sort((left, right) => Date.parse(left.occurredAt) - Date.parse(right.occurredAt));
    return candidatesByKey;
  }

  for (const [occurredDate, amounts] of amountsByDate) {
    const { nextStart, start } = shanghaiDayBounds(occurredDate);

    for (const amountChunk of chunkArray(Array.from(amounts), possibleDuplicateLookupChunkSize)) {
      const transactions = await db.transaction.findMany({
        where: {
          amountFen: { in: amountChunk },
          deletedAt: null,
          householdId: input.householdId,
          occurredAt: {
            gte: start,
            lt: nextStart,
          },
          OR: [{ source: null }, { source: { not: input.source } }],
        },
        orderBy: { occurredAt: "asc" },
        select: {
          amountFen: true,
          categoryId: true,
          id: true,
          occurredAt: true,
          source: true,
          type: true,
        },
      });

      for (const transaction of transactions) {
        const key = possibleDuplicateLookupKey(occurredDate, transaction.amountFen);
        const candidates = candidatesByKey.get(key) ?? [];

        candidates.push(toDuplicateCandidate(transaction));
        candidatesByKey.set(key, candidates);
      }
    }
  }

  return candidatesByKey;
}

function importedActorName(row: ParsedImportRow) {
  return normalizeImportedMemberName(row.rawMember) ?? normalizeImportedMemberName(row.rawCreatedBy);
}

function importedCreatorName(row: ParsedImportRow) {
  return normalizeImportedMemberName(row.rawCreatedBy);
}

async function loadMemberMappings(
  householdId: string,
  source: ImportSource,
  externalNames: string[],
) {
  const uniqueNames = Array.from(new Set(externalNames));

  if (uniqueNames.length === 0) {
    return new Map<string, string>();
  }

  const mappings = await db.importMemberMapping.findMany({
    where: {
      externalName: { in: uniqueNames },
      householdId,
      member: {
        householdId,
        leftAt: null,
        user: { status: UserStatus.ACTIVE },
      },
      source,
    },
    select: {
      externalName: true,
      memberId: true,
    },
  });

  return new Map(mappings.map((mapping) => [mapping.externalName, mapping.memberId]));
}

function uniqueMemberMappingInputs(mappings: ImportDraftMemberMappingInput[]) {
  const unique = new Map<string, string>();

  for (const mapping of mappings) {
    const externalName = normalizeImportedMemberName(mapping.externalName);

    if (!externalName || !mapping.memberId) {
      continue;
    }

    unique.set(externalName, mapping.memberId);
  }

  return Array.from(unique.entries()).map(([externalName, memberId]) => ({
    externalName,
    memberId,
  }));
}

function buildParsedRowCreateInput(input: {
  categoryId: string | null | undefined;
  cmbHistoryOutcome: CmbRefundHistoryOutcome;
  currentMemberId: string;
  duplicateCandidates: DuplicateCandidate[];
  existingSourceAmountFen: number | undefined;
  existingWechatLegacyAmounts: number[];
  mappingByExternalName: Map<string, string>;
  row: ParsedImportRow;
  source: ImportSource;
}) {
  const actor = resolveImportedMember(
    importedActorName(input.row),
    input.mappingByExternalName,
    input.currentMemberId,
  );
  const createdBy = resolveImportedMember(
    importedCreatorName(input.row),
    input.mappingByExternalName,
    input.currentMemberId,
  );
  const hasStableSourceDuplicate = input.existingSourceAmountFen !== undefined;
  const matchingLegacyAmounts = matchingWechatLegacyAmounts(
    input.row,
    input.existingWechatLegacyAmounts,
  );
  const wechatHistoryOutcome = classifyWechatRefundHistory({
    amountFen: input.row.amountFen,
    legacyAmounts: matchingLegacyAmounts,
    refundHandling: input.row.refundHandling,
    stableAmounts:
      input.existingSourceAmountFen === undefined ? [] : [input.existingSourceAmountFen],
  });
  const isWechatManualOutcome = input.row.refundHandling === "WECHAT_MANUAL";
  const isWechatFullRefund = input.row.refundHandling === "WECHAT_FULL";
  const isCmbFullRefund = input.row.refundHandling === "CMB_FULL";
  const requiresCmbManualAdjustment = input.source === CMB_SOURCE &&
    (input.cmbHistoryOutcome === "MANUAL_ADJUSTMENT" || input.row.refundHandling === "CMB_MANUAL");
  const isSourceDuplicate = input.source === CMB_SOURCE
    ? input.cmbHistoryOutcome === "SOURCE_DUPLICATE"
    : !isWechatManualOutcome &&
      (hasStableSourceDuplicate || wechatHistoryOutcome !== "NONE");
  const isFirstFullRefund =
    (input.row.refundHandling === "ALIPAY_FULL" || isWechatFullRefund || isCmbFullRefund) && !isSourceDuplicate;
  const requiresAlipayManualAdjustment =
    (input.row.refundHandling === "ALIPAY_FULL" && isSourceDuplicate) ||
    (input.row.refundHandling === "ALIPAY_PARTIAL" &&
      isSourceDuplicate &&
      input.existingSourceAmountFen !== input.row.amountFen);
  const requiresWechatManualAdjustment =
    isWechatManualOutcome ||
    wechatHistoryOutcome === "MANUAL_ADJUSTMENT";
  const status = isSourceDuplicate
    ? ImportDraftRowStatus.SOURCE_DUPLICATE
    : isFirstFullRefund || isWechatManualOutcome || requiresCmbManualAdjustment || input.row.defaultSkipReason || input.categoryId === null
      ? ImportDraftRowStatus.USER_SKIPPED
    : input.categoryId
      ? input.duplicateCandidates.length > 0
        ? ImportDraftRowStatus.POSSIBLE_DUPLICATE
        : ImportDraftRowStatus.READY
      : ImportDraftRowStatus.NEEDS_MAPPING;
  const userDecision =
    isSourceDuplicate ||
    status === ImportDraftRowStatus.POSSIBLE_DUPLICATE ||
    status === ImportDraftRowStatus.USER_SKIPPED
      ? ImportRowDecision.SKIP
      : ImportRowDecision.KEEP;
  const skipReason = requiresCmbManualAdjustment && !isSourceDuplicate
    ? input.cmbHistoryOutcome === "MANUAL_ADJUSTMENT"
      ? CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT
      : (input.row.defaultSkipReason ?? CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT)
    : requiresWechatManualAdjustment
      ? WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT
      : requiresAlipayManualAdjustment
        ? ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT
        : isSourceDuplicate
          ? "Source duplicate"
          : isFirstFullRefund
            ? isCmbFullRefund
              ? CMB_FULLY_REFUNDED
              : isWechatFullRefund
                ? WECHAT_FULLY_REFUNDED
                : ALIPAY_FULLY_REFUNDED
            : (input.row.defaultSkipReason ?? (input.categoryId === null ? CATEGORY_MAPPING_IGNORED : null));

  return {
    actorFallbackApplied: actor.fallbackApplied,
    actorExternalName: actor.externalName,
    actorMemberId: actor.memberId,
    amountFen: input.row.amountFen,
    categoryId: input.categoryId ?? null,
    createdByMemberId: createdBy.memberId,
    creatorExternalName: createdBy.externalName,
    creatorFallbackApplied: createdBy.fallbackApplied,
    duplicateCandidates: input.duplicateCandidates,
    mappingKey: input.row.mappingKey,
    note: input.row.note,
    occurredAt: input.row.occurredAt,
    occurredDate: input.row.occurredAtDate,
    primaryCategory: input.row.primaryCategory,
    rawAmount:
      input.source === WECHAT_PAY_SOURCE && input.row.refundHandling === "WECHAT_PARTIAL"
        ? String(input.row.refundOriginalAmountFen)
        : null,
    rawCreatedBy: null,
    rawCurrency: null,
    rawDate: null,
    rawMember: null,
    rawTransactionType: null,
    refundOriginalAmountFen: input.source === CMB_SOURCE ? input.row.refundOriginalAmountFen : undefined,
    refundSourceFingerprints: input.source === CMB_SOURCE ? input.row.refundSourceFingerprints : undefined,
    rowNumber: input.row.rowNumber,
    secondaryCategory: input.row.secondaryCategory,
    skipReason,
    sourceFingerprint: input.row.sourceFingerprint,
    status,
    transactionType: input.row.transactionType,
    userDecision,
  };
}

function buildInvalidRowCreateInput(row: InvalidImportRow) {
  return {
    rawAmount: null,
    rawCreatedBy: null,
    rawCurrency: null,
    rawDate: null,
    rawMember: null,
    rawTransactionType: null,
    rowNumber: row.rowNumber ?? 0,
    skipReason: row.reason,
    status: ImportDraftRowStatus.INVALID,
    userDecision: ImportRowDecision.SKIP,
  };
}

async function loadDraftForSummary(draftId: string, sessionUser: SessionUser) {
  const { householdMembers } = await requireHouseholdMember(sessionUser);

  const draft = await db.importDraft.findFirst({
    where: {
      householdId: sessionUser.householdId,
      id: draftId,
    },
    include: {
      createdByMember: { select: { leftAt: true, user: { select: { status: true } } } },
      ledger: { select: { name: true, archivedAt: true } },
      rows: {
        orderBy: [{ rowNumber: "asc" }, { id: "asc" }],
        select: {
          actorFallbackApplied: true,
          actorExternalName: true,
          actorMemberId: true,
          amountFen: true,
          categoryId: true,
          createdByMemberId: true,
          creatorExternalName: true,
          creatorFallbackApplied: true,
          duplicateCandidates: true,
          id: true,
          mappingKey: true,
          note: true,
          occurredAt: true,
          occurredDate: true,
          primaryCategory: true,
          rawCreatedBy: true,
          rawMember: true,
          refundOriginalAmountFen: true,
          rowNumber: true,
          secondaryCategory: true,
          skipReason: true,
          status: true,
          transactionType: true,
          userDecision: true,
        },
      },
    },
  });

  if (!draft) {
    throw new Error("Import draft not found");
  }

  const activeMemberIds = new Set(householdMembers.map(({ id }) => id));
  const categories = draft.status === ImportDraftStatus.PENDING
    ? await db.category.findMany({
        where: { isActive: true, id: { in: [...new Set(draft.rows.flatMap(({ categoryId }) => categoryId ? [categoryId] : []))] } },
        select: { id: true, type: true },
      })
    : [];
  const categoryById = new Map(categories.map((category) => [category.id, category]));
  const blockedReason: ImportDraftSummary["blockedReason"] = draft.status !== ImportDraftStatus.PENDING
    ? null
    : draft.createdByMember.leftAt || draft.createdByMember.user.status !== UserStatus.ACTIVE
      ? "INACTIVE_CREATOR"
      : draft.ledger.archivedAt ? "ARCHIVED_LEDGER" : null;

  return {
    ...draft,
    blockedReason,
    rows: draft.rows.map((row) => {
      if (draft.status !== ImportDraftStatus.PENDING) return row;
      const needsCategoryMapping = row.categoryId && row.transactionType &&
        isDecisionEditableStatus(row.status) && row.status !== ImportDraftRowStatus.USER_SKIPPED &&
        categoryById.get(row.categoryId)?.type !== transactionTypeToCategoryType[row.transactionType];
      return {
        ...row,
        categoryId: needsCategoryMapping ? null : row.categoryId,
        status: needsCategoryMapping ? ImportDraftRowStatus.NEEDS_MAPPING : row.status,
        actorFallbackApplied: row.actorFallbackApplied || Boolean(row.actorMemberId && !activeMemberIds.has(row.actorMemberId)),
        creatorFallbackApplied: row.creatorFallbackApplied || Boolean(row.createdByMemberId && !activeMemberIds.has(row.createdByMemberId)),
      };
    }),
  };
}

function storedImportFileName(source: ImportSource) {
  if (source === ALIPAY_SOURCE) {
    return `${source}.csv`;
  }

  if (source === CMB_SOURCE) {
    return `${source}.pdf`;
  }

  return `${source}.xlsx`;
}

type CreateImportDraftInput = {
  buffer: Buffer;
  context?: EntryContext;
  fileName: string;
  parseWorkbook: (buffer: Buffer, signal?: AbortSignal) => Promise<ParsedImportWorkbook>;
  sessionUser: SessionUser;
  source: ImportSource;
};

async function createImportDraft(input: CreateImportDraftInput) {
  if (!input.context) throw new Error("Entry context is required; refresh and select a ledger");
  const originalContext = entryContextSchema.parse(input.context);
  if (originalContext.householdId !== input.sessionUser.householdId || originalContext.memberId !== input.sessionUser.memberId) throw new Error("Unauthorized");
  return withResourceLease(input.sessionUser, "import", (lease) => createAdmittedImportDraft(input, lease), { ledgerId: originalContext.ledgerId });
}

async function createAdmittedImportDraft(input: CreateImportDraftInput, lease: ResourceLease) {
  const originalContext = entryContextSchema.parse(input.context);
  const { context, currentMember } = await requireHouseholdMember(input.sessionUser, originalContext.ledgerId);
  const parsedWorkbook = await input.parseWorkbook(input.buffer, lease.signal);
  const mappingKeys = parsedWorkbook.rows.map((row) => row.mappingKey);
  const memberExternalNames = parsedWorkbook.rows.flatMap((row) =>
    [importedActorName(row), importedCreatorName(row)].filter(
      (externalName): externalName is string => Boolean(externalName),
    ),
  );
  const [
    categoryMappings,
    sourceDuplicateAmounts,
    mappingByExternalName,
    wechatLegacyAmountsByOccurredAt,
    cmbHistoryOutcomes,
  ] =
    await Promise.all([
      loadCategoryMappings(input.sessionUser.householdId, input.source, mappingKeys),
      input.source === CMB_SOURCE
        ? Promise.resolve(new Map<string, number>())
        : findSourceDuplicateAmounts(
            input.sessionUser.householdId,
            input.source,
            parsedWorkbook.rows.map((row) => row.sourceFingerprint),
          ),
      loadMemberMappings(input.sessionUser.householdId, input.source, memberExternalNames),
      input.source === WECHAT_PAY_SOURCE
        ? findWechatLegacyAmountsByOccurredAt(
            input.sessionUser.householdId,
            parsedWorkbook.rows,
          )
        : Promise.resolve(new Map<string, number[]>()),
      input.source === CMB_SOURCE
        ? classifyCmbRefundHistory(db, input.sessionUser.householdId, parsedWorkbook.rows.map((row) => ({
            ...row,
            skipReason: row.refundHandling === "CMB_FULL" ? CMB_FULLY_REFUNDED : row.defaultSkipReason,
          })))
        : Promise.resolve([]),
    ]);
  const possibleDuplicateCandidatesByKey = await findPossibleDuplicateCandidatesByKey({
    householdId: input.sessionUser.householdId,
    rows: parsedWorkbook.rows,
    source: input.source,
  });
  const parsedRowCreateInputs: ReturnType<typeof buildParsedRowCreateInput>[] = [];

  for (const [index, row] of parsedWorkbook.rows.entries()) {
    const duplicateCandidates =
      possibleDuplicateCandidatesByKey.get(
        possibleDuplicateLookupKey(row.occurredAtDate, row.amountFen),
      ) ?? [];

    parsedRowCreateInputs.push(
      buildParsedRowCreateInput({
        categoryId: categoryMappings.get(row.mappingKey),
        cmbHistoryOutcome: cmbHistoryOutcomes[index] ?? "NONE",
        currentMemberId: currentMember.id,
        duplicateCandidates,
        existingSourceAmountFen: sourceDuplicateAmounts.get(row.sourceFingerprint),
        existingWechatLegacyAmounts:
          wechatLegacyAmountsByOccurredAt.get(wechatLegacyOccurredAtKey(row.occurredAt)) ?? [],
        mappingByExternalName,
        row,
        source: input.source,
      }),
    );
  }

  return db.$transaction(async (tx) => {
    await resolveHouseholdContext(tx, input.sessionUser, { lock: true, ledgerId: context.ledgerId });
    await assertResourceLease(tx, lease);
    const draft = await tx.importDraft.create({
      data: {
        createdByMemberId: currentMember.id,
        fileName: storedImportFileName(input.source),
        householdId: input.sessionUser.householdId,
        ledgerId: context.ledgerId,
        rows: {
          createMany: {
            data: [
              ...parsedRowCreateInputs,
              ...parsedWorkbook.invalidRows.map(buildInvalidRowCreateInput),
            ],
          },
        },
        source: input.source,
      },
      select: {
        id: true,
        status: true,
      },
    });
    await assertResourceLease(tx, lease);
    return draft;
  }, { timeout: 120_000 });
}

export async function createSuiShouJiImportDraft(input: {
  buffer: Buffer;
  context?: EntryContext;
  fileName: string;
  sessionUser: SessionUser;
}) {
  return createImportDraft({
    ...input,
    parseWorkbook: parseSuiShouJiWorkbook,
    source: SUI_SHOU_JI_SOURCE,
  });
}

export async function createWechatPayImportDraft(input: {
  buffer: Buffer;
  context?: EntryContext;
  fileName: string;
  sessionUser: SessionUser;
}) {
  return createImportDraft({
    ...input,
    parseWorkbook: parseWechatPayWorkbook,
    source: WECHAT_PAY_SOURCE,
  });
}

export async function createAlipayImportDraft(input: {
  buffer: Buffer;
  context?: EntryContext;
  fileName: string;
  sessionUser: SessionUser;
}) {
  return createImportDraft({
    ...input,
    parseWorkbook: parseAlipayCsv,
    source: ALIPAY_SOURCE,
  });
}

const paymentImportSources = [WECHAT_PAY_SOURCE, ALIPAY_SOURCE] as const;

export async function saveImportDraftMemberMappings(
  draftId: string,
  mappings: ImportDraftMemberMappingInput[],
  sessionUser: SessionUser,
) {
  await requireHouseholdMember(sessionUser);
  const normalizedMappings = uniqueMemberMappingInputs(mappings);

  if (normalizedMappings.length === 0) {
    return;
  }

  await db.$transaction(async (tx) => {
    await authorizeDraftMutation(tx, draftId, sessionUser);
    const lockedDraftRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "ImportDraft"
      WHERE "id" = ${draftId}
        AND "household_id" = ${sessionUser.householdId}
      FOR UPDATE
    `;

    if (lockedDraftRows.length === 0) {
      throw new Error("Import draft not found");
    }

    const draft = await tx.importDraft.findFirst({
      where: {
        householdId: sessionUser.householdId,
        id: draftId,
      },
      select: {
        id: true,
        source: true,
        status: true,
      },
    });

    if (!draft) {
      throw new Error("Import draft not found");
    }

    if (draft.status !== ImportDraftStatus.PENDING) {
      throw new Error("Import draft is already completed");
    }

    const memberIds = Array.from(new Set(normalizedMappings.map((mapping) => mapping.memberId)));
    const members = await tx.householdMember.findMany({
      where: {
        householdId: sessionUser.householdId,
        leftAt: null,
        user: { status: UserStatus.ACTIVE },
        id: { in: memberIds },
      },
      select: { id: true },
    });
    const validMemberIds = new Set(members.map((member) => member.id));

    if (memberIds.some((memberId) => !validMemberIds.has(memberId))) {
      throw new Error("Member not found");
    }

    for (const mapping of normalizedMappings) {
      await tx.importMemberMapping.upsert({
        where: {
          household_source_external_name: {
            externalName: mapping.externalName,
            householdId: sessionUser.householdId,
            source: draft.source,
          },
        },
        create: {
          externalName: mapping.externalName,
          householdId: sessionUser.householdId,
          memberId: mapping.memberId,
          source: draft.source,
        },
        update: {
          memberId: mapping.memberId,
        },
      });

      await tx.importDraftRow.updateMany({
        where: {
          actorExternalName: mapping.externalName,
          draftId: draft.id,
          status: {
            notIn: [
              ImportDraftRowStatus.INVALID,
              ImportDraftRowStatus.SOURCE_DUPLICATE,
            ],
          },
        },
        data: {
          actorFallbackApplied: false,
          actorMemberId: mapping.memberId,
        },
      });

      await tx.importDraftRow.updateMany({
        where: {
          creatorExternalName: mapping.externalName,
          draftId: draft.id,
          status: {
            notIn: [
              ImportDraftRowStatus.INVALID,
              ImportDraftRowStatus.SOURCE_DUPLICATE,
            ],
          },
        },
        data: {
          createdByMemberId: mapping.memberId,
          creatorFallbackApplied: false,
        },
      });
    }
  });
}

export async function savePaymentImportDraftOwnerMember(
  draftId: string,
  ownerMemberId: string,
  sessionUser: SessionUser,
) {
  await requireHouseholdMember(sessionUser);

  await db.$transaction(async (tx) => {
    await authorizeDraftMutation(tx, draftId, sessionUser);
    const lockedDraftRows = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT "id"
      FROM "ImportDraft"
      WHERE "id" = ${draftId}
        AND "household_id" = ${sessionUser.householdId}
      FOR UPDATE
    `);

    if (lockedDraftRows.length === 0) {
      throw new Error("Import draft not found");
    }

    const [draft, ownerMember] = await Promise.all([
      tx.importDraft.findFirst({
        where: {
          householdId: sessionUser.householdId,
          id: draftId,
          source: { in: [...paymentImportSources] },
        },
        select: { id: true, status: true },
      }),
      tx.householdMember.findFirst({
        where: {
          householdId: sessionUser.householdId,
          id: ownerMemberId,
          leftAt: null,
          user: { status: UserStatus.ACTIVE },
        },
        select: { id: true },
      }),
    ]);

    if (!draft) {
      throw new Error("Import draft not found");
    }

    if (!ownerMember) {
      throw new Error("Member not found");
    }

    if (draft.status !== ImportDraftStatus.PENDING) {
      throw new Error("Import draft is already completed");
    }

    await tx.importDraftRow.updateMany({
      where: {
        draftId: draft.id,
        status: {
          notIn: [
            ImportDraftRowStatus.INVALID,
            ImportDraftRowStatus.SOURCE_DUPLICATE,
            ImportDraftRowStatus.USER_SKIPPED,
          ],
        },
      },
      data: {
        actorFallbackApplied: false,
        actorMemberId: ownerMember.id,
        createdByMemberId: ownerMember.id,
        creatorFallbackApplied: false,
      },
    });
  });
}

export async function saveWechatPayDraftOwnerMember(
  draftId: string,
  ownerMemberId: string,
  sessionUser: SessionUser,
) {
  return savePaymentImportDraftOwnerMember(draftId, ownerMemberId, sessionUser);
}

export async function getImportDraftSummary(
  draftId: string,
  sessionUser: SessionUser,
): Promise<ImportDraftSummary> {
  const draft = await loadDraftForSummary(draftId, sessionUser);

  return buildSummary(draft);
}

async function updateDraftRowsForMapping(input: {
  categoryId: string | null;
  draftId: string;
  mappingKey: string;
  rows: Array<Pick<ImportDraftRow, "id" | "mappingKey" | "duplicateCandidates" | "skipReason" | "status" | "userDecision">>;
  tx: Prisma.TransactionClient;
}) {
  const ignoredRowIds: string[] = [];
  const readyRowIds: string[] = [];
  const possibleDuplicateRowIds: string[] = [];

  for (const row of input.rows) {
    if (row.mappingKey !== input.mappingKey || isProtectedRefundReason(row.skipReason)) {
      continue;
    }

    if (input.categoryId === null) {
      if (row.status === ImportDraftRowStatus.NEEDS_MAPPING ||
        row.status === ImportDraftRowStatus.READY ||
        row.status === ImportDraftRowStatus.POSSIBLE_DUPLICATE) {
        ignoredRowIds.push(row.id);
      }
      continue;
    }

    const isMissingMapping = row.status === ImportDraftRowStatus.NEEDS_MAPPING &&
      row.userDecision === ImportRowDecision.KEEP;
    const isIgnoredMapping = row.status === ImportDraftRowStatus.USER_SKIPPED &&
      row.skipReason === CATEGORY_MAPPING_IGNORED;

    if (!isMissingMapping && !isIgnoredMapping) {
      continue;
    }

    if (hasDuplicateCandidates(row.duplicateCandidates)) {
      possibleDuplicateRowIds.push(row.id);
    } else {
      readyRowIds.push(row.id);
    }
  }

  for (const chunk of chunkArray(ignoredRowIds, confirmImportChunkSize)) {
    await input.tx.importDraftRow.updateMany({
      where: { draftId: input.draftId, id: { in: chunk }, mappingKey: input.mappingKey },
      data: {
        categoryId: null,
        skipReason: CATEGORY_MAPPING_IGNORED,
        status: ImportDraftRowStatus.USER_SKIPPED,
        userDecision: ImportRowDecision.SKIP,
      },
    });
  }

  for (const chunk of chunkArray(readyRowIds, confirmImportChunkSize)) {
    await input.tx.importDraftRow.updateMany({
      where: {
        draftId: input.draftId,
        id: { in: chunk },
        mappingKey: input.mappingKey,
      },
      data: {
        categoryId: input.categoryId,
        skipReason: null,
        status: ImportDraftRowStatus.READY,
        userDecision: ImportRowDecision.KEEP,
      },
    });
  }

  for (const chunk of chunkArray(possibleDuplicateRowIds, confirmImportChunkSize)) {
    await input.tx.importDraftRow.updateMany({
      where: {
        draftId: input.draftId,
        id: { in: chunk },
        mappingKey: input.mappingKey,
      },
      data: {
        categoryId: input.categoryId,
        skipReason: null,
        status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
        userDecision: ImportRowDecision.SKIP,
      },
    });
  }
}

export async function createCmbImportDraft(input: {
  buffer: Buffer;
  context?: EntryContext;
  fileName: string;
  password?: string;
  sessionUser: SessionUser;
}) {
  const parseWorkbook = input.fileName.toLowerCase().endsWith(".zip")
    ? (buffer: Buffer, signal?: AbortSignal) => parseCmbZip(buffer, input.password ?? "", signal)
    : parseCmbPdf;

  return createImportDraft({
    buffer: input.buffer,
    context: input.context,
    fileName: input.fileName,
    parseWorkbook,
    sessionUser: input.sessionUser,
    source: CMB_SOURCE,
  });
}

export async function saveImportDraftMappings(
  draftId: string,
  mappings: ImportDraftMappingInput[],
  sessionUser: SessionUser,
) {
  await requireHouseholdMember(sessionUser);

  if (mappings.some((mapping) =>
    typeof mapping.mappingKey !== "string" ||
    (mapping.categoryId !== null && typeof mapping.categoryId !== "string"),
  ) || new Set(mappings.map(({ mappingKey }) => mappingKey)).size !== mappings.length) {
    throw new Error("Invalid import draft mappings");
  }

  return db.$transaction(async (tx) => {
    await authorizeDraftMutation(tx, draftId, sessionUser);
    const lockedDrafts = await tx.$queryRaw<Array<{ id: string; status: ImportDraftStatus }>>`
      SELECT "id", "status"
      FROM "ImportDraft"
      WHERE "id" = ${draftId} AND "household_id" = ${sessionUser.householdId}
      FOR UPDATE
    `;
    const draft = lockedDrafts[0];

    if (!draft) {
      throw new Error("Import draft not found");
    }

    if (draft.status !== ImportDraftStatus.PENDING) {
      throw new Error("Import draft is already completed");
    }

    if (mappings.length === 0) {
      return;
    }

    const { source } = await tx.importDraft.findFirstOrThrow({
      where: { id: draftId, householdId: sessionUser.householdId },
      select: { source: true },
    });

    const parsedMappings = mappings.map((mapping) => {
      const parts = parseMappingKey(mapping.mappingKey);

      if (parts.source !== source) {
        throw new Error("Mapping source does not match import draft source");
      }

      return { ...mapping, parts };
    });
    const rows = await tx.importDraftRow.findMany({
      where: { draftId, mappingKey: { in: mappings.map(({ mappingKey }) => mappingKey) } },
      select: {
        categoryId: true, duplicateCandidates: true, id: true, mappingKey: true,
        skipReason: true, status: true, transactionType: true, userDecision: true,
      },
    });
    const draftMappingKeys = new Set(rows.map(({ mappingKey }) => mappingKey));
    const categories = await tx.category.findMany({
      where: {
        id: { in: [...new Set([
          ...mappings.flatMap(({ categoryId }) => categoryId === null ? [] : [categoryId]),
          ...rows.flatMap(({ categoryId }) => categoryId ? [categoryId] : []),
        ])] },
        isActive: true,
      },
      select: { id: true, type: true },
    });
    const categoryById = new Map(categories.map((category) => [category.id, category]));

    for (const mapping of parsedMappings) {
      if (!draftMappingKeys.has(mapping.mappingKey)) {
        throw new Error("Mapping group does not exist in import draft");
      }

      if (mapping.categoryId !== null) {
        const category = categoryById.get(mapping.categoryId);

        if (!category) {
          throw new Error("Category not found");
        }

        if (category.type !== transactionTypeToCategoryType[mapping.parts.transactionType]) {
          throw new Error("Category does not match transaction type");
        }
      }
    }

    await lockImportCategoryMappingRules(tx, sessionUser.householdId);

    for (const { categoryId, mappingKey, parts } of parsedMappings.sort((a, b) =>
      a.mappingKey < b.mappingKey ? -1 : a.mappingKey > b.mappingKey ? 1 : 0,
    )) {
      const key = { householdId: sessionUser.householdId, ...parts };
      const currentRows = rows.map((row) => row.categoryId && row.transactionType &&
        (row.status === ImportDraftRowStatus.READY || row.status === ImportDraftRowStatus.POSSIBLE_DUPLICATE) &&
        categoryById.get(row.categoryId)?.type !== transactionTypeToCategoryType[row.transactionType]
        ? { ...row, status: ImportDraftRowStatus.NEEDS_MAPPING } : row);

      await upsertImportCategoryMappingRule(tx, { ...key, categoryId });
      await updateDraftRowsForMapping({ categoryId, draftId, mappingKey, rows: currentRows, tx });
    }
  }, { timeout: 30_000 });
}

async function applyImportDraftRowDecisions(
  draftId: string,
  decisions: ImportDraftRowDecisionInput[],
  sessionUser: SessionUser,
  applyUnchangedDecision: boolean,
) {
  await requireHouseholdMember(sessionUser);

  if (
    decisions.length > 100 ||
    decisions.some(({ decision, rowId }) =>
      !rowId ||
      (decision !== ImportRowDecision.KEEP && decision !== ImportRowDecision.SKIP),
    ) ||
    new Set(decisions.map(({ rowId }) => rowId)).size !== decisions.length
  ) {
    throw new Error("Invalid import draft row decisions");
  }

  return db.$transaction(async (tx) => {
    await authorizeDraftMutation(tx, draftId, sessionUser);
    const lockedDraftRows = await tx.$queryRaw<Array<{ id: string; status: ImportDraftStatus }>>`
      SELECT "id", "status"
      FROM "ImportDraft"
      WHERE "id" = ${draftId}
        AND "household_id" = ${sessionUser.householdId}
      FOR UPDATE
    `;

    if (lockedDraftRows.length === 0) {
      throw new Error(applyUnchangedDecision ? "Import draft row not found" : "Import draft not found");
    }

    if (lockedDraftRows[0]?.status !== ImportDraftStatus.PENDING) {
      throw new Error("Import draft is already completed");
    }

    const rows = await tx.importDraftRow.findMany({
      where: {
        draftId,
        id: { in: decisions.map(({ rowId }) => rowId) },
      },
      select: {
        categoryId: true,
        duplicateCandidates: true,
        id: true,
        skipReason: true,
        status: true,
        userDecision: true,
      },
    });

    if (rows.length !== decisions.length) {
      throw new Error("Import draft row not found");
    }

    const decisionById = new Map(decisions.map(({ decision, rowId }) => [rowId, decision]));
    const updateGroups = new Map<ImportDraftRowStatus, {
      rowIds: string[];
      skipReason: string | null;
      userDecision: ImportRowDecision;
    }>();
    const results = rows.map((row) => {
      if (
        !isDecisionEditableStatus(row.status) ||
        isProtectedRefundReason(row.skipReason)
      ) {
        throw new Error("Import draft row decision cannot be changed");
      }

      const decision = decisionById.get(row.id)!;

      if (!applyUnchangedDecision && row.userDecision === decision) {
        return { id: row.id, status: row.status, userDecision: row.userDecision };
      }

      const status = decision === ImportRowDecision.SKIP
        ? ImportDraftRowStatus.USER_SKIPPED
        : getKeepRowStatus(row);
      const group = updateGroups.get(status) ?? {
        rowIds: [],
        skipReason: decision === ImportRowDecision.SKIP ? "User skipped" : null,
        userDecision: decision,
      };

      group.rowIds.push(row.id);
      updateGroups.set(status, group);

      return { id: row.id, status, userDecision: decision };
    });

    for (const [status, { rowIds, skipReason, userDecision }] of updateGroups) {
      await tx.importDraftRow.updateMany({
        where: { draftId, id: { in: rowIds } },
        data: { skipReason, status, userDecision },
      });
    }

    return results;
  }, { timeout: 15_000 });
}

export async function setImportDraftRowDecisions(
  draftId: string,
  decisions: ImportDraftRowDecisionInput[],
  sessionUser: SessionUser,
): Promise<void> {
  await applyImportDraftRowDecisions(draftId, decisions, sessionUser, false);
}

export async function setImportDraftRowDecision(
  draftId: string,
  rowId: string,
  decision: ImportRowDecision,
  sessionUser: SessionUser,
) {
  const results = await applyImportDraftRowDecisions(
    draftId, [{ decision, rowId }], sessionUser, true,
  );

  return results[0]!;
}

export async function getImportDuplicateCandidate(
  draftId: string,
  rowId: string,
  candidateId: string,
  sessionUser: SessionUser,
): Promise<ImportDuplicateCandidateDetail | null> {
  await requireHouseholdMember(sessionUser);

  const row = await db.importDraftRow.findFirst({
    where: {
      draft: { householdId: sessionUser.householdId },
      draftId,
      id: rowId,
    },
    select: { duplicateCandidates: true },
  });

  if (
    !row ||
    !Array.isArray(row.duplicateCandidates) ||
    !row.duplicateCandidates.some((candidate) =>
      candidate !== null &&
      typeof candidate === "object" &&
      !Array.isArray(candidate) &&
      candidate.id === candidateId,
    )
  ) {
    return null;
  }

  const candidate = await db.transaction.findFirst({
    where: {
      deletedAt: null,
      householdId: sessionUser.householdId,
      id: candidateId,
    },
    select: {
      actorMember: { select: { memberName: true } },
      amountFen: true,
      category: { select: { name: true } },
      createdByMember: { select: { memberName: true } },
      id: true,
      note: true,
      occurredAt: true,
      source: true,
      type: true,
    },
  });

  if (!candidate) {
    return null;
  }

  return {
    actorMemberName: candidate.actorMember.memberName,
    amountFen: candidate.amountFen,
    categoryName: candidate.category.name,
    createdByMemberName: candidate.createdByMember.memberName,
    id: candidate.id,
    note: candidate.note,
    occurredAt: candidate.occurredAt,
    source: candidate.source,
    type: candidate.type,
  };
}

async function refreshCmbRefundHistory(
  tx: Prisma.TransactionClient,
  householdId: string,
  rows: ImportDraftRow[],
) {
  const candidates = rows.filter((row) =>
    (row.status === ImportDraftRowStatus.USER_SKIPPED && row.skipReason === CMB_FULLY_REFUNDED) ||
    (row.userDecision === ImportRowDecision.KEEP &&
      (row.status === ImportDraftRowStatus.NEEDS_MAPPING || isImportableRow(row))),
  );
  const outcomes = await classifyCmbRefundHistory(tx, householdId, candidates);
  const duplicateIds: string[] = [];
  const manualIds: string[] = [];

  candidates.forEach((row, index) => {
    const outcome = outcomes[index];
    if (outcome === "NONE") return;

    const isDuplicate = outcome === "SOURCE_DUPLICATE";
    row.status = isDuplicate ? ImportDraftRowStatus.SOURCE_DUPLICATE : ImportDraftRowStatus.USER_SKIPPED;
    row.skipReason = isDuplicate ? "Source duplicate" : CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT;
    row.userDecision = ImportRowDecision.SKIP;
    (isDuplicate ? duplicateIds : manualIds).push(row.id);
  });

  await markRowsAsSourceDuplicates(tx, duplicateIds);
  for (const chunk of chunkArray(manualIds, confirmImportChunkSize)) {
    await tx.importDraftRow.updateMany({
      where: { id: { in: chunk } },
      data: {
        skipReason: CMB_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
        status: ImportDraftRowStatus.USER_SKIPPED,
        userDecision: ImportRowDecision.SKIP,
      },
    });
  }

  return duplicateIds.length > 0 || manualIds.length > 0;
}

type ConfirmationWaiter = { token: string; timeoutMs: number; ledgerId: string };
type ConfirmationAdmission = { completed: true } | { waiting: ConfirmationWaiter } | { lease: ResourceLease };

async function readConfirmationDraft(client: Prisma.TransactionClient | typeof db, draftId: string, session: SessionUser) {
  await resolveHouseholdContext(client, session);
  const draft = await client.importDraft.findFirst({
    where: { id: draftId, householdId: session.householdId },
    select: { status: true, ledgerId: true, createdByMember: { select: { leftAt: true, user: { select: { status: true } } } } },
  });
  if (!draft) throw new Error("Import draft not found");
  if (draft.status === ImportDraftStatus.PENDING) {
    if (draft.createdByMember.leftAt || draft.createdByMember.user.status !== UserStatus.ACTIVE) {
      throw new Error("Import draft creator is no longer active");
    }
    await resolveHouseholdContext(client, session, { ledgerId: draft.ledgerId });
  }
  return draft;
}

async function joinImportConfirmation(
  client: Prisma.TransactionClient | typeof db, draftId: string, session: SessionUser,
): Promise<Extract<ConfirmationAdmission, { completed: true } | { waiting: ConfirmationWaiter }> | null> {
  const draft = await readConfirmationDraft(client, draftId, session);
  if (draft.status === ImportDraftStatus.COMPLETED) return { completed: true };
  const taskKey = `import-confirm:${draftId}`;
  const [running] = await client.$queryRaw<Array<{ token: string; memberId: string }>>`
    SELECT token, member_id AS "memberId" FROM "ResourceLease"
    WHERE kind = 'import' AND household_id = ${session.householdId}
      AND task_key = ${taskKey} AND expires_at > clock_timestamp()
    LIMIT 1
  `;
  if (!running) return null;
  if (running.memberId !== session.memberId) throw new ResourceBusyError();
  // This one-row CAS takes no other locks. Waiting never acquires the owner's lease.
  const compareAndSwap = (tx: Prisma.TransactionClient) => tx.$queryRaw<Array<{ token: string; expiresAt: Date; now: Date }>>`
    UPDATE "ResourceLease" SET waiters = waiters + 1
    WHERE token = ${running.token} AND kind = 'import' AND household_id = ${session.householdId}
      AND member_id = ${session.memberId} AND task_key = ${taskKey}
      AND waiters < 2 AND expires_at > clock_timestamp()
    RETURNING token, expires_at AS "expiresAt", clock_timestamp() AS "now"
  `;
  const [joined] = "$transaction" in client
    ? await client.$transaction(compareAndSwap, { maxWait: 2000, timeout: 5000 })
    : await compareAndSwap(client);
  if (!joined) {
    const current = await readConfirmationDraft(client, draftId, session);
    if (current.status === ImportDraftStatus.COMPLETED) return { completed: true };
    throw new ResourceBusyError();
  }
  return { waiting: { token: joined.token, ledgerId: draft.ledgerId,
    timeoutMs: Math.min(125_000, Math.max(0, joined.expiresAt.getTime() - joined.now.getTime())) } };
}

async function waitForImportConfirmation(draftId: string, session: SessionUser, waiter: ConfirmationWaiter) {
  const deadline = performance.now() + waiter.timeoutMs;
  try {
    while (performance.now() < deadline) {
      const { draft, running } = await db.$transaction(async (tx) => {
        let current = await readConfirmationDraft(tx, draftId, session);
        if (current.status === ImportDraftStatus.COMPLETED) return { draft: current, running: false };
        const [active] = await tx.$queryRaw<Array<{ token: string }>>`
          SELECT token FROM "ResourceLease" WHERE token = ${waiter.token}
            AND kind = 'import' AND household_id = ${session.householdId} AND member_id = ${session.memberId}
            AND task_key = ${`import-confirm:${draftId}`} AND expires_at > clock_timestamp()
        `;
        if (!active) current = await readConfirmationDraft(tx, draftId, session);
        return { draft: current, running: Boolean(active) };
      }, { maxWait: 1000, timeout: Math.max(1, Math.min(5000, Math.ceil(deadline - performance.now()))) });
      if (draft.ledgerId !== waiter.ledgerId) throw new Error("Import draft target has changed");
      if (draft.status === ImportDraftStatus.COMPLETED) return confirmAdmittedImportDraft(draftId, session);
      if (!running) throw new ResourceBusyError();
      await new Promise<void>((resolve) => setTimeout(resolve, Math.min(500, Math.max(1, deadline - performance.now()))));
    }
    throw new ResourceBusyError();
  } finally {
    await db.resourceLease.updateMany({
      where: { token: waiter.token, kind: "import", householdId: session.householdId, memberId: session.memberId,
        taskKey: `import-confirm:${draftId}`, waiters: { gt: 0 } },
      data: { waiters: { decrement: 1 } },
    }).catch(() => undefined);
  }
}

export async function confirmImportDraft(
  draftId: string,
  sessionUser: SessionUser,
): Promise<ConfirmImportDraftResult> {
  await requireHouseholdMember(sessionUser);
  const existing = await joinImportConfirmation(db, draftId, sessionUser);
  if (existing) return "waiting" in existing
    ? waitForImportConfirmation(draftId, sessionUser, existing.waiting)
    : confirmAdmittedImportDraft(draftId, sessionUser);
  const admission: ConfirmationAdmission = await db.$transaction(async (tx) => {
    await authorizeDraftMutation(tx, draftId, sessionUser);
    const concurrent = await joinImportConfirmation(tx, draftId, sessionUser);
    if (concurrent) return concurrent;
    const draft = await tx.importDraft.findFirstOrThrow({
      where: { id: draftId, householdId: sessionUser.householdId }, select: { status: true, ledgerId: true },
    });
    return { lease: await acquireResourceLease(tx, sessionUser, "import", { ledgerId: draft.ledgerId, taskKey: `import-confirm:${draftId}` }) };
  }, { maxWait: 10_000, timeout: 15_000 });
  if ("waiting" in admission) return waitForImportConfirmation(draftId, sessionUser, admission.waiting);
  if ("completed" in admission) return confirmAdmittedImportDraft(draftId, sessionUser);
  return runWithResourceLease(admission.lease, () => confirmAdmittedImportDraft(draftId, sessionUser, admission.lease));
}

async function confirmAdmittedImportDraft(
  draftId: string,
  sessionUser: SessionUser,
  lease?: ResourceLease,
): Promise<ConfirmImportDraftResult> {
  return db.$transaction(async (tx) => {
    await authorizeDraftMutation(tx, draftId, sessionUser);
    if (lease) await assertResourceLease(tx, lease);

    const lockedDraftRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "ImportDraft"
      WHERE "id" = ${draftId}
        AND "household_id" = ${sessionUser.householdId}
      FOR UPDATE
    `;

    if (lockedDraftRows.length === 0) {
      throw new Error("Import draft not found");
    }

    const draft = await tx.importDraft.findFirst({
      where: {
        householdId: sessionUser.householdId,
        id: draftId,
      },
      include: {
        rows: {
          orderBy: [{ rowNumber: "asc" }, { id: "asc" }],
        },
      },
    });

    if (!draft) {
      throw new Error("Import draft not found");
    }

    const draftSource = draft.source as ImportSource;

    if (draft.status === ImportDraftStatus.COMPLETED) {
      if (lease) await assertResourceLease(tx, lease);
      return buildConfirmResultFromRows(
        draft.rows.map((row) => ({
          status: row.status,
          userDecision: row.userDecision,
        })),
        draftSource,
        false,
      );
    }

    if (draftSource === CMB_SOURCE &&
      await refreshCmbRefundHistory(tx, sessionUser.householdId, draft.rows)) {
      if (lease) await assertResourceLease(tx, lease);
      return {
        ...buildConfirmResultFromRows(draft.rows, draftSource, false),
        createdCount: 0,
        requiresReview: true,
      };
    }

    const needsMappingCount = draft.rows.filter(
      (row) =>
        row.status === ImportDraftRowStatus.NEEDS_MAPPING &&
        row.userDecision === ImportRowDecision.KEEP,
    ).length;

    if (needsMappingCount > 0) {
      throw new Error("Import draft has unresolved category mappings");
    }

    const unresolvedMemberMappingCount = draft.rows.filter((row) => {
      if (!isImportableRow({ status: row.status, userDecision: row.userDecision })) {
        return false;
      }

      return (
        (row.actorExternalName && row.actorFallbackApplied) ||
        (row.creatorExternalName && row.creatorFallbackApplied)
      );
    }).length;

    if (unresolvedMemberMappingCount > 0) {
      throw new Error("Import draft has unresolved member mappings");
    }

    const rowsToValidate = draft.rows.filter(isImportableRow);
    const memberIds = [...new Set(rowsToValidate.flatMap((row) =>
      [row.actorMemberId, row.createdByMemberId].filter((id): id is string => Boolean(id)),
    ))];
    const [members, categories] = await Promise.all([
      tx.householdMember.findMany({
        where: {
          householdId: sessionUser.householdId, id: { in: memberIds },
          leftAt: null, user: { status: UserStatus.ACTIVE },
        },
        select: { id: true },
      }),
      tx.category.findMany({
        where: { isActive: true, id: { in: [...new Set(rowsToValidate.flatMap(({ categoryId }) => categoryId ? [categoryId] : []))] } },
        select: { id: true, type: true },
      }),
    ]);
    const activeMemberIds = new Set(members.map(({ id }) => id));
    if (memberIds.some((id) => !activeMemberIds.has(id))) {
      throw new Error("Import draft has unresolved member mappings");
    }
    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const staleCategoryRowIds = rowsToValidate.filter((row) => row.categoryId && row.transactionType &&
      categoryById.get(row.categoryId)?.type !== transactionTypeToCategoryType[row.transactionType],
    ).map(({ id }) => id);
    if (staleCategoryRowIds.length > 0) {
      const staleIds = new Set(staleCategoryRowIds);
      for (const chunk of chunkArray(staleCategoryRowIds, confirmImportChunkSize)) {
        await tx.importDraftRow.updateMany({
          where: { draftId: draft.id, id: { in: chunk } },
          data: { categoryId: null, status: ImportDraftRowStatus.NEEDS_MAPPING },
        });
      }
      if (lease) await assertResourceLease(tx, lease);
      return {
        ...buildConfirmResultFromRows(draft.rows.map((row) => staleIds.has(row.id)
          ? { ...row, status: ImportDraftRowStatus.NEEDS_MAPPING } : row), draftSource, false),
        createdCount: 0,
        requiresReview: true,
      };
    }

    const result: ConfirmImportDraftResult = {
      completedNow: true,
      createdCount: 0,
      invalidCount: 0,
      needsMappingCount: 0,
      requiresReview: false,
      source: draftSource,
      sourceDuplicateCount: 0,
      userSkippedCount: 0,
    };
    const importedAt = new Date();
    const importableRows: ConfirmImportableRow[] = [];
    const sourceDuplicateRowIds: string[] = [];
    const seenFingerprints = new Set<string>();

    for (const row of draft.rows) {
      if (row.status === ImportDraftRowStatus.INVALID) {
        result.invalidCount += 1;
        continue;
      }

      if (row.status === ImportDraftRowStatus.SOURCE_DUPLICATE) {
        result.sourceDuplicateCount += 1;
        continue;
      }

      if (row.status === ImportDraftRowStatus.USER_SKIPPED) {
        result.userSkippedCount += 1;
        continue;
      }

      if (!isImportableRow({ status: row.status, userDecision: row.userDecision })) {
        continue;
      }

      if (
        !row.transactionType ||
        !row.actorMemberId ||
        !row.createdByMemberId ||
        !row.categoryId ||
        row.amountFen === null ||
        !row.occurredAt ||
        !row.sourceFingerprint
      ) {
        throw new Error("Import draft row is incomplete");
      }

      if (seenFingerprints.has(row.sourceFingerprint)) {
        sourceDuplicateRowIds.push(row.id);
        result.sourceDuplicateCount += 1;
        continue;
      }

      seenFingerprints.add(row.sourceFingerprint);
      importableRows.push({
        actorMemberId: row.actorMemberId,
        amountFen: row.amountFen,
        categoryId: row.categoryId,
        createdByMemberId: row.createdByMemberId,
        id: row.id,
        note: row.note,
        occurredAt: row.occurredAt,
        refundOriginalAmountFen: parseWechatRefundOriginalAmountFen(
          draftSource,
          row.rawAmount,
          row.amountFen,
        ),
        rowNumber: row.rowNumber,
        sourceFingerprint: row.sourceFingerprint,
        transactionType: row.transactionType,
      });
    }

    const [existingSourceAmounts, wechatLegacyAmountsByOccurredAt] = await Promise.all([
      findExistingSourceAmounts(
        tx,
        sessionUser.householdId,
        draftSource,
        importableRows.map((row) => row.sourceFingerprint),
      ),
      draftSource === WECHAT_PAY_SOURCE
        ? findWechatLegacyAmountsByOccurredAtForConfirmation(
            tx,
            sessionUser.householdId,
            importableRows,
          )
        : Promise.resolve(new Map<string, number[]>()),
    ]);
    const refundManualAdjustmentRowIds: string[] = [];
    let refundHistoryChanged = false;
    const rowsToCreate = [];

    for (const row of importableRows) {
      const stableAmounts = existingSourceAmounts.get(row.sourceFingerprint) ?? [];

      if (row.refundOriginalAmountFen !== undefined) {
        const originalAmountFen = row.refundOriginalAmountFen;
        const legacyAmounts = (
          wechatLegacyAmountsByOccurredAt.get(wechatLegacyOccurredAtKey(row.occurredAt)) ?? []
        ).filter((amountFen) => amountFen >= row.amountFen && amountFen <= originalAmountFen);
        const historyOutcome = classifyWechatRefundHistory({
          amountFen: row.amountFen,
          legacyAmounts,
          refundHandling: "WECHAT_PARTIAL",
          stableAmounts,
        });

        if (historyOutcome !== "NONE") {
          if (historyOutcome === "SOURCE_DUPLICATE") {
            sourceDuplicateRowIds.push(row.id);
          } else {
            refundManualAdjustmentRowIds.push(row.id);
          }

          result.sourceDuplicateCount += 1;
          refundHistoryChanged = true;
          continue;
        }
      } else if (stableAmounts.length > 0) {
        sourceDuplicateRowIds.push(row.id);
        result.sourceDuplicateCount += 1;
        continue;
      }

      rowsToCreate.push(row);
    }

    if (sourceDuplicateRowIds.length > 0) {
      await markRowsAsSourceDuplicates(tx, sourceDuplicateRowIds);
    }

    if (refundManualAdjustmentRowIds.length > 0) {
      await markRowsAsSourceDuplicates(
        tx,
        refundManualAdjustmentRowIds,
        WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
      );
    }

    if (refundHistoryChanged) {
      if (lease) await assertResourceLease(tx, lease);
      return {
        ...result,
        completedNow: false,
        requiresReview: true,
      };
    }

    const insertedFingerprints = await insertImportTransactions(
      tx,
      sessionUser.householdId,
      draft.ledgerId,
      draftSource,
      rowsToCreate,
      importedAt,
    );
    const conflictRowIds = [];

    for (const row of rowsToCreate) {
      if (insertedFingerprints.has(row.sourceFingerprint)) {
        result.createdCount += 1;
      } else {
        conflictRowIds.push(row.id);
        result.sourceDuplicateCount += 1;
      }
    }

    if (conflictRowIds.length > 0) {
      await markRowsAsSourceDuplicates(tx, conflictRowIds);
    }

    await tx.importDraft.update({
      where: { id: draft.id },
      data: {
        completedAt: importedAt,
        status: ImportDraftStatus.COMPLETED,
      },
    });
    await recordLedgerAudit(tx, {
      context: { householdId: sessionUser.householdId, memberId: sessionUser.memberId, ledgerId: draft.ledgerId },
      action: "IMPORT_CONFIRMED", targetId: draft.id,
    });
    if (lease) await assertResourceLease(tx, lease);
    return result;
  }, { timeout: 120_000 });
}
