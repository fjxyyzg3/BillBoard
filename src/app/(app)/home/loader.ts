import { type ReportAnalyticsLinks } from "@/components/report-analytics";
import { requireAppSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { formatLocaleNumber, getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import { resolveLedgerPageContext } from "@/lib/ledgers/server";
import { formatFen } from "@/lib/money";
import { recordAppEvent } from "@/lib/ops/record-event";
import { authorizeMemberReadScope, parseMemberFilter } from "@/lib/records/member-filter";
import { createRecordAmountToken } from "@/lib/records/search-token";
import type { AnalyticsDateRange } from "@/lib/reports/analytics-types";
import { queryHomeReport } from "@/lib/reports/query-home-report";
import { queryReportAnalytics } from "@/lib/reports/query-report-analytics";
import {
  buildSharedReportParams,
  parseReportRangeSearchParams,
} from "@/lib/reports/report-range";
import { AppEventType } from "@prisma/client";
import { notFound } from "next/navigation";

type HomePageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function readParam(
  params: Record<string, string | string[] | undefined> | undefined,
  key: string,
) {
  const value = params?.[key];

  if (Array.isArray(value)) {
    return value[0] ?? null;
  }

  return value ?? null;
}

type CategoryType = "expense" | "income";

function parseCategoryType(value: string | null): CategoryType {
  return value === "income" ? "income" : "expense";
}

function buildPageHref(
  pathname: string,
  sharedParams: URLSearchParams,
  extras?: Record<string, string | undefined>,
) {
  const params = new URLSearchParams(sharedParams.toString());

  for (const [key, value] of Object.entries(extras ?? {})) {
    if (value) {
      params.set(key, value);
    } else {
      params.delete(key);
    }
  }

  const query = params.toString();

  return query ? `${pathname}?${query}` : pathname;
}

function buildRecordsHref(
  sharedParams: URLSearchParams,
  extras?: Record<string, string | undefined>,
) {
  return buildPageHref("/records", sharedParams, { sort: "amount-desc", ...extras });
}

function formatSignedFen(fen: number) {
  if (fen === 0) {
    return "0.00";
  }

  return `${fen < 0 ? "-" : ""}${formatFen(Math.abs(fen))}`;
}

export async function loadHomePage({ searchParams }: HomePageProps) {
  const user = await requireAppSession();
  const pageEventPromise = recordAppEvent({
    eventType: AppEventType.PAGE_VIEW,
    householdId: user.householdId,
    memberId: user.memberId,
    path: "/home",
    summary: "访问 首页",
  }).catch(() => undefined);
  const [locale, resolvedSearchParams] = await Promise.all([
    getServerLocale(),
    searchParams ?? Promise.resolve(undefined),
  ]);
  const messages = getMessages(locale);
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
  const now = new Date();
  const selection = parseReportRangeSearchParams(
    {
      mode: readParam(resolvedSearchParams, "mode"),
      month: readParam(resolvedSearchParams, "month"),
      year: readParam(resolvedSearchParams, "year"),
      start: readParam(resolvedSearchParams, "start"),
      end: readParam(resolvedSearchParams, "end"),
    },
    now,
  );
  const categoryType = parseCategoryType(readParam(resolvedSearchParams, "categoryType"));
  const [report, householdMembers] = await Promise.all([
    queryHomeReport({
      currentMemberId: user.memberId,
      householdId: user.householdId,
      ledgerId,
      actorMemberId,
      now,
      range: selection,
    }),
    db.householdMember.findMany({
      where: { householdId: user.householdId },
      orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      select: { id: true, memberName: true, leftAt: true, user: { select: { status: true } } },
    }),
    pageEventPromise,
  ]);
  const analytics = await queryReportAnalytics({
    currentMemberId: user.memberId,
    householdId: user.householdId,
    ledgerId,
    actorMemberId,
    now,
    range: report.range,
  });
  const sharedParams = buildSharedReportParams(report.range);
  sharedParams.set("ledger", ledgerId ?? "all");
  sharedParams.set("entryLedger", view.entryLedgerId);
  if (actorMemberId) sharedParams.set("member", actorMemberId);
  const periodLinks = (params: URLSearchParams) => ({
    all: buildRecordsHref(params),
    expense: buildRecordsHref(params, { type: "expense" }),
    income: buildRecordsHref(params, { type: "income" }),
  });
  const comparisonLinks = (range: AnalyticsDateRange | null) => {
    if (!range) return null;
    const params = new URLSearchParams(sharedParams);
    params.set("from", new Date(`${range.from}T00:00:00+08:00`).toISOString());
    params.set("to", new Date(`${range.to}T23:59:59.999+08:00`).toISOString());
    return periodLinks(params);
  };
  const analyticsLinks: ReportAnalyticsLinks = {
    current: periodLinks(sharedParams),
    previous: comparisonLinks(analytics.comparisons.previous.range),
    yearOverYear: comparisonLinks(analytics.comparisons.yearAgo.range),
    distribution: Object.fromEntries(analytics.distribution.buckets.map((bucket) => [
      bucket.key,
      buildRecordsHref(sharedParams, {
        type: "expense",
        amount: createRecordAmountToken({
          mode: "range",
          minFen: bucket.minFen,
          ...(bucket.maxFen === null ? {} : { maxFen: bucket.maxFen }),
        }, context),
      }),
    ])),
    maximumExpense: analytics.distribution.maxFen === null ? null : buildRecordsHref(sharedParams, {
      type: "expense",
      amount: createRecordAmountToken({ mode: "exact", valueFen: analytics.distribution.maxFen }, context),
    }),
    annual: report.range.mode === "month" ? buildPageHref("/home", buildSharedReportParams({
      ...report.range,
      mode: "year",
      year: analytics.range.to.slice(0, 4),
    }), { ledger: ledgerId ?? "all", entryLedger: view.entryLedgerId, member: actorMemberId }) : null,
  };
  const recordsHref = buildRecordsHref(sharedParams);
  const fullWidthSecondary = formatFen(report.summary.incomeFen).length > 12
    || formatSignedFen(report.summary.netFen).length > 12;
  const categoryData = report.categories[categoryType];
  const categoryLabels = messages.home.categories;
  const categoryEmpty =
    categoryType === "income" ? categoryLabels.emptyIncome : categoryLabels.emptyExpense;
  const categoryTransactionCount = categoryData.items.reduce(
    (sum, item) => sum + item.transactionCount,
    0,
  );
  const categorySummaryLabel =
    categoryType === "income"
      ? categoryLabels.totalIncome(
        formatFen(categoryData.totalFen),
        formatLocaleNumber(categoryTransactionCount, locale),
        categoryTransactionCount,
      )
      : categoryLabels.totalExpense(
        formatFen(categoryData.totalFen),
        formatLocaleNumber(categoryTransactionCount, locale),
        categoryTransactionCount,
      );

  return { locale, report, householdMembers, actorMemberId, sharedParams, analytics, analyticsLinks, recordsHref, fullWidthSecondary, categoryType, categoryData, categoryEmpty, categorySummaryLabel };
}
