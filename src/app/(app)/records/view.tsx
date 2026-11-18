import { CategoryIconBadge } from "@/components/category-icon-badge";
import { MemberFilter } from "@/components/member-filter";
import { Reveal } from "@/components/motion-primitives";
import { RecordExport } from "@/components/record-export";
import { RecordsFilterBar } from "@/components/records-filter-bar";
import { ReportRangeControls } from "@/components/report-range-controls";
import { TransactionEditorDrawer } from "@/components/transaction-editor-drawer";
import styles from "@/components/finance-b2.module.css";
import {
  formatLocaleDateTime,
  formatLocaleNumber,
  getCategoryDisplayName, getLedgerDisplayName, getMemberDisplayName, getMessages,
  type Locale
} from "@/lib/i18n";
import { formatFen } from "@/lib/money";
import { buildMemberFilterOptions } from "@/lib/records/member-filter";
import { buildReconciliationWorkspaceHref } from "@/lib/reports/bill-reconciliation-workspace";
import { getCurrentShanghaiDateTimeLocal } from "@/lib/transactions/datetime";
import { ArrowLeft, ReceiptText, Sparkles, Upload } from "lucide-react";
import Link from "next/link";
import type { loadRecordsPage } from "./loader";

function buildRecordsHref(params: URLSearchParams) {
  const query = params.toString();

  return query ? `/records?${query}` : "/records";
}

function formatRecordDate(date: Date, locale: Locale) {
  return new Intl.DateTimeFormat(locale, {
    timeZone: "Asia/Shanghai",
    year: "numeric",
    month: "short",
    day: "numeric",
  }).format(date);
}


export function RecordsView({ data }: { data: Awaited<ReturnType<typeof loadRecordsPage>> }) {
  const { rangeOptions, selectedRange, locale, user, view, ledgerId, actorMemberId, queryRangeBounds, categoryOptions, householdMembers, drillDownFrom, drillDownTo, originalRangeHref, searchTerm, amountFilter, amountError, records, recordGroups, selectedRecordParams, hasPreviousPage, hasNextPage, pageNumber, previousPageHref, nextPageHref, selectedRecord, context, closeHref, returnTo, pageSize } = data;
  const messages = getMessages(locale);

  return (
    <section className="space-y-4">
      <Reveal>
        <header className="space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-x-4 gap-y-2">
            <div className="min-w-0">
              <h1 className="bb-section-title">{messages.records.title}</h1>
            </div>
            <div className="flex max-w-full shrink-0 flex-wrap items-center gap-1">
              <Link className={`${styles.toolbarAction} inline-flex min-w-11 items-center justify-center gap-1.5 rounded-full focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ios-blue)]`} data-testid="records-reconciliation-link" href={buildReconciliationWorkspaceHref(selectedRange, ledgerId, actorMemberId)}>
                <Sparkles aria-hidden="true" className="h-4 w-4" strokeWidth={1.6} />
                <span className="sr-only sm:not-sr-only">{messages.billAnalysis.title}</span>
              </Link>
              <RecordExport
                key={`${user.householdId}:${user.memberId}:${ledgerId ?? "all"}:${actorMemberId ?? "all"}`}
                ledgerId={ledgerId}
                actorMemberId={actorMemberId}
                members={buildMemberFilterOptions(householdMembers, locale)}
                scopeName={ledgerId ? getLedgerDisplayName(view.ledgers.find((ledger) => ledger.id === ledgerId)!.name, locale) : messages.ledgers.household}
                from={getCurrentShanghaiDateTimeLocal(queryRangeBounds.from).slice(0, 10)}
                to={getCurrentShanghaiDateTimeLocal(queryRangeBounds.to).slice(0, 10)}
                locale={locale}
              />
              <Link
                className={`${styles.toolbarAction} inline-flex h-11 shrink-0 items-center gap-1.5 rounded-full border transition hover:bg-[var(--bb-accent-soft)] active:scale-[0.97] motion-reduce:active:scale-100 focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--ios-blue)]`}
                data-testid="records-import-link"
                href={`/records/import?ledger=${encodeURIComponent(ledgerId ?? "all")}&entryLedger=${encodeURIComponent(view.entryLedgerId)}`}
              >
                <Upload aria-hidden="true" className="h-4 w-4" strokeWidth={1.6} />
                <span>{messages.common.importRecords}</span>
              </Link>
            </div>
          </div>

          <div className={styles.compactFilters}>
            <div className="min-w-0" data-testid="records-range-controls">
              <ReportRangeControls
                className="w-full"
                closeLabel={messages.common.close}
                labels={messages.home.range}
                locale={locale}
                rangeOptions={rangeOptions}
                selection={selectedRange}
              />
            </div>
            <MemberFilter compact members={buildMemberFilterOptions(householdMembers, locale)} actorMemberId={actorMemberId} locale={locale} />
          </div>
          {drillDownFrom && drillDownTo ? (
            <div className="flex min-w-0 flex-wrap items-center justify-between gap-x-3 gap-y-1 border-b border-[var(--bb-warm-line)] pb-2" data-testid="records-drilldown-range">
              <div className="min-w-0 text-xs leading-5 text-[var(--bb-muted)]">
                <p>{messages.records.drillDownRange}</p>
                <p className="font-medium text-[var(--bb-ink)]">{formatRecordDate(drillDownFrom, locale)}{formatRecordDate(drillDownFrom, locale) === formatRecordDate(drillDownTo, locale) ? "" : ` – ${formatRecordDate(drillDownTo, locale)}`}</p>
              </div>
              <Link
                className="inline-flex min-h-11 items-center gap-1.5 text-xs font-semibold text-[var(--bb-accent-ink)]"
                href={originalRangeHref}
                prefetch={false}
                scroll={false}
              >
                <ArrowLeft aria-hidden="true" className="h-3.5 w-3.5" />
                {messages.records.returnToRange}
              </Link>
            </div>
          ) : null}
        </header>
      </Reveal>

      <Reveal delay={0.05}>
        <div className="w-full" id="records-filters">
          <RecordsFilterBar
            categories={categoryOptions}
            labels={{ common: messages.common }}
            locale={locale}
            searchValue={searchTerm}
            amountFilter={amountFilter}
            amountError={amountError}
          />
        </div>
      </Reveal>

      <Reveal delay={0.1}>
        <div className={styles.recordsList}>
          {records.length === 0 ? (
            <div className="flex flex-col items-center gap-3 p-10 text-center">
              <span
                aria-hidden="true"
                className="inline-flex h-12 w-12 items-center justify-center rounded-full bg-[var(--bb-warm-surface)] text-[var(--bb-muted)]"
              >
                <ReceiptText className="h-5 w-5" strokeWidth={1.6} />
              </span>
              <p className="text-sm text-[var(--bb-muted)]">{messages.records.empty}</p>
            </div>
          ) : (
            <div className="min-w-0">
              {recordGroups.map((group) => (
                <div key={group.key}>
                  {group.date ? (
                    <h2 className={styles.recordDate} data-testid="records-date-heading">
                      <time dateTime={group.key}>{formatRecordDate(group.date, locale)}</time>
                    </h2>
                  ) : null}
                  <ul className="divide-y divide-[var(--bb-warm-line)]">
                    {group.records.map((record) => {
                      const rowParams = new URLSearchParams(selectedRecordParams.toString());
                      const categoryName = getCategoryDisplayName(record.categoryName, locale);
                      const recordTitle = record.note?.trim() || categoryName;

                      rowParams.set("record", record.id);

                      return (
                        <li key={record.id}>
                          <Link
                            className={styles.recordRow}
                            href={buildRecordsHref(rowParams)}
                            prefetch={false}
                            scroll={false}
                          >
                            <CategoryIconBadge categoryName={record.categoryName} className="h-8 w-8" iconClassName="h-[1.125rem] w-[1.125rem] [stroke-width:1.6]" />
                            <span className="min-w-0">
                              <span className={styles.recordTitle}>
                                {recordTitle}
                              </span>
                              <span className="mt-1 block truncate text-xs text-[var(--bb-muted)]">
                                {record.note?.trim() ? `${categoryName} · ` : ""}
                                {getMemberDisplayName(record.actorMemberName, record.actorMemberInactive, locale)}
                                {` · ${getLedgerDisplayName(record.ledgerName, locale)}${record.ledgerArchivedAt ? ` · ${messages.ledgers.archived}` : ""}`}
                              </span>
                            </span>
                            <span className="min-w-0 text-right">
                              <span
                                className={`ios-amount ${styles.recordAmount} ${record.type === "income" ? "text-[var(--bb-income)]" : "text-[var(--bb-ink)]"
                                  }`}
                              >
                                {record.type === "income" ? "+" : "-"}
                                {formatFen(record.amountFen)}
                              </span>
                              <time
                                className="mt-1 block whitespace-nowrap text-[11px] text-[var(--bb-muted)] sm:text-xs"
                                dateTime={record.occurredAt.toISOString()}
                              >
                                {group.date
                                  ? new Intl.DateTimeFormat(locale, {
                                    timeZone: "Asia/Shanghai",
                                    hour: "2-digit",
                                    minute: "2-digit",
                                  }).format(record.occurredAt)
                                  : formatLocaleDateTime(record.occurredAt, locale)}
                              </time>
                            </span>
                          </Link>
                        </li>
                      );
                    })}
                  </ul>
                </div>
              ))}
            </div>
          )}
        </div>
      </Reveal>

      {hasPreviousPage || hasNextPage ? (
        <nav
          aria-label={messages.records.paginationLabel}
          className="flex flex-col gap-3 border-t border-[var(--bb-warm-line)] px-1 py-4 sm:flex-row sm:items-center sm:justify-between"
        >
          <div className="min-w-0">
            <p className="text-sm font-semibold text-[var(--bb-ink)]">
              {messages.records.pageStatus(formatLocaleNumber(pageNumber, locale))}
            </p>
            <p className="text-sm text-[var(--bb-muted)]">
              {messages.records.pageSizeHint(
                formatLocaleNumber(records.length, locale),
                records.length,
                hasNextPage,
              )}
            </p>
          </div>
          <div className="flex items-center gap-2">
            {previousPageHref ? (
              <Link
                className="inline-flex min-h-11 items-center justify-center rounded-full border border-[var(--bb-warm-line)] bg-white px-4 text-sm font-semibold text-[var(--bb-ink)] transition hover:bg-[var(--bb-warm-surface)] active:scale-[0.97] motion-reduce:active:scale-100"
                href={previousPageHref}
                prefetch={false}
              >
                {messages.records.previousPage}
              </Link>
            ) : null}
            {nextPageHref ? (
              <Link
                className="inline-flex min-h-11 items-center justify-center rounded-full bg-[var(--bb-accent-soft)] px-4 text-sm font-semibold text-[var(--bb-accent-strong)] transition hover:bg-[color-mix(in_srgb,var(--bb-accent)_25%,white)] active:scale-[0.97] motion-reduce:active:scale-100"
                href={nextPageHref}
                prefetch={false}
              >
                {messages.records.nextPage}
              </Link>
            ) : null}
          </div>
        </nav>
      ) : null}

      {selectedRecord ? (
        <TransactionEditorDrawer
          key={selectedRecord.id}
          categories={categoryOptions}
          closeHref={closeHref}
          context={{ householdId: context.householdId, memberId: context.memberId, ledgerId: selectedRecord.ledgerId }}
          ledgers={view.ledgers}
          readOnly={selectedRecord.ledgerArchivedAt !== null}
          householdMembers={householdMembers.filter((member) => member.id === selectedRecord.actorMemberId || (member.leftAt === null && member.user.status === "ACTIVE")).map((member) => ({
            id: member.id,
            memberName: getMemberDisplayName(member.memberName, member.leftAt !== null || member.user.status !== "ACTIVE", locale),
          }))}
          labels={{
            common: messages.common,
            editor: {
              deleteConfirm: messages.editor.deleteConfirm,
              deleteRecord: messages.editor.deleteRecord,
              deleting: messages.editor.deleting,
              saveChanges: messages.editor.saveChanges,
              title: messages.editor.title,
            },
          }}
          locale={locale}
          record={{
            id: selectedRecord.id,
            amountFen: selectedRecord.amountFen,
            actorMemberId: selectedRecord.actorMemberId,
            categoryId: selectedRecord.categoryId,
            createdByLabel: messages.editor.createdBy(
              formatLocaleDateTime(selectedRecord.occurredAt, locale),
              getMemberDisplayName(selectedRecord.createdByMemberName, selectedRecord.createdByMemberInactive, locale),
            ),
            note: selectedRecord.note,
            occurredAtLocal: getCurrentShanghaiDateTimeLocal(selectedRecord.occurredAt),
            type: selectedRecord.type === "income" ? "income" : "expense",
          }}
          returnTo={returnTo}
        />
      ) : null}
    </section>
  );
}
