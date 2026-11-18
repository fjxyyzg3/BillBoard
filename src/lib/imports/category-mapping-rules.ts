import { randomUUID } from "node:crypto";

import type { Prisma, TransactionType } from "@prisma/client";
import { isEncryptedRequest } from "@/lib/encryption/request-context";

export type SavedImportCategoryMappingRule = {
  id: string;
  categoryId: string | null;
  updatedAt: Date;
};

export async function lockImportCategoryMappingRules(tx: Prisma.TransactionClient, householdId: string) {
  // Draft writers take their draft lock first; rule-only writers never lock drafts.
  await tx.$queryRaw`
    SELECT pg_advisory_xact_lock(hashtextextended(${`import-category-rules:${householdId}`}, 0))::text
  `;
}

export async function upsertImportCategoryMappingRule(
  tx: Prisma.TransactionClient,
  input: {
    householdId: string;
    source: string;
    transactionType: TransactionType;
    primaryCategory: string;
    secondaryCategory: string;
    categoryId: string | null;
  },
) {
  const now = new Date(Date.now());
  if (isEncryptedRequest()) {
    await lockImportCategoryMappingRules(tx, input.householdId);
    const { categoryId, ...key } = input;
    const where = { household_source_type_primary_secondary: key };
    const existing = await tx.importCategoryMapping.findUnique({ where, select: { updatedAt: true } });
    return tx.importCategoryMapping.upsert({
      where,
      create: { ...input, id: randomUUID(), createdAt: now, updatedAt: now },
      update: { categoryId, updatedAt: new Date(Math.max(now.getTime(), (existing?.updatedAt.getTime() ?? -1) + 1)) },
      select: { id: true, categoryId: true, updatedAt: true },
    });
  }
  const saved = await tx.$queryRaw<SavedImportCategoryMappingRule[]>`
    INSERT INTO "ImportCategoryMapping"
      ("id", "household_id", "source", "transaction_type", "primary_category",
       "secondary_category", "category_id", "created_at", "updated_at")
    VALUES (${randomUUID()}, ${input.householdId}, ${input.source}, ${input.transactionType}::"TransactionType",
      ${input.primaryCategory}, ${input.secondaryCategory}, ${input.categoryId}, ${now}, ${now})
    ON CONFLICT ("household_id", "source", "transaction_type", "primary_category", "secondary_category")
    DO UPDATE SET "category_id" = EXCLUDED."category_id",
      "updated_at" = GREATEST("ImportCategoryMapping"."updated_at" + INTERVAL '1 millisecond', EXCLUDED."updated_at")
    RETURNING "id", "category_id" AS "categoryId", "updated_at" AS "updatedAt"
  `;
  return saved[0];
}

export async function updateImportCategoryMappingRule(
  tx: Prisma.TransactionClient,
  input: { id: string; householdId: string; categoryId: string | null; expectedUpdatedAt: Date },
) {
  const now = new Date(Date.now());
  if (isEncryptedRequest()) {
    await lockImportCategoryMappingRules(tx, input.householdId);
    const saved = await tx.importCategoryMapping.updateManyAndReturn({
      where: { id: input.id, householdId: input.householdId, updatedAt: input.expectedUpdatedAt },
      data: { categoryId: input.categoryId, updatedAt: new Date(Math.max(now.getTime(), input.expectedUpdatedAt.getTime() + 1)) },
      select: { id: true, categoryId: true, updatedAt: true },
    });
    return saved[0];
  }
  const saved = await tx.$queryRaw<SavedImportCategoryMappingRule[]>`
    UPDATE "ImportCategoryMapping"
    SET "category_id" = ${input.categoryId},
      "updated_at" = GREATEST("updated_at" + INTERVAL '1 millisecond', ${now})
    WHERE "id" = ${input.id} AND "household_id" = ${input.householdId}
      AND "updated_at" = ${input.expectedUpdatedAt}
    RETURNING "id", "category_id" AS "categoryId", "updated_at" AS "updatedAt"
  `;
  return saved[0];
}
