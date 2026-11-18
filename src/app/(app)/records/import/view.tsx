import { AndroidUpdateFormStatus } from "@/components/android-update-form-status";
import { EncryptedForm } from "@/components/encrypted-form";
import { ImportCategoryMappingForm } from "@/components/import-category-mapping-form";
import { ImportReviewPanel } from "@/components/import-review-panel";
import { ImportUploadButton } from "@/components/import-upload-button";
import { IosSelect } from "@/components/ios-select";
import { LedgerEntrySelector } from "@/components/ledger-switcher";
import styles from "@/components/finance-b2.module.css";
import { getLedgerDisplayName, getMessages } from "@/lib/i18n";
import { buildImportReviewHref } from "@/lib/imports/review";
import {
  ALIPAY_SOURCE,
  CMB_SOURCE,
  SUI_SHOU_JI_SOURCE,
  WECHAT_PAY_SOURCE,
} from "@/lib/imports/types";
import {
  ImportDraftRowStatus
} from "@prisma/client";
import { ArrowRight, BookOpen, Check, CircleAlert, CircleCheck, Copy, Landmark, Wallet } from "lucide-react";
import Link from "next/link";
import {
  saveImportMemberMappings,
  savePaymentOwnerMember,
  uploadImportDraft,
} from "./actions";
import type { loadImportPage } from "./loader";


export function ImportView({ data }: { data: Awaited<ReturnType<typeof loadImportPage>> }) {
  const { locale, summary, categories, ledgerPage, returnToRecordsHref, errorMessage, noticeMessage, shouldShowPaymentOwnerForm, shouldShowMemberMappingForm, isCompleted, members, review, mappingGroups, paymentOwnerMemberId, activeStep, steps } = data;
  const messages = getMessages(locale);

  return (
    <section className={`${styles.workflow} space-y-5 ${summary && !isCompleted ? "pb-52 md:pb-0" : ""}`}>
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <h1 className="bb-section-title min-w-0 break-words">{messages.import.title}</h1>
        <div className="flex flex-wrap gap-2">
          <Link
            className="inline-flex min-h-11 items-center rounded-xl border border-[var(--bb-warm-line)] bg-white px-3 py-2 text-sm font-medium text-[var(--bb-ink)] transition hover:bg-[var(--bb-warm-surface)]"
            href="/records/import/mappings"
          >
            {messages.import.manageMappings}
          </Link>
          <Link
            className="inline-flex min-h-11 items-center rounded-xl border border-[var(--bb-warm-line)] bg-white px-3 py-2 text-sm font-medium text-[var(--bb-ink)] transition hover:bg-[var(--bb-warm-surface)]"
            href={returnToRecordsHref}
          >
            {messages.import.backToRecords}
          </Link>
        </div>
      </header>

      <p className="text-sm text-[var(--bb-muted)]">
        {messages.import.targetLedgerLabel}: <span className="font-medium text-[var(--bb-ink)]">{getLedgerDisplayName(summary?.ledgerName ?? ledgerPage.ledgerName, locale)}</span>
      </p>

      <nav aria-label={messages.ui.importProgress} className="ios-panel px-3 py-4 sm:px-5">
        <ol className="grid grid-cols-4 gap-2">
          {steps.map((label, index) => (
            <li
              aria-current={index === activeStep ? "step" : undefined}
              className={`flex min-w-0 flex-col items-center gap-2 break-words text-center text-xs sm:text-sm ${index === activeStep ? "font-semibold text-[var(--bb-ink)]" : "text-stone-500"}`}
              key={label}
            >
              <span className={`flex h-7 w-7 items-center justify-center rounded-full text-xs font-semibold ${index < activeStep || isCompleted ? "bg-emerald-50 text-emerald-700" : index === activeStep ? "bg-[var(--bb-primary)] text-white" : "bg-stone-100 text-stone-500"}`}>
                {index < activeStep || isCompleted ? <Check aria-hidden="true" size={15} /> : index + 1}
              </span>
              <span>{label}</span>
            </li>
          ))}
        </ol>
      </nav>

      {errorMessage ? (
        <div className="ios-panel border-red-100 bg-red-50 p-4 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      {noticeMessage ? (
        <div className="ios-panel border-amber-100 bg-amber-50 p-4 text-sm text-amber-800">
          {noticeMessage}
        </div>
      ) : null}

      {!summary ? (
        <EncryptedForm action={uploadImportDraft} className="ios-panel space-y-4 p-5">
          <AndroidUpdateFormStatus />
          <input name="context" type="hidden" value={JSON.stringify(ledgerPage.context)} />
          <LedgerEntrySelector locale={locale} />
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">{messages.import.uploadTitle}</h2>
            <p className="text-sm text-stone-500">{messages.import.uploadDescription}</p>
          </div>
          <fieldset className="space-y-3">
            <legend className="text-sm font-medium text-stone-700">{messages.import.source}</legend>
            <div className="grid grid-cols-2 gap-2 lg:grid-cols-4">
              <label className={styles.sourceOption}>
                <input aria-label={messages.import.sources.suiShouJi} name="source" required type="radio" value={SUI_SHOU_JI_SOURCE} />
                <BookOpen aria-hidden="true" className="text-[var(--bb-accent)]" />
                <span>{messages.import.sources.suiShouJi}</span>
                <span aria-hidden="true" className="text-xs text-[var(--bb-muted)]">.xlsx</span>
              </label>
              <label className={styles.sourceOption}>
                <input aria-label={messages.import.sources.wechatPay} name="source" required type="radio" value={WECHAT_PAY_SOURCE} />
                <Wallet aria-hidden="true" className="text-[var(--bb-income)]" />
                <span>{messages.import.sources.wechatPay}</span>
                <span aria-hidden="true" className="text-xs text-[var(--bb-muted)]">.xlsx</span>
              </label>
              <label className={styles.sourceOption}>
                <input aria-label={messages.import.sources.alipay} name="source" required type="radio" value={ALIPAY_SOURCE} />
                <Wallet aria-hidden="true" className="text-sky-700" />
                <span>{messages.import.sources.alipay}</span>
                <span aria-hidden="true" className="text-xs text-[var(--bb-muted)]">.csv</span>
              </label>
              <label className={styles.sourceOption}>
                <input aria-label={messages.import.sources.cmb} name="source" required type="radio" value={CMB_SOURCE} />
                <Landmark aria-hidden="true" className="text-[var(--bb-accent)]" />
                <span>{messages.import.sources.cmb}</span>
                <span aria-hidden="true" className="text-xs text-[var(--bb-muted)]">.pdf / .zip</span>
              </label>
            </div>
          </fieldset>
          <label className="block space-y-2 text-sm font-medium text-stone-700">
            <span>{messages.import.file}</span>
            <input
              accept=".xlsx,.csv,.pdf,.zip"
              className="block min-h-12 w-full rounded-xl border border-[var(--bb-line-strong)] bg-white px-3 py-2 text-base file:mr-3 file:rounded-xl file:border-0 file:bg-[var(--bb-warm-surface)] file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-[var(--bb-ink)]"
              name="file"
              required
              type="file"
            />
          </label>
          <label className="block space-y-2 text-sm font-medium text-stone-700">
            <span>{messages.import.cmbZipPassword}</span>
            <input
              autoComplete="off"
              className="ios-field"
              name="zipPassword"
              type="password"
            />
            <span className="block text-xs font-normal text-stone-500">
              {messages.import.cmbZipPasswordDescription}
            </span>
          </label>
          <ImportUploadButton locale={locale} />
        </EncryptedForm>
      ) : summary.blockedReason ? (
        <div className="ios-panel space-y-2 p-4 sm:p-5" role="status">
          <p className="font-medium text-amber-900">
            {summary.blockedReason === "INACTIVE_CREATOR"
              ? messages.import.inactiveCreatorNotice : messages.import.archivedLedgerNotice}
          </p>
          <p className="text-sm text-[var(--bb-muted)]">{summary.fileName}</p>
        </div>
      ) : isCompleted ? (
        <div className="ios-panel space-y-4 p-5">
          <div className="space-y-1">
            <CircleCheck aria-hidden="true" className="mb-3 text-emerald-700" size={28} />
            <h2 className="text-lg font-semibold">{messages.import.completedTitle}</h2>
            <p className="text-sm text-stone-500">{messages.import.completedDescription}</p>
          </div>
          <div className="space-y-3">
            <h3 className="text-sm font-semibold text-stone-800">
              {messages.import.completedSummaryTitle}
            </h3>
            <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
              {[
                [messages.import.readyRows, summary.counts.importable],
                [messages.import.skippedRows, summary.counts.userSkipped],
                [messages.import.sourceDuplicateRows, summary.counts.sourceDuplicate],
                [messages.import.invalidRows, summary.counts.invalid],
              ].map(([label, value]) => (
                <div className="rounded-2xl bg-stone-50 p-3" key={label}>
                  <p className="text-xs text-stone-500">{label}</p>
                  <p className="mt-1 text-xl font-semibold">{value}</p>
                </div>
              ))}
            </div>
          </div>
          <Link
            className="inline-flex rounded-full bg-[var(--bb-primary)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[var(--bb-primary-hover)]"
            href={`/records?ledger=${encodeURIComponent(summary.ledgerId)}`}
          >
            {messages.import.backToRecords}
          </Link>
        </div>
      ) : (
        <div className="space-y-6" data-import-draft={summary.id}>
          <div className="ios-panel space-y-4 p-4 sm:p-5">
            <div className="space-y-1">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <h2 className="text-lg font-semibold">{messages.import.summaryTitle}</h2>
                <p className="text-xs text-stone-500">{messages.import.totalRows}: {summary.counts.total}</p>
              </div>
              <p className="truncate text-sm text-stone-500" title={summary.fileName}>
                {messages.import.fileName}: {summary.fileName}
              </p>
            </div>
            <div className="space-y-2">
              <h3 className="text-xs font-medium text-stone-500">{messages.ui.importActionSummary}</h3>
              <div className="grid grid-cols-3 gap-2">
                <Link
                  aria-label={`${messages.import.needsMappingRows} ${summary.counts.needsMapping}`}
                  className={`min-w-0 break-words rounded-2xl border p-3 transition hover:border-stone-400 ${summary.counts.needsMapping > 0 ? "border-amber-200 bg-amber-50 text-amber-900" : "border-stone-100 bg-stone-50 text-stone-600"}`}
                  href="#import-mappings"
                >
                  {summary.counts.needsMapping > 0 ? <CircleAlert aria-hidden="true" size={16} /> : <CircleCheck aria-hidden="true" size={16} />}
                  <p className="mt-2 text-xs font-medium">{messages.import.needsMappingRows}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{summary.counts.needsMapping}</p>
                </Link>
                <Link
                  aria-label={`${messages.import.duplicateRows} ${summary.counts.possibleDuplicate}`}
                  className={`min-w-0 break-words rounded-2xl border p-3 transition hover:border-stone-400 ${summary.counts.possibleDuplicate > 0 ? "border-amber-200 bg-amber-50 text-amber-900" : "border-stone-100 bg-stone-50 text-stone-600"}`}
                  href={`${buildImportReviewHref(summary.id, ImportDraftRowStatus.POSSIBLE_DUPLICATE, 1)}#import-review`}
                >
                  <Copy aria-hidden="true" size={16} />
                  <p className="mt-2 text-xs font-medium">{messages.import.duplicateRows}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{summary.counts.possibleDuplicate}</p>
                </Link>
                <div className="min-w-0 break-words rounded-2xl border border-stone-100 bg-stone-50 p-3 text-stone-700">
                  <CircleCheck aria-hidden="true" size={16} />
                  <p className="mt-2 text-xs font-medium">{messages.import.readyRows}</p>
                  <p className="mt-1 text-2xl font-semibold tabular-nums">{summary.counts.importable}</p>
                </div>
              </div>
              {summary.hasUnresolvedMemberMappings ? (
                <Link className="flex items-center justify-between gap-2 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-sm font-medium text-amber-900" href="#import-members">
                  <span>{messages.import.confirmDisabledByMemberMappings}</span>
                  <ArrowRight aria-hidden="true" className="shrink-0" size={16} />
                </Link>
              ) : null}
            </div>
            <details className="border-t border-stone-100 pt-3">
              <summary className="min-h-11 cursor-pointer py-2 text-sm text-[var(--bb-muted)]">{messages.ui.importOtherCounts}</summary>
              <div className="mt-3 grid grid-cols-3 gap-2">
                {[
                  { label: messages.import.sourceDuplicateRows, count: summary.counts.sourceDuplicate, status: ImportDraftRowStatus.SOURCE_DUPLICATE },
                  { label: messages.import.skippedRows, count: summary.counts.userSkipped, status: ImportDraftRowStatus.USER_SKIPPED },
                  { label: messages.import.invalidRows, count: summary.counts.invalid, status: ImportDraftRowStatus.INVALID },
                ].map((item) => (
                  <Link className="rounded-xl bg-stone-50 p-3 transition hover:bg-stone-100" href={`${buildImportReviewHref(summary.id, item.status, 1)}#import-review`} key={item.status}>
                    <p className="text-xs text-stone-500">{item.label}</p>
                    <p className="mt-1 text-lg font-semibold tabular-nums">{item.count}</p>
                  </Link>
                ))}
              </div>
            </details>
          </div>

          {shouldShowPaymentOwnerForm && paymentOwnerMemberId ? (
            <EncryptedForm action={savePaymentOwnerMember} className="ios-panel scroll-mt-4 space-y-3 p-4 sm:p-5" id="import-members">
              <AndroidUpdateFormStatus />
              <input name="draftId" type="hidden" value={summary.id} />
              <input name="reviewStatus" type="hidden" value={review.status} />
              <input name="reviewPage" type="hidden" value={review.page} />
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">{messages.import.ownerMemberTitle}</h2>
                <p className="text-sm text-stone-500">{messages.import.ownerMemberDescription}</p>
              </div>
              <label className="block space-y-2 text-sm font-medium text-stone-700">
                <span>{messages.common.who}</span>
                <IosSelect
                  defaultValue={members.some(({ id }) => id === paymentOwnerMemberId) ? paymentOwnerMemberId : ""}
                  name="ownerMemberId"
                  required
                  options={[{ disabled: true, value: "", label: messages.common.who }, ...members.map((member) => ({ value: member.id, label: member.memberName }))]}
                />
              </label>
              <button
                className="min-h-11 w-full rounded-xl border border-[var(--bb-line-strong)] bg-white px-4 py-2.5 text-sm font-semibold text-[var(--bb-ink)] transition hover:bg-[var(--bb-warm-surface)] sm:w-auto"
                type="submit"
              >
                {messages.import.saveOwnerMember}
              </button>
            </EncryptedForm>
          ) : null}

          {shouldShowMemberMappingForm ? (
            <EncryptedForm action={saveImportMemberMappings} className="ios-panel scroll-mt-4 space-y-3 p-4 sm:p-5" id="import-members">
              <AndroidUpdateFormStatus />
              <input name="draftId" type="hidden" value={summary.id} />
              <input name="reviewStatus" type="hidden" value={review.status} />
              <input name="reviewPage" type="hidden" value={review.page} />
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">{messages.import.memberMappingTitle}</h2>
                <p className="text-sm text-stone-500">
                  {messages.import.memberMappingDescription}
                </p>
              </div>
              <div className="grid gap-3 sm:grid-cols-2">
                {summary.memberMappings.map((mapping) => (
                  <label
                    className="block space-y-2 rounded-2xl border border-stone-100 bg-stone-50 p-3"
                    key={mapping.externalName}
                  >
                    <span className="block text-sm font-medium text-stone-800">
                      <span className="font-normal text-stone-500">{messages.import.externalAccount}: </span>{mapping.externalName}
                    </span>
                    <IosSelect
                      defaultValue={members.some(({ id }) => id === mapping.memberId) ? mapping.memberId : ""}
                      name={`memberMapping:${mapping.externalName}`}
                      required
                      options={[{ disabled: true, value: "", label: messages.common.who }, ...members.map((member) => ({ value: member.id, label: member.memberName }))]}
                    />
                  </label>
                ))}
              </div>
              <button
                className="min-h-11 w-full rounded-xl border border-[var(--bb-line-strong)] bg-white px-4 py-2.5 text-sm font-semibold text-[var(--bb-ink)] transition hover:bg-[var(--bb-warm-surface)] sm:w-auto"
                type="submit"
              >
                {messages.import.saveMemberMappings}
              </button>
            </EncryptedForm>
          ) : null}

          {mappingGroups.length > 0 ? (
            <ImportCategoryMappingForm
              key={summary.id}
              draftId={summary.id}
              locale={locale}
              groups={mappingGroups}
              categories={categories}
            />
          ) : (
            <p className="flex scroll-mt-4 items-center gap-2 px-1 text-sm text-stone-600" id="import-mappings">
              <CircleCheck aria-hidden="true" className="text-emerald-700" size={17} />
              {messages.ui.importMappingComplete}
            </p>
          )}

          <ImportReviewPanel
            key={`${summary.id}:${review.status}:${review.page}:${review.rows.map((row) => `${row.id}:${row.status}:${row.userDecision}:${row.categoryId}:${row.actorMemberId}:${row.createdByMemberId}`).join(",")}`}
            draftId={summary.id}
            locale={locale}
            source={summary.source}
            rows={review.rows.map((row) => ({ ...row, occurredAt: row.occurredAt?.toISOString() ?? null }))}
            members={members}
            status={review.status}
            page={review.page}
            pageCount={review.pageCount}
            total={review.total}
            needsMapping={summary.counts.needsMapping > 0}
            needsMemberMapping={summary.hasUnresolvedMemberMappings}
          />
        </div>
      )}
    </section>
  );
}
