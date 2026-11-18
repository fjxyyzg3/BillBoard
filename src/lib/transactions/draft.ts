import type { DefaultCategoryIds } from "@/lib/transactions/category-preferences";
import { parseShanghaiDateTimeLocal } from "@/lib/transactions/datetime";
import { entryContextSchema, entryContextStorageScope, matchesEntryContext, type EntryContext } from "./entry-context";

export type TransactionDraftV1 = {
  version: 1;
  memberId: string;
  payload: {
    type: "income" | "expense";
    amount: string;
    categoryId: string;
    actorMemberId: string;
    occurredAt: string;
    note: string;
  };
  clientRequestId: string | null;
  status: "draft" | "awaiting-confirmation";
  savedAt: string;
};

export type TransactionDraftV2 = Omit<TransactionDraftV1, "version"> & { version: 2; context: EntryContext };
export type TransactionDraft = TransactionDraftV1 | TransactionDraftV2;

type DraftCategory = {
  id: string;
  type: "income" | "expense";
};

type ParseTransactionDraftOptions = {
  context?: EntryContext;
  legacyDefaultLedgerId?: string;
  currentMemberId: string;
  categories: DraftCategory[];
  defaultCategoryIds: DefaultCategoryIds;
  fallbackOccurredAt: string;
  householdMemberIds: string[];
};

function isValidShanghaiDateTimeLocal(value: string) {
  try {
    parseShanghaiDateTimeLocal(value);
    return true;
  } catch {
    return false;
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function hasOnlyKeys(value: Record<string, unknown>, keys: string[]) {
  const actualKeys = Object.keys(value);
  return actualKeys.length === keys.length && actualKeys.every((key) => keys.includes(key));
}

function isNonEmptyString(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isUuid(value: string) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(
    value,
  );
}

function isIsoDateTime(value: string) {
  return (
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:Z|[+-]\d{2}:\d{2})$/.test(value) &&
    Number.isFinite(Date.parse(value))
  );
}

function readDraft(value: unknown): TransactionDraft | null {
  if (
    !isRecord(value) ||
    !hasOnlyKeys(value, [
      "version",
      "memberId",
      "payload",
      "clientRequestId",
      "status",
      "savedAt",
      ...(value.version === 2 ? ["context"] : []),
    ]) ||
    (value.version !== 1 && value.version !== 2) ||
    !isNonEmptyString(value.memberId) ||
    !isRecord(value.payload) ||
    !hasOnlyKeys(value.payload, [
      "type",
      "amount",
      "categoryId",
      "actorMemberId",
      "occurredAt",
      "note",
    ])
  ) {
    return null;
  }

  const payload = value.payload;
  const clientRequestId = value.clientRequestId;

  if (
    (payload.type !== "income" && payload.type !== "expense") ||
    typeof payload.amount !== "string" ||
    payload.amount.length > 64 ||
    !isNonEmptyString(payload.categoryId) ||
    !isNonEmptyString(payload.actorMemberId) ||
    !isNonEmptyString(payload.occurredAt) ||
    typeof payload.note !== "string" ||
    payload.note.length > 500 ||
    (clientRequestId !== null &&
      (typeof clientRequestId !== "string" || !isUuid(clientRequestId))) ||
    (value.status !== "draft" && value.status !== "awaiting-confirmation") ||
    typeof value.savedAt !== "string" ||
    !isIsoDateTime(value.savedAt)
  ) {
    return null;
  }

  const context = value.version === 2 ? entryContextSchema.safeParse(value.context) : null;
  if (context && (!context.success || context.data.memberId !== value.memberId)) return null;
  return {
    ...(context?.success ? { version: 2 as const, context: context.data } : { version: 1 as const }),
    memberId: value.memberId,
    payload: {
      type: payload.type,
      amount: payload.amount,
      categoryId: payload.categoryId,
      actorMemberId: payload.actorMemberId,
      occurredAt: payload.occurredAt,
      note: payload.note,
    },
    clientRequestId,
    status: value.status,
    savedAt: value.savedAt,
  };
}

export function getTransactionDraftStorageKey(memberId: string, context?: EntryContext) {
  if (context) return `billboard:transaction-draft:v2:${entryContextStorageScope(context)}`;
  return `billboard:transaction-draft:v1:${memberId}`;
}

export function serializeTransactionDraft(draft: TransactionDraft) {
  return JSON.stringify(draft);
}

export function parseTransactionDraft(
  serialized: string,
  options: ParseTransactionDraftOptions,
): TransactionDraft | null {
  let value: unknown;

  try {
    value = JSON.parse(serialized);
  } catch {
    return null;
  }

  const parsed = readDraft(value);

  if (!parsed || parsed.memberId !== options.currentMemberId) {
    return null;
  }

  if (parsed.version === 2 && (!options.context || !matchesEntryContext(parsed.context, options.context))) return null;
  if (parsed.version === 1 && options.context && options.legacyDefaultLedgerId !== options.context.ledgerId) return null;

  const draft: TransactionDraft = parsed.version === 1 && options.context
    ? { ...parsed, version: 2, context: options.context } : parsed;
  // A submitted UUID must retain its exact snapshot until the server confirms its outcome.
  if (draft.status === "awaiting-confirmation" && draft.clientRequestId) return draft;
  let adjusted = false;
  const selectedCategory = options.categories.find(
    (category) =>
      category.id === draft.payload.categoryId && category.type === draft.payload.type,
  );
  const fallbackCategoryId = options.defaultCategoryIds[draft.payload.type];
  const fallbackCategory = options.categories.find(
    (category) => category.id === fallbackCategoryId && category.type === draft.payload.type,
  );

  if (!selectedCategory && !fallbackCategory) {
    return null;
  }

  const householdMemberIds = new Set(options.householdMemberIds);

  if (!householdMemberIds.has(options.currentMemberId)) {
    return null;
  }

  const categoryId = selectedCategory?.id ?? fallbackCategory?.id;
  const actorMemberId = householdMemberIds.has(draft.payload.actorMemberId)
    ? draft.payload.actorMemberId
    : options.currentMemberId;
  const occurredAt = isValidShanghaiDateTimeLocal(draft.payload.occurredAt)
    ? draft.payload.occurredAt
    : options.fallbackOccurredAt;

  adjusted ||= categoryId !== draft.payload.categoryId;
  adjusted ||= actorMemberId !== draft.payload.actorMemberId;
  adjusted ||= occurredAt !== draft.payload.occurredAt;
  adjusted ||= draft.status === "draft" && draft.clientRequestId !== null;
  adjusted ||= draft.status === "awaiting-confirmation" && draft.clientRequestId === null;

  return {
    ...draft,
    payload: {
      ...draft.payload,
      actorMemberId,
      categoryId: categoryId ?? draft.payload.categoryId,
      occurredAt,
    },
    clientRequestId: adjusted ? null : draft.clientRequestId,
    status: adjusted ? "draft" : draft.status,
  };
}
