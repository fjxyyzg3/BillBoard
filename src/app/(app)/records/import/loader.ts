import { getImportMappingGroups } from "@/lib/imports/mapping-form";
import { getImportReviewPage, isLockedImportRefund } from "@/lib/imports/review";
import {
  AppEventType,
  ImportDraftRowStatus,
  ImportDraftStatus,
} from "@prisma/client";

import { requireAppSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import { getImportDraftSummary } from "@/lib/imports/drafts";
import {
  ALIPAY_SOURCE,
  WECHAT_PAY_SOURCE
} from "@/lib/imports/types";
import { resolveLedgerPageContext } from "@/lib/ledgers/server";
import { recordAppEvent } from "@/lib/ops/record-event";


type ImportPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type CategoryOption = {
  id: string;
  name: string;
  type: "EXPENSE" | "INCOME";
};

type MemberOption = {
  id: string;
  memberName: string;
};

function readParam(
  searchParams: Record<string, string | string[] | undefined> | undefined,
  key: string,
) {
  const value = searchParams?.[key];

  return Array.isArray(value) ? value[0] : value;
}

export async function loadImportPage({ searchParams }: ImportPageProps) {
  const sessionUser = await requireAppSession();
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const ledgerPage = await resolveLedgerPageContext(sessionUser, resolvedSearchParams);
  const returnToRecordsHref = `/records?ledger=${encodeURIComponent(ledgerPage.scope.kind === "ledger" ? ledgerPage.scope.ledgerId : "all")}`;
  await recordAppEvent({
    eventType: AppEventType.PAGE_VIEW,
    householdId: sessionUser.householdId,
    memberId: sessionUser.memberId,
    path: "/records/import",
    summary: "访问 导入记录",
  }).catch(() => undefined);
  const locale = await getServerLocale();
  const messages = getMessages(locale);
  const draftId = readParam(resolvedSearchParams, "draft")?.trim();
  const error = readParam(resolvedSearchParams, "error");
  const notice = readParam(resolvedSearchParams, "notice");
  const errorMessage =
    error && error in messages.import.errors
      ? messages.import.errors[error as keyof typeof messages.import.errors]
      : null;
  const noticeMessage =
    notice === "IMPORT_DRAFT_CHANGED" ? messages.import.draftChangedNotice : null;
  const [summary, categories] = draftId
    ? await Promise.all([
      getImportDraftSummary(draftId, sessionUser),
      db.category.findMany({
        where: { isActive: true },
        orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true, type: true },
      }) as Promise<CategoryOption[]>,
    ])
    : [null, [] as CategoryOption[]];
  const hasPaymentOwnerRows =
    summary?.rows.some(
      (row) =>
        row.status !== ImportDraftRowStatus.INVALID &&
        row.status !== ImportDraftRowStatus.SOURCE_DUPLICATE &&
        !isLockedImportRefund(row),
    ) ?? false;
  const shouldShowPaymentOwnerForm =
    summary?.status === ImportDraftStatus.PENDING &&
    !summary.blockedReason &&
    hasPaymentOwnerRows &&
    summary.memberMappings.length === 0 &&
    (summary.source === WECHAT_PAY_SOURCE || summary.source === ALIPAY_SOURCE);
  const shouldShowMemberMappingForm =
    summary?.status === ImportDraftStatus.PENDING && !summary.blockedReason && summary.memberMappings.length > 0;
  const isCompleted = summary?.status === ImportDraftStatus.COMPLETED;
  const members = summary?.status === ImportDraftStatus.PENDING
    ? await db.householdMember.findMany({
      where: { householdId: sessionUser.householdId, leftAt: null, user: { status: "ACTIVE" } },
      orderBy: { joinedAt: "asc" },
      select: { id: true, memberName: true },
    }) as MemberOption[]
    : [];
  const review = getImportReviewPage(
    summary?.rows ?? [],
    readParam(resolvedSearchParams, "status"),
    readParam(resolvedSearchParams, "page"),
  );
  const mappingGroups = summary
    ? getImportMappingGroups(summary.missingMappings, summary.ignoredMappings)
    : [];
  const paymentOwnerMemberId =
    shouldShowPaymentOwnerForm
      ? (summary.rows.find(
        (row) =>
          row.status !== ImportDraftRowStatus.INVALID &&
          row.status !== ImportDraftRowStatus.SOURCE_DUPLICATE &&
          row.actorMemberId,
      )?.actorMemberId ?? sessionUser.memberId)
      : null;
  const activeStep = !summary
    ? 0
    : isCompleted
      ? 3
      : summary.counts.needsMapping > 0 || summary.hasUnresolvedMemberMappings
        ? 1
        : 2;
  const steps = [
    messages.ui.importStepUpload,
    messages.ui.importStepMapping,
    messages.ui.importStepReview,
    messages.ui.importStepComplete,
  ];

  return { locale, summary: summary ? { id: summary.id, source: summary.source, status: summary.status, blockedReason: summary.blockedReason, counts: summary.counts, fileName: summary.fileName, ledgerId: summary.ledgerId, ledgerName: summary.ledgerName, hasUnresolvedMemberMappings: summary.hasUnresolvedMemberMappings, memberMappings: summary.memberMappings } : null, categories, ledgerPage, returnToRecordsHref, errorMessage, noticeMessage, shouldShowPaymentOwnerForm, shouldShowMemberMappingForm, isCompleted, members, review, mappingGroups, paymentOwnerMemberId, activeStep, steps };
}
