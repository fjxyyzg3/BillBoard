import { ImportDraftRowStatus, ImportDraftStatus, ImportRowDecision, type Prisma, type PrismaClient, TransactionType, UserStatus } from "@prisma/client";

import { type HouseholdSession, resolveHouseholdContext } from "@/lib/auth/household-context";
import { db } from "@/lib/db";
import { getCategoryDisplayName } from "@/lib/i18n";
import { ProcessingConsentError, requireProcessingConsent } from "@/lib/processing/preferences";
import { assertResourceLease, ResourceBusyError, ResourceExpiredError, withResourceLease } from "@/lib/resources/admission";
import {
  IMPORT_AGENT_SCHEMA_VERSION, MAX_AGENT_BODY_BYTES, MAX_AGENT_GROUPS, MAX_AGENT_PRODUCTS,
  MAX_AGENT_RESPONSE_BYTES, MAX_AGENT_TEXT_LENGTH, type ImportAgentRequest,
  validateAgentRequest, validateAgentResponse,
} from "@/lib/imports/agent-protocol";
import { buildImportCategoryMappingKey, normalizeImportedCategory } from "@/lib/imports/category-mapping";
import { ALIPAY_SOURCE, CMB_SOURCE, type ImportSource, SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE } from "@/lib/imports/types";

export type ImportAgentSuggestionResult =
  | { success: true; suggestions: Array<{ mappingKey: string; categoryId: string | null }>; unresolvedCount: number }
  | { success: false; error: "UNAVAILABLE" | "BUSY" | "FAILED" | "STALE" | "INVALID" | "CONSENT_REQUIRED" };

type AgentErrorCode = Extract<ImportAgentSuggestionResult, { success: false }>["error"];
type SessionUser = HouseholdSession;
type MappingGroup = Omit<ImportAgentRequest["groups"][number], "id"> & { mappingKey: string };

const supportedSources: ImportSource[] = [SUI_SHOU_JI_SOURCE, WECHAT_PAY_SOURCE, ALIPAY_SOURCE, CMB_SOURCE];
const requestTimeoutMs = 55_000;
const maxMappingKeyLength = 4096;
const rowSelection = {
  mappingKey: true, transactionType: true, primaryCategory: true, secondaryCategory: true, note: true,
  status: true, userDecision: true, categoryId: true,
} satisfies Prisma.ImportDraftRowSelect;

class ImportAgentError extends Error {
  constructor(readonly code: AgentErrorCode) {
    super(code);
    this.name = "ImportAgentError";
  }
}

function boundedText(value: string) {
  return value.slice(0, MAX_AGENT_TEXT_LENGTH);
}

function productDescription(source: ImportSource, note: string | null): string | null {
  if ((source !== WECHAT_PAY_SOURCE && source !== ALIPAY_SOURCE) || !note) return null;
  const match = /(?:^|；)商品：([^；\r\n]*)/.exec(note);
  const product = match?.[1].trim();
  return product ? boundedText(product) : null;
}

async function loadEligibleGroups(
  draftId: string,
  mappingKeys: string[],
  sessionUser: SessionUser,
  recheck = false,
  client: PrismaClient | Prisma.TransactionClient = db,
) {
  try {
    await resolveHouseholdContext(client, sessionUser);
  } catch {
    throw new ImportAgentError(recheck ? "STALE" : "INVALID");
  }
  const draft = await client.importDraft.findFirst({
    where: { id: draftId, householdId: sessionUser.householdId },
    select: {
      ledgerId: true, source: true, status: true,
      createdByMember: { select: { leftAt: true, user: { select: { status: true } } } },
    },
  });
  if (!draft) throw new ImportAgentError(recheck ? "STALE" : "INVALID");
  if (draft.status !== ImportDraftStatus.PENDING) throw new ImportAgentError("STALE");
  if (draft.createdByMember.leftAt || draft.createdByMember.user.status !== UserStatus.ACTIVE) {
    throw new ImportAgentError("STALE");
  }
  try {
    await resolveHouseholdContext(client, sessionUser, { ledgerId: draft.ledgerId });
  } catch {
    throw new ImportAgentError("STALE");
  }
  if (!supportedSources.includes(draft.source as ImportSource)) throw new ImportAgentError(recheck ? "STALE" : "INVALID");
  const source = draft.source as ImportSource;
  const rows = await client.importDraftRow.findMany({
    where: { draftId, draft: { householdId: sessionUser.householdId }, mappingKey: { in: mappingKeys } },
    select: rowSelection,
    orderBy: [{ rowNumber: "asc" }, { id: "asc" }],
  });
  const existingKeys = new Set(rows.map(({ mappingKey }) => mappingKey));
  if (!recheck && mappingKeys.some((key) => !existingKeys.has(key))) throw new ImportAgentError("INVALID");

  const groups = new Map<string, MappingGroup>();
  for (const row of rows) {
    if (!row.mappingKey || !row.transactionType || row.categoryId !== null ||
      row.status !== ImportDraftRowStatus.NEEDS_MAPPING || row.userDecision !== ImportRowDecision.KEEP) continue;
    const primaryCategory = normalizeImportedCategory(row.primaryCategory);
    const secondaryCategory = source === ALIPAY_SOURCE ? "" : normalizeImportedCategory(row.secondaryCategory);
    if (buildImportCategoryMappingKey({ source, transactionType: row.transactionType, primaryCategory, secondaryCategory }) !== row.mappingKey) {
      throw new ImportAgentError(recheck ? "STALE" : "INVALID");
    }
    let group = groups.get(row.mappingKey);
    if (!group) {
      group = { mappingKey: row.mappingKey, source, transactionType: row.transactionType,
        primaryCategory, secondaryCategory, products: [] };
      groups.set(row.mappingKey, group);
    }
    const product = productDescription(source, row.note);
    if (product && group.products.length < MAX_AGENT_PRODUCTS && !group.products.includes(product)) group.products.push(product);
  }
  if (groups.size === 0) return [];
  const rules = await client.importCategoryMapping.findMany({
    where: {
      householdId: sessionUser.householdId, source,
      OR: Array.from(groups.values(), ({ transactionType, primaryCategory, secondaryCategory }) => ({
        transactionType: transactionType as TransactionType, primaryCategory, secondaryCategory,
      })),
    },
    select: { source: true, transactionType: true, primaryCategory: true, secondaryCategory: true },
  });
  for (const rule of rules) {
    groups.delete(buildImportCategoryMappingKey({ ...rule, source }));
  }
  return mappingKeys.flatMap((key) => groups.has(key) ? [groups.get(key)!] : []);
}

async function readResponseBody(response: Response): Promise<unknown> {
  const length = Number(response.headers.get("content-length"));
  if (length > MAX_AGENT_RESPONSE_BYTES || !response.body) {
    await response.body?.cancel();
    throw new ImportAgentError("FAILED");
  }
  const reader = response.body.getReader();
  const chunks: Uint8Array[] = [];
  let bytes = 0;
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      bytes += value.byteLength;
      if (bytes > MAX_AGENT_RESPONSE_BYTES) {
        await reader.cancel();
        throw new ImportAgentError("FAILED");
      }
      chunks.push(value);
    }
  } finally {
    reader.releaseLock();
  }
  return JSON.parse(Buffer.concat(chunks).toString("utf8"));
}

async function requestSuggestions(request: ImportAgentRequest, signal: AbortSignal) {
  const agentUrl = process.env.IMPORT_AGENT_URL?.trim();
  const token = process.env.IMPORT_AGENT_TOKEN?.trim();
  if (!agentUrl || !token) throw new ImportAgentError("UNAVAILABLE");
  let endpoint: URL;
  try {
    const configured = new URL(agentUrl);
    if (!["http:", "https:"].includes(configured.protocol) || configured.username || configured.password) {
      throw new Error("Invalid agent endpoint");
    }
    endpoint = new URL("/suggest", configured);
  } catch {
    throw new ImportAgentError("UNAVAILABLE");
  }
  const body = JSON.stringify(request);
  if (Buffer.byteLength(body, "utf8") > MAX_AGENT_BODY_BYTES) throw new ImportAgentError("INVALID");
  const response = await fetch(endpoint, {
    method: "POST", headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
    body, cache: "no-store", redirect: "error", signal: AbortSignal.any([signal, AbortSignal.timeout(requestTimeoutMs)]),
  });
  if (!response.ok) {
    let errorCode: unknown;
    try {
      const errorBody = await readResponseBody(response);
      if (errorBody && typeof errorBody === "object" && "error" in errorBody) errorCode = errorBody.error;
    } catch {
      // Only the fixed service error codes influence the public response.
    }
    if (response.status === 429 || errorCode === "busy") throw new ImportAgentError("BUSY");
    if (response.status === 401 || response.status === 503) throw new ImportAgentError("UNAVAILABLE");
    throw new ImportAgentError("FAILED");
  }
  return validateAgentResponse(request, await readResponseBody(response));
}

export async function getImportAgentSuggestions(
  draftId: string,
  mappingKeys: string[],
  sessionUser: SessionUser,
): Promise<ImportAgentSuggestionResult> {
  try {
    if (typeof draftId !== "string" || !draftId || draftId.length > 128 ||
      !Array.isArray(mappingKeys) || mappingKeys.length === 0 || mappingKeys.length > MAX_AGENT_GROUPS ||
      mappingKeys.some((key) => typeof key !== "string" || !key || key.length > maxMappingKeyLength) ||
      new Set(mappingKeys).size !== mappingKeys.length || !sessionUser ||
      typeof sessionUser.householdId !== "string" || !sessionUser.householdId ||
      typeof sessionUser.memberId !== "string" || !sessionUser.memberId) throw new ImportAgentError("INVALID");

    const groups = await loadEligibleGroups(draftId, mappingKeys, sessionUser);
    if (groups.length === 0) return { success: true, suggestions: [], unresolvedCount: mappingKeys.length };
    const categories = await db.category.findMany({
      where: { isActive: true }, orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { id: "asc" }],
      select: { id: true, name: true, type: true },
    });
    if (categories.length === 0) throw new ImportAgentError("UNAVAILABLE");
    const request = validateAgentRequest({
      schemaVersion: IMPORT_AGENT_SCHEMA_VERSION,
      groups: groups.map((group, index) => ({
        id: `g${index}`, source: group.source, transactionType: group.transactionType,
        primaryCategory: boundedText(group.primaryCategory), secondaryCategory: boundedText(group.secondaryCategory),
        products: group.products,
      })),
      categories: categories.map((category, index) => ({
        id: `c${index}`, name: boundedText(category.name), displayName: boundedText(getCategoryDisplayName(category.name, "zh-CN")),
        type: category.type,
      })),
    });
    const draft = await db.importDraft.findFirstOrThrow({
      where: { id: draftId, householdId: sessionUser.householdId }, select: { ledgerId: true },
    });
    return await withResourceLease(sessionUser, "ai", async (lease): Promise<ImportAgentSuggestionResult> => {
      const result = await requestSuggestions(request, lease.signal);
      const [currentGroups, currentCategories] = await Promise.all([
        loadEligibleGroups(draftId, mappingKeys, sessionUser, true),
        db.category.findMany({ where: { isActive: true, id: { in: categories.map(({ id }) => id) } }, select: { id: true, name: true, type: true } }),
      ]);
      const currentGroupByKey = new Map(currentGroups.map((group) => [group.mappingKey, group]));
      const currentCategoryById = new Map(currentCategories.map((category) => [category.id, category]));
      await db.$transaction(async (tx) => {
        await resolveHouseholdContext(tx, sessionUser, { lock: true, ledgerId: draft.ledgerId });
        await assertResourceLease(tx, lease);
      });
      const groupById = new Map(request.groups.map(({ id }, index) => [id, groups[index]]));
      const categoryById = new Map(request.categories.map(({ id }, index) => [id, categories[index]]));
      const suggestions: Array<{ mappingKey: string; categoryId: string | null }> = [];
      for (const suggestion of result.suggestions) {
        if (suggestion.action === "uncertain") continue;
        const originalGroup = groupById.get(suggestion.groupId)!;
        const currentGroup = currentGroupByKey.get(originalGroup.mappingKey);
        if (!currentGroup || currentGroup.transactionType !== originalGroup.transactionType) continue;
        if (suggestion.action === "ignore") {
          suggestions.push({ mappingKey: originalGroup.mappingKey, categoryId: null });
          continue;
        }
        const originalCategory = categoryById.get(suggestion.categoryId)!;
        const currentCategory = currentCategoryById.get(originalCategory.id);
        if (!currentCategory || currentCategory.type !== currentGroup.transactionType || currentCategory.name !== originalCategory.name) continue;
        suggestions.push({ mappingKey: originalGroup.mappingKey, categoryId: currentCategory.id });
      }
      return { success: true, suggestions, unresolvedCount: mappingKeys.length - suggestions.length };
    }, { ledgerId: draft.ledgerId, admit: async (tx) => {
      await requireProcessingConsent(tx, sessionUser, { ai: true });
      const current = await loadEligibleGroups(draftId, mappingKeys, sessionUser, true, tx);
      if (JSON.stringify(current) !== JSON.stringify(groups)) throw new ImportAgentError("STALE");
    } });
  } catch (error) {
    if (error instanceof ProcessingConsentError) return { success: false, error: "CONSENT_REQUIRED" };
    if (error instanceof ResourceBusyError) return { success: false, error: "BUSY" };
    if (error instanceof ResourceExpiredError) return { success: false, error: "STALE" };
    return { success: false, error: error instanceof ImportAgentError ? error.code : "FAILED" };
  }
}
