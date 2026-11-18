import { ImportDraftRowStatus } from "@prisma/client";

import {
  ALIPAY_FULLY_REFUNDED,
  ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
  CMB_FULLY_REFUNDED,
  CMB_REFUND_MANUAL_REASONS,
  WECHAT_FULLY_REFUNDED,
  WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT,
} from "./types";

export const IMPORT_REVIEW_PAGE_SIZE = 50;
export const importReviewStatuses = [
  ImportDraftRowStatus.READY,
  ImportDraftRowStatus.NEEDS_MAPPING,
  ImportDraftRowStatus.POSSIBLE_DUPLICATE,
  ImportDraftRowStatus.USER_SKIPPED,
  ImportDraftRowStatus.SOURCE_DUPLICATE,
  ImportDraftRowStatus.INVALID,
] as const;
export type ImportReviewStatus = "all" | ImportDraftRowStatus;

export function isLockedImportRefund(row: { skipReason: string | null }) {
  return row.skipReason === ALIPAY_FULLY_REFUNDED ||
    row.skipReason === WECHAT_FULLY_REFUNDED ||
    row.skipReason === CMB_FULLY_REFUNDED ||
    CMB_REFUND_MANUAL_REASONS.some((reason) => reason === row.skipReason) ||
    row.skipReason === ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT ||
    row.skipReason === WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT;
}

export function canDecideImportRow(row: { status: ImportDraftRowStatus; skipReason: string | null }) {
  return !isLockedImportRefund(row) && (
    row.status === ImportDraftRowStatus.READY ||
    row.status === ImportDraftRowStatus.NEEDS_MAPPING ||
    row.status === ImportDraftRowStatus.POSSIBLE_DUPLICATE ||
    row.status === ImportDraftRowStatus.USER_SKIPPED
  );
}

export function getImportReviewNavigation(statusValue?: string, pageValue?: string) {
  const status: ImportReviewStatus = importReviewStatuses.some((value) => value === statusValue)
    ? statusValue as ImportDraftRowStatus
    : "all";
  const requestedPage = pageValue && /^[1-9]\d*$/.test(pageValue) ? Number(pageValue) : 1;
  return { status, page: Number.isSafeInteger(requestedPage) ? requestedPage : 1 };
}

export function getImportReviewPage<T extends { status: ImportDraftRowStatus }>(
  rows: T[], statusValue?: string, pageValue?: string,
) {
  const navigation = getImportReviewNavigation(statusValue, pageValue);
  const status = navigation.status;
  const filteredRows = status === "all" ? rows : rows.filter((row) => row.status === status);
  const pageCount = Math.max(1, Math.ceil(filteredRows.length / IMPORT_REVIEW_PAGE_SIZE));
  const page = Math.min(navigation.page, pageCount);

  return {
    status, page, pageCount, total: filteredRows.length,
    rows: filteredRows.slice((page - 1) * IMPORT_REVIEW_PAGE_SIZE, page * IMPORT_REVIEW_PAGE_SIZE),
  };
}

export function buildImportReviewHref(draftId: string, status: ImportReviewStatus, page: number) {
  const params = new URLSearchParams({ draft: draftId });
  if (status !== "all") params.set("status", status);
  if (page > 1) params.set("page", String(page));
  return `/records/import?${params.toString()}`;
}
