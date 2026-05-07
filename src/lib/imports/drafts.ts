import { randomUUID } from "node:crypto";

import {
  CategoryType,
  ImportDraftRowStatus,
  ImportDraftStatus,
  ImportRowDecision,
  Prisma,
  TransactionType,
} from "@prisma/client";

import { db } from "@/lib/db";
import { buildImportCategoryMappingKey } from "@/lib/imports/category-mapping";
import { resolveImportedMember } from "@/lib/imports/member-mapping";
import { parseSuiShouJiWorkbook } from "@/lib/imports/sources/sui-shou-ji";
import { parseWechatPayWorkbook } from "@/lib/imports/sources/wechat-pay";
import {
  type HouseholdMemberOption,
  type ImportSource,
  type InvalidImportRow,
  type ParsedImportRow,
  type ParsedImportWorkbook,
  SUI_SHOU_JI_SOURCE,
  WECHAT_PAY_SOURCE,
} from "@/lib/imports/types";

type SessionUser = {
  householdId: string;
  memberId: string;
};

type ImportDraftMappingInput = {
  categoryId: string;
  mappingKey: string;
};

type DuplicateCandidate = {
  amountFen: number;
  categoryId: string;
  id: string;
  occurredAt: string;
  source: string | null;
  type: TransactionType;
};

type ImportDraftRowSummary = {
  actorFallbackApplied: boolean;
  actorMemberId: string | null;
  amountFen: number | null;
  categoryId: string | null;
  createdByMemberId: string | null;
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
  rowNumber: number;
  secondaryCategory: string | null;
  skipReason: string | null;
  sourceFingerprint: string | null;
  status: ImportDraftRowStatus;
  transactionType: TransactionType | null;
  userDecision: ImportRowDecision;
};

type ImportDraftSummary = {
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
  id: string;
  missingMappings: Array<{
    count: number;
    mappingKey: string;
    primaryCategory: string | null;
    secondaryCategory: string | null;
    transactionType: TransactionType | null;
  }>;
  rows: ImportDraftRowSummary[];
  source: ImportSource;
  status: ImportDraftStatus;
};

type ConfirmImportDraftResult = {
  createdCount: number;
  invalidCount: number;
  needsMappingCount: number;
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
  const [source, transactionType, primaryCategory, secondaryCategory] = mappingKey.split("|");

  if (
    (source !== SUI_SHOU_JI_SOURCE && source !== WECHAT_PAY_SOURCE) ||
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

async function findExistingSourceFingerprints(
  tx: Prisma.TransactionClient,
  householdId: string,
  source: ImportSource,
  fingerprints: string[],
) {
  const existing = new Set<string>();

  for (const chunk of chunkArray(fingerprints, confirmImportChunkSize)) {
    const rows = await tx.transaction.findMany({
      where: {
        householdId,
        source,
        sourceFingerprint: { in: chunk },
      },
      select: { sourceFingerprint: true },
    });

    for (const row of rows) {
      if (row.sourceFingerprint) {
        existing.add(row.sourceFingerprint);
      }
    }
  }

  return existing;
}

async function markRowsAsSourceDuplicates(tx: Prisma.TransactionClient, rowIds: string[]) {
  for (const chunk of chunkArray(rowIds, confirmImportChunkSize)) {
    await tx.importDraftRow.updateMany({
      where: { id: { in: chunk } },
      data: {
        skipReason: "Source duplicate",
        status: ImportDraftRowStatus.SOURCE_DUPLICATE,
        userDecision: ImportRowDecision.SKIP,
      },
    });
  }
}

async function insertImportTransactions(
  tx: Prisma.TransactionClient,
  householdId: string,
  source: ImportSource,
  rows: ConfirmImportableRow[],
  importedAt: Date,
) {
  const insertedFingerprints = new Set<string>();

  for (const chunk of chunkArray(rows, confirmImportChunkSize)) {
    const inserted = await tx.$queryRaw<Array<{ sourceFingerprint: string }>>(Prisma.sql`
      INSERT INTO "Transaction" (
        "id",
        "household_id",
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
  createdAt: Date;
  fileName: string;
  id: string;
  rows: Array<{
    actorFallbackApplied: boolean;
    actorMemberId: string | null;
    amountFen: number | null;
    categoryId: string | null;
    createdByMemberId: string | null;
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
    rowNumber: number;
    secondaryCategory: string | null;
    skipReason: string | null;
    sourceFingerprint: string | null;
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
  const missingMappingGroups = new Map<
    string,
    {
      count: number;
      mappingKey: string;
      primaryCategory: string | null;
      secondaryCategory: string | null;
      transactionType: TransactionType | null;
    }
  >();

  for (const row of rows) {
    if (row.status !== ImportDraftRowStatus.NEEDS_MAPPING || !row.mappingKey) {
      continue;
    }

    const current = missingMappingGroups.get(row.mappingKey);

    if (current) {
      current.count += 1;
    } else {
      missingMappingGroups.set(row.mappingKey, {
        count: 1,
        mappingKey: row.mappingKey,
        primaryCategory: row.primaryCategory,
        secondaryCategory: row.secondaryCategory,
        transactionType: row.transactionType,
      });
    }
  }

  return {
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
    id: draft.id,
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
): ConfirmImportDraftResult {
  return {
    createdCount: rows.filter(isImportableRow).length,
    invalidCount: rows.filter((row) => row.status === ImportDraftRowStatus.INVALID).length,
    needsMappingCount: rows.filter((row) => row.status === ImportDraftRowStatus.NEEDS_MAPPING)
      .length,
    sourceDuplicateCount: rows.filter(
      (row) => row.status === ImportDraftRowStatus.SOURCE_DUPLICATE,
    ).length,
    userSkippedCount: rows.filter((row) => row.status === ImportDraftRowStatus.USER_SKIPPED)
      .length,
  };
}

async function requireHouseholdMember(sessionUser: SessionUser) {
  const [currentMember, householdMembers] = await Promise.all([
    db.householdMember.findFirst({
      where: {
        householdId: sessionUser.householdId,
        id: sessionUser.memberId,
      },
      select: { id: true, memberName: true },
    }),
    db.householdMember.findMany({
      where: { householdId: sessionUser.householdId },
      orderBy: { joinedAt: "asc" },
      select: { id: true, memberName: true },
    }),
  ]);

  if (!currentMember) {
    throw new Error("Unauthorized");
  }

  return {
    currentMember,
    householdMembers: householdMembers satisfies HouseholdMemberOption[],
  };
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
      primaryCategory: true,
      secondaryCategory: true,
      source: true,
      transactionType: true,
    },
  });
  const mappingByKey = new Map<string, string>();

  for (const mapping of mappings) {
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

async function findSourceDuplicateFingerprints(
  householdId: string,
  source: ImportSource,
  fingerprints: string[],
) {
  const rows = await db.transaction.findMany({
    where: {
      householdId,
      source,
      sourceFingerprint: { in: fingerprints },
    },
    select: { sourceFingerprint: true },
  });

  return new Set(rows.flatMap((row) => (row.sourceFingerprint ? [row.sourceFingerprint] : [])));
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

function buildParsedRowCreateInput(input: {
  categoryId: string | null;
  currentMemberId: string;
  duplicateCandidates: DuplicateCandidate[];
  householdMembers: HouseholdMemberOption[];
  isSourceDuplicate: boolean;
  row: ParsedImportRow;
}) {
  const actor = resolveImportedMember(
    input.row.rawMember || input.row.rawCreatedBy,
    input.householdMembers,
    input.currentMemberId,
  );
  const createdBy = resolveImportedMember(
    input.row.rawCreatedBy,
    input.householdMembers,
    input.currentMemberId,
  );
  const status = input.isSourceDuplicate
    ? ImportDraftRowStatus.SOURCE_DUPLICATE
    : input.categoryId
      ? input.duplicateCandidates.length > 0
        ? ImportDraftRowStatus.POSSIBLE_DUPLICATE
        : ImportDraftRowStatus.READY
      : ImportDraftRowStatus.NEEDS_MAPPING;

  return {
    actorFallbackApplied: actor.fallbackApplied,
    actorMemberId: actor.memberId,
    amountFen: input.row.amountFen,
    categoryId: input.categoryId,
    createdByMemberId: createdBy.memberId,
    creatorFallbackApplied: createdBy.fallbackApplied,
    duplicateCandidates: input.duplicateCandidates,
    mappingKey: input.row.mappingKey,
    note: input.row.note,
    occurredAt: input.row.occurredAt,
    occurredDate: input.row.occurredAtDate,
    primaryCategory: input.row.primaryCategory,
    rawAmount: input.row.rawAmount,
    rawCreatedBy: input.row.rawCreatedBy,
    rawCurrency: input.row.rawCurrency,
    rawDate: input.row.rawDate,
    rawMember: input.row.rawMember,
    rawTransactionType: input.row.rawTransactionType,
    rowNumber: input.row.rowNumber,
    secondaryCategory: input.row.secondaryCategory,
    sourceFingerprint: input.row.sourceFingerprint,
    status,
    transactionType: input.row.transactionType,
    userDecision: input.isSourceDuplicate ? ImportRowDecision.SKIP : ImportRowDecision.KEEP,
  };
}

function buildInvalidRowCreateInput(row: InvalidImportRow) {
  return {
    rawAmount: row.rawAmount ?? null,
    rawCreatedBy: row.rawCreatedBy ?? null,
    rawCurrency: row.rawCurrency ?? null,
    rawDate: row.rawDate ?? null,
    rawMember: row.rawMember ?? null,
    rawTransactionType: row.rawTransactionType ?? null,
    rowNumber: row.rowNumber ?? 0,
    skipReason: row.reason,
    status: ImportDraftRowStatus.INVALID,
    userDecision: ImportRowDecision.SKIP,
  };
}

async function loadDraftForSummary(draftId: string, sessionUser: SessionUser) {
  await requireHouseholdMember(sessionUser);

  const draft = await db.importDraft.findFirst({
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

  return draft;
}

async function createImportDraft(input: {
  buffer: Buffer;
  fileName: string;
  parseWorkbook: (buffer: Buffer) => Promise<ParsedImportWorkbook>;
  sessionUser: SessionUser;
  source: ImportSource;
}) {
  const { currentMember, householdMembers } = await requireHouseholdMember(input.sessionUser);
  const parsedWorkbook = await input.parseWorkbook(input.buffer);
  const mappingKeys = parsedWorkbook.rows.map((row) => row.mappingKey);
  const [categoryMappings, sourceDuplicateFingerprints] = await Promise.all([
    loadCategoryMappings(input.sessionUser.householdId, input.source, mappingKeys),
    findSourceDuplicateFingerprints(
      input.sessionUser.householdId,
      input.source,
      parsedWorkbook.rows.map((row) => row.sourceFingerprint),
    ),
  ]);
  const possibleDuplicateCandidatesByKey = await findPossibleDuplicateCandidatesByKey({
    householdId: input.sessionUser.householdId,
    rows: parsedWorkbook.rows,
    source: input.source,
  });
  const parsedRowCreateInputs = [];

  for (const row of parsedWorkbook.rows) {
    const duplicateCandidates =
      possibleDuplicateCandidatesByKey.get(
        possibleDuplicateLookupKey(row.occurredAtDate, row.amountFen),
      ) ?? [];

    parsedRowCreateInputs.push(
      buildParsedRowCreateInput({
        categoryId: categoryMappings.get(row.mappingKey) ?? null,
        currentMemberId: currentMember.id,
        duplicateCandidates,
        householdMembers,
        isSourceDuplicate: sourceDuplicateFingerprints.has(row.sourceFingerprint),
        row,
      }),
    );
  }

  return db.importDraft.create({
    data: {
      createdByMemberId: currentMember.id,
      fileName: input.fileName,
      householdId: input.sessionUser.householdId,
      rows: {
        create: [
          ...parsedRowCreateInputs,
          ...parsedWorkbook.invalidRows.map(buildInvalidRowCreateInput),
        ],
      },
      source: input.source,
    },
    select: {
      id: true,
      status: true,
    },
  });
}

export async function createSuiShouJiImportDraft(input: {
  buffer: Buffer;
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
  fileName: string;
  sessionUser: SessionUser;
}) {
  return createImportDraft({
    ...input,
    parseWorkbook: parseWechatPayWorkbook,
    source: WECHAT_PAY_SOURCE,
  });
}

export async function saveWechatPayDraftOwnerMember(
  draftId: string,
  ownerMemberId: string,
  sessionUser: SessionUser,
) {
  await requireHouseholdMember(sessionUser);

  await db.$transaction(async (tx) => {
    const lockedDraftRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "ImportDraft"
      WHERE "id" = ${draftId}
        AND "household_id" = ${sessionUser.householdId}
        AND "source" = ${WECHAT_PAY_SOURCE}
      FOR UPDATE
    `;

    if (lockedDraftRows.length === 0) {
      throw new Error("Import draft not found");
    }

    const [draft, ownerMember] = await Promise.all([
      tx.importDraft.findFirst({
        where: {
          householdId: sessionUser.householdId,
          id: draftId,
          source: WECHAT_PAY_SOURCE,
        },
        select: { id: true, status: true },
      }),
      tx.householdMember.findFirst({
        where: {
          householdId: sessionUser.householdId,
          id: ownerMemberId,
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
          notIn: [ImportDraftRowStatus.INVALID, ImportDraftRowStatus.SOURCE_DUPLICATE],
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

export async function getImportDraftSummary(
  draftId: string,
  sessionUser: SessionUser,
): Promise<ImportDraftSummary> {
  const draft = await loadDraftForSummary(draftId, sessionUser);

  return buildSummary(draft);
}

async function updateDraftRowsForMapping(input: {
  categoryId: string;
  draftId: string;
  mappingKey: string;
}) {
  const rows = await db.importDraftRow.findMany({
    where: {
      draftId: input.draftId,
      mappingKey: input.mappingKey,
      status: ImportDraftRowStatus.NEEDS_MAPPING,
    },
    select: {
      duplicateCandidates: true,
      id: true,
    },
  });
  const readyRowIds: string[] = [];
  const possibleDuplicateRowIds: string[] = [];

  for (const row of rows) {
    if (hasDuplicateCandidates(row.duplicateCandidates)) {
      possibleDuplicateRowIds.push(row.id);
    } else {
      readyRowIds.push(row.id);
    }
  }

  for (const chunk of chunkArray(readyRowIds, confirmImportChunkSize)) {
    await db.importDraftRow.updateMany({
      where: {
        draftId: input.draftId,
        id: { in: chunk },
        mappingKey: input.mappingKey,
        status: ImportDraftRowStatus.NEEDS_MAPPING,
      },
      data: {
        categoryId: input.categoryId,
        status: ImportDraftRowStatus.READY,
        userDecision: ImportRowDecision.KEEP,
      },
    });
  }

  for (const chunk of chunkArray(possibleDuplicateRowIds, confirmImportChunkSize)) {
    await db.importDraftRow.updateMany({
      where: {
        draftId: input.draftId,
        id: { in: chunk },
        mappingKey: input.mappingKey,
        status: ImportDraftRowStatus.NEEDS_MAPPING,
      },
      data: {
        categoryId: input.categoryId,
        status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
        userDecision: ImportRowDecision.KEEP,
      },
    });
  }
}

export async function saveImportDraftMappings(
  draftId: string,
  mappings: ImportDraftMappingInput[],
  sessionUser: SessionUser,
) {
  await requireHouseholdMember(sessionUser);

  const draft = await db.importDraft.findFirst({
    where: {
      householdId: sessionUser.householdId,
      id: draftId,
    },
    select: { id: true, source: true },
  });

  if (!draft) {
    throw new Error("Import draft not found");
  }

  for (const mapping of mappings) {
    const mappingKeyParts = parseMappingKey(mapping.mappingKey);

    if (mappingKeyParts.source !== draft.source) {
      throw new Error("Mapping source does not match import draft source");
    }

    const category = await db.category.findFirst({
      where: { id: mapping.categoryId, isActive: true },
      select: { id: true, type: true },
    });

    if (!category) {
      throw new Error("Category not found");
    }

    if (category.type !== transactionTypeToCategoryType[mappingKeyParts.transactionType]) {
      throw new Error("Category does not match transaction type");
    }

    await db.importCategoryMapping.upsert({
      where: {
        household_source_type_primary_secondary: {
          householdId: sessionUser.householdId,
          primaryCategory: mappingKeyParts.primaryCategory,
          secondaryCategory: mappingKeyParts.secondaryCategory,
          source: mappingKeyParts.source,
          transactionType: mappingKeyParts.transactionType,
        },
      },
      create: {
        categoryId: category.id,
        householdId: sessionUser.householdId,
        primaryCategory: mappingKeyParts.primaryCategory,
        secondaryCategory: mappingKeyParts.secondaryCategory,
        source: mappingKeyParts.source,
        transactionType: mappingKeyParts.transactionType,
      },
      update: {
        categoryId: category.id,
      },
    });

    await updateDraftRowsForMapping({
      categoryId: category.id,
      draftId: draft.id,
      mappingKey: mapping.mappingKey,
    });
  }
}

export async function setImportDraftRowDecision(
  draftId: string,
  rowId: string,
  decision: ImportRowDecision,
  sessionUser: SessionUser,
) {
  await requireHouseholdMember(sessionUser);

  const row = await db.importDraftRow.findFirst({
    where: {
      draftId,
      draft: {
        householdId: sessionUser.householdId,
      },
      id: rowId,
    },
    select: {
      draft: {
        select: { status: true },
      },
      duplicateCandidates: true,
      id: true,
      status: true,
    },
  });

  if (!row) {
    throw new Error("Import draft row not found");
  }

  if (row.draft.status !== ImportDraftStatus.PENDING) {
    throw new Error("Import draft is already completed");
  }

  if (
    row.status !== ImportDraftRowStatus.POSSIBLE_DUPLICATE &&
    row.status !== ImportDraftRowStatus.USER_SKIPPED
  ) {
    throw new Error("Import draft row decision cannot be changed");
  }

  if (decision === ImportRowDecision.SKIP) {
    return db.importDraftRow.update({
      where: { id: row.id },
      data: {
        skipReason: "User skipped",
        status: ImportDraftRowStatus.USER_SKIPPED,
        userDecision: ImportRowDecision.SKIP,
      },
      select: { id: true, status: true, userDecision: true },
    });
  }

  return db.importDraftRow.update({
    where: { id: row.id },
    data: {
      skipReason: null,
      status: hasDuplicateCandidates(row.duplicateCandidates)
        ? ImportDraftRowStatus.POSSIBLE_DUPLICATE
        : ImportDraftRowStatus.READY,
      userDecision: ImportRowDecision.KEEP,
    },
    select: { id: true, status: true, userDecision: true },
  });
}

export async function confirmImportDraft(
  draftId: string,
  sessionUser: SessionUser,
): Promise<ConfirmImportDraftResult> {
  await requireHouseholdMember(sessionUser);

  return db.$transaction(async (tx) => {
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
      return buildConfirmResultFromRows(
        draft.rows.map((row) => ({
          status: row.status,
          userDecision: row.userDecision,
        })),
      );
    }

    const needsMappingCount = draft.rows.filter(
      (row) => row.status === ImportDraftRowStatus.NEEDS_MAPPING,
    ).length;

    if (needsMappingCount > 0) {
      throw new Error("Import draft has unresolved category mappings");
    }

    const result: ConfirmImportDraftResult = {
      createdCount: 0,
      invalidCount: 0,
      needsMappingCount: 0,
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
        rowNumber: row.rowNumber,
        sourceFingerprint: row.sourceFingerprint,
        transactionType: row.transactionType,
      });
    }

    const existingSourceFingerprints = await findExistingSourceFingerprints(
      tx,
      sessionUser.householdId,
      draftSource,
      importableRows.map((row) => row.sourceFingerprint),
    );
    const rowsToCreate = [];

    for (const row of importableRows) {
      if (existingSourceFingerprints.has(row.sourceFingerprint)) {
        sourceDuplicateRowIds.push(row.id);
        result.sourceDuplicateCount += 1;
      } else {
        rowsToCreate.push(row);
      }
    }

    if (sourceDuplicateRowIds.length > 0) {
      await markRowsAsSourceDuplicates(tx, sourceDuplicateRowIds);
    }

    const insertedFingerprints = await insertImportTransactions(
      tx,
      sessionUser.householdId,
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

    return result;
  }, { timeout: 120_000 });
}
