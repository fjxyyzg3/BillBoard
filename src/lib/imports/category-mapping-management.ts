import { CategoryType, TransactionType } from "@prisma/client";

import { type HouseholdSession, resolveHouseholdContext } from "@/lib/auth/household-context";
import { db } from "@/lib/db";
import { lockImportCategoryMappingRules, updateImportCategoryMappingRule } from "@/lib/imports/category-mapping-rules";
import { ALIPAY_SOURCE, CMB_SOURCE, type ImportSource, SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE } from "@/lib/imports/types";

type SessionUser = HouseholdSession;

const supportedSources: ImportSource[] = [SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE, ALIPAY_SOURCE, CMB_SOURCE];

export type ManagedImportCategoryMapping = {
  id: string;
  source: ImportSource;
  transactionType: TransactionType;
  primaryCategory: string;
  secondaryCategory: string;
  categoryId: string | null;
  categoryName: string | null;
  categoryIsActive: boolean | null;
  updatedAt: string;
};

export type ManagedImportCategoryMappingChange = {
  id: string;
  categoryId: string | null;
  expectedUpdatedAt: string;
};

export class ImportCategoryMappingConflictError extends Error {
  constructor() {
    super("Import category mapping changed");
    this.name = "ImportCategoryMappingConflictError";
  }
}

async function requireHouseholdMember(sessionUser: SessionUser) {
  await resolveHouseholdContext(db, sessionUser);
}

export async function getImportCategoryMappingManagement(sessionUser: SessionUser) {
  await requireHouseholdMember(sessionUser);
  const [rules, categories] = await Promise.all([
    db.importCategoryMapping.findMany({
      where: { householdId: sessionUser.householdId, source: { in: supportedSources } },
      orderBy: [{ source: "asc" }, { transactionType: "asc" }, { primaryCategory: "asc" }, { secondaryCategory: "asc" }, { id: "asc" }],
      select: {
        id: true, source: true, transactionType: true, primaryCategory: true, secondaryCategory: true,
        categoryId: true, updatedAt: true, category: { select: { name: true, isActive: true } },
      },
    }),
    db.category.findMany({
      where: { isActive: true }, orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true },
    }),
  ]);
  const mappings: ManagedImportCategoryMapping[] = rules.map(({ category, ...rule }) => ({
    ...rule, source: rule.source as ImportSource,
    categoryName: category?.name ?? null, categoryIsActive: category?.isActive ?? null,
    updatedAt: rule.updatedAt.toISOString(),
  }));
  return { mappings, categories };
}

export async function saveManagedImportCategoryMappings(
  changes: ManagedImportCategoryMappingChange[],
  sessionUser: SessionUser,
) {
  await requireHouseholdMember(sessionUser);
  if (!Array.isArray(changes) || changes.some((change) =>
    !change || typeof change.id !== "string" || !change.id.trim() ||
    (change.categoryId !== null && (typeof change.categoryId !== "string" || !change.categoryId.trim())) ||
    typeof change.expectedUpdatedAt !== "string" ||
    !Number.isFinite(Date.parse(change.expectedUpdatedAt)) ||
    new Date(change.expectedUpdatedAt).toISOString() !== change.expectedUpdatedAt,
  ) || new Set(changes.map(({ id }) => id)).size !== changes.length) {
    throw new Error("Invalid import category mapping changes");
  }
  if (changes.length === 0) {
    return [];
  }

  return db.$transaction(async (tx) => {
    await resolveHouseholdContext(tx, sessionUser, { lock: true });
    await lockImportCategoryMappingRules(tx, sessionUser.householdId);
    const rules = await tx.importCategoryMapping.findMany({
      where: { householdId: sessionUser.householdId, id: { in: changes.map(({ id }) => id) }, source: { in: supportedSources } },
      select: { id: true, categoryId: true, transactionType: true, updatedAt: true },
    });
    const ruleById = new Map(rules.map((rule) => [rule.id, rule]));
    const categories = await tx.category.findMany({
      where: { isActive: true, id: { in: [...new Set(changes.flatMap(({ categoryId }) => categoryId === null ? [] : [categoryId]))] } },
      select: { id: true, type: true },
    });
    const categoryById = new Map(categories.map((category) => [category.id, category]));
    const changedRules = [];

    for (const change of changes) {
      const rule = ruleById.get(change.id);
      if (!rule) {
        throw new Error("Import category mapping not found");
      }
      if (rule.updatedAt.toISOString() !== change.expectedUpdatedAt) {
        throw new ImportCategoryMappingConflictError();
      }
      if (change.categoryId !== null) {
        const category = categoryById.get(change.categoryId);
        const expectedType = rule.transactionType === TransactionType.INCOME ? CategoryType.INCOME : CategoryType.EXPENSE;
        if (!category || category.type !== expectedType) {
          throw new Error("Invalid import category mapping category");
        }
      }
      if (rule.categoryId !== change.categoryId) {
        changedRules.push(change);
      }
    }

    const savedRules = [];
    for (const change of changedRules.sort((a, b) => a.id < b.id ? -1 : a.id > b.id ? 1 : 0)) {
      const saved = await updateImportCategoryMappingRule(tx, {
        id: change.id, householdId: sessionUser.householdId, categoryId: change.categoryId,
        expectedUpdatedAt: new Date(change.expectedUpdatedAt),
      });
      if (!saved) {
        throw new ImportCategoryMappingConflictError();
      }
      savedRules.push({ ...saved, updatedAt: saved.updatedAt.toISOString() });
    }
    return savedRules;
  }, { timeout: 30_000 });
}
