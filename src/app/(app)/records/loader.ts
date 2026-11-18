import { requireAppSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getCategoryDisplayName } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import { resolveLedgerPageContext } from "@/lib/ledgers/server";
import { recordAppEvent } from "@/lib/ops/record-event";
import type { RecordAmountFilterError } from "@/lib/records/amount-filter";
import { listRecords, RECORDS_PAGE_SIZE, type RecordListItem } from "@/lib/records/list-records";
import { authorizeMemberReadScope, parseMemberFilter } from "@/lib/records/member-filter";
import { decodeRecordAmountToken, decodeRecordSearchToken } from "@/lib/records/search-token";
import { parseRecordSort } from "@/lib/records/sort";
import {
  buildReportRangeOptions,
  clampReportRangeSelection,
  getReportRangeBounds,
  parseReportRangeSearchParams,
} from "@/lib/reports/report-range";
import { getCurrentShanghaiDateTimeLocal } from "@/lib/transactions/datetime";
import { AppEventType } from "@prisma/client";
import { notFound } from "next/navigation";

type RecordsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function buildSearchParams(
  values: Record<string, string | string[] | undefined> | undefined,
) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(values ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item) {
          params.append(key, item);
        }
      }

      continue;
    }

    if (value) {
      params.set(key, value);
    }
  }

  params.delete("perspective");
  return params;
}

function buildRecordsHref(params: URLSearchParams) {
  const query = params.toString();

  return query ? `/records?${query}` : "/records";
}

function buildRecordsPageHref(params: URLSearchParams, page: number) {
  const nextParams = new URLSearchParams(params.toString());

  nextParams.delete("record");

  if (page <= 1) {
    nextParams.delete("page");
  } else {
    nextParams.set("page", String(page));
  }

  return buildRecordsHref(nextParams);
}

function parseTypeFilter(value: string | null): "income" | "expense" | undefined {
  if (value === "income" || value === "expense") {
    return value;
  }

  return undefined;
}

function parseDrillDownDate(value: string | null) {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    return undefined;
  }

  return parsed;
}

function parsePageNumber(value: string | null) {
  if (!value) {
    return 1;
  }

  const parsed = Number(value);

  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : 1;
}

function groupRecordsByDate(records: RecordListItem[], sortByAmount: boolean) {
  const groups: Array<{ key: string; date?: Date; records: RecordListItem[] }> = [];

  if (sortByAmount) {
    return [{ key: "amount", records }];
  }

  for (const record of records) {
    const key = getCurrentShanghaiDateTimeLocal(record.occurredAt).slice(0, 10);
    const previous = groups.at(-1);

    if (previous?.key === key) {
      previous.records.push(record);
    } else {
      groups.push({ key, date: record.occurredAt, records: [record] });
    }
  }

  return groups;
}

export async function loadRecordsPage({ searchParams }: RecordsPageProps) {
  const user = await requireAppSession();
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const view = await resolveLedgerPageContext(user, resolvedSearchParams);
  const ledgerId = view.scope.kind === "ledger" ? view.scope.ledgerId : undefined;
  let actorMemberId: string | undefined;
  try {
    actorMemberId = parseMemberFilter(resolvedSearchParams?.member);
    await authorizeMemberReadScope(db, user.householdId, actorMemberId);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") notFound();
    throw error;
  }
  const context = { householdId: user.householdId, memberId: user.memberId, scope: view.scope };
  const currentParams = buildSearchParams(resolvedSearchParams);
  currentParams.set("ledger", ledgerId ?? "all");
  currentParams.set("entryLedger", view.entryLedgerId);

  await recordAppEvent({
    eventType: AppEventType.PAGE_VIEW,
    householdId: user.householdId,
    memberId: user.memberId,
    path: "/records",
    summary: "访问 记录",
  }).catch(() => undefined);
  const locale = await getServerLocale();
  const now = new Date();
  const parsedRange = parseReportRangeSearchParams(
    {
      mode: currentParams.get("mode"),
      month: currentParams.get("month"),
      year: currentParams.get("year"),
      start: currentParams.get("start"),
      end: currentParams.get("end"),
    },
    now,
  );
  const typeFilter = parseTypeFilter(currentParams.get("type"));
  const sort = parseRecordSort(currentParams.get("sort"));
  const categoryIdFilter = currentParams.get("category")?.trim() || undefined;
  const searchToken = currentParams.get("search") || undefined;
  const searchTerm = searchToken
    ? decodeRecordSearchToken(searchToken, context)
    : undefined;
  if (searchToken && !searchTerm) {
    currentParams.delete("search");
  }
  const amountToken = currentParams.get("amount") || undefined;
  const amountFilter = decodeRecordAmountToken(amountToken, context);
  const filterError = currentParams.get("filterError");
  let amountError: RecordAmountFilterError | undefined =
    filterError === "invalidAmount" || filterError === "invalidAmountRange" ? filterError : undefined;
  if (amountToken && !amountFilter) {
    currentParams.delete("amount");
    amountError = "invalidAmount";
  }
  const drillDownFrom = parseDrillDownDate(currentParams.get("from"));
  const drillDownTo = parseDrillDownDate(currentParams.get("to"));
  const selectedRecordId = currentParams.get("record")?.trim() || undefined;
  const pageNumber = parsePageNumber(currentParams.get("page"));

  const [household, categories, householdMembers, firstActiveTransaction] = await Promise.all([
    db.household.findUniqueOrThrow({
      where: { id: user.householdId },
      select: { timezone: true },
    }),
    db.category.findMany({
      where: { isActive: true },
      orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true },
    }),
    db.householdMember.findMany({
      where: { householdId: user.householdId },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      select: { id: true, memberName: true, leftAt: true, user: { select: { status: true } } },
    }),
    db.transaction.findFirst({
      where: {
        householdId: user.householdId,
        ...(ledgerId ? { ledgerId } : {}),
        deletedAt: null,
      },
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
    }),
  ]);
  const firstOccurredAt = firstActiveTransaction?.occurredAt ?? null;
  const rangeOptions = buildReportRangeOptions(firstOccurredAt, now, household.timezone);
  const selectedRange = clampReportRangeSelection(parsedRange, rangeOptions);
  const selectedRangeBounds = getReportRangeBounds(
    selectedRange,
    now,
    firstOccurredAt,
    household.timezone,
  );
  const queryRangeBounds =
    drillDownFrom && drillDownTo
      ? { from: drillDownFrom, to: drillDownTo }
      : selectedRangeBounds;

  const searchCategoryIds = searchTerm
    ? categories
      .filter((category) =>
        getCategoryDisplayName(category.name, locale)
          .toLocaleLowerCase(locale)
          .includes(searchTerm.toLocaleLowerCase(locale)),
      )
      .map((category) => category.id)
    : undefined;
  const recordsQuery = {
    householdId: user.householdId,
    ledgerId,
    actorMemberId,
    currentMemberId: user.memberId,
    rangeBounds: queryRangeBounds,
    type: typeFilter,
    categoryId: categoryIdFilter,
    sort,
    search: searchTerm,
    searchCategoryIds,
    amountFilter,
  };
  const recordsWindow = await listRecords({
    ...recordsQuery,
    limit: RECORDS_PAGE_SIZE + 1,
    offset: (pageNumber - 1) * RECORDS_PAGE_SIZE,
  });
  const hasNextPage = recordsWindow.length > RECORDS_PAGE_SIZE;
  const hasPreviousPage = pageNumber > 1;
  const records = recordsWindow.slice(0, RECORDS_PAGE_SIZE);
  const recordGroups = groupRecordsByDate(records, Boolean(sort));
  const selectedRecord = selectedRecordId
    ? (
      await listRecords({
        ...recordsQuery,
        recordId: selectedRecordId,
        limit: 1,
        offset: 0,
      })
    )[0] ?? null
    : null;

  const categoryOptions = categories.map((category) => ({
    id: category.id,
    name: category.name,
    type: category.type === "INCOME" ? "income" : "expense",
  })) as Array<{ id: string; name: string; type: "income" | "expense" }>;
  const closeParams = new URLSearchParams(currentParams.toString());
  const selectedRecordParams = new URLSearchParams(currentParams.toString());

  closeParams.delete("record");
  const closeHref = buildRecordsHref(closeParams);
  const returnTo = buildRecordsHref(currentParams);
  const previousPageHref = hasPreviousPage
    ? buildRecordsPageHref(currentParams, pageNumber - 1)
    : null;
  const nextPageHref = hasNextPage ? buildRecordsPageHref(currentParams, pageNumber + 1) : null;
  const originalRangeParams = new URLSearchParams(closeParams.toString());

  originalRangeParams.delete("from");
  originalRangeParams.delete("to");
  originalRangeParams.delete("page");
  const originalRangeHref = buildRecordsHref(originalRangeParams);

  return { rangeOptions, selectedRange, locale, user: { householdId: user.householdId, memberId: user.memberId }, view, ledgerId, actorMemberId, queryRangeBounds, categoryOptions, householdMembers, drillDownFrom, drillDownTo, originalRangeHref, searchTerm, amountFilter, amountError, records, recordGroups, selectedRecordParams, hasPreviousPage, hasNextPage, pageNumber, previousPageHref, nextPageHref, selectedRecord, context, closeHref, returnTo, pageSize: RECORDS_PAGE_SIZE };
}
