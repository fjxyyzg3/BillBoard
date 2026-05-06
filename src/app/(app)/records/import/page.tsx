import {
  ImportDraftRowStatus,
  ImportDraftStatus,
  ImportRowDecision,
  TransactionType,
} from "@prisma/client";
import Link from "next/link";

import { requireAppSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getImportDraftSummary } from "@/lib/imports/drafts";
import { formatLocaleDateTime, getCategoryDisplayName, getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import { formatFen } from "@/lib/money";

import {
  confirmImportDraftAction,
  saveImportDecisions,
  saveImportMappings,
  uploadSuiShouJiImportDraft,
} from "./actions";

type ImportPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

type CategoryOption = {
  id: string;
  name: string;
  type: "EXPENSE" | "INCOME";
};

const duplicateReviewRowLimit = 50;
const duplicateCandidateLimit = 3;

function readParam(
  searchParams: Record<string, string | string[] | undefined> | undefined,
  key: string,
) {
  const value = searchParams?.[key];

  return Array.isArray(value) ? value[0] : value;
}

function formatNullableAmount(amountFen: number | null) {
  return amountFen === null ? "-" : formatFen(amountFen);
}

function transactionTypeLabel(type: TransactionType | null, labels: { expense: string; income: string }) {
  if (type === TransactionType.INCOME) {
    return labels.income;
  }

  if (type === TransactionType.EXPENSE) {
    return labels.expense;
  }

  return "-";
}

function sourceLabel(source: string | null, manualSource: string) {
  return source || manualSource;
}

export default async function ImportRecordsPage({ searchParams }: ImportPageProps) {
  const sessionUser = await requireAppSession();
  const locale = await getServerLocale();
  const messages = getMessages(locale);
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const draftId = readParam(resolvedSearchParams, "draft")?.trim();
  const error = readParam(resolvedSearchParams, "error");
  const errorMessage =
    error && error in messages.import.errors
      ? messages.import.errors[error as keyof typeof messages.import.errors]
      : null;
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

  const duplicateRows =
    summary?.rows.filter(
      (row) =>
        row.duplicateCandidates.length > 0 &&
        (row.status === ImportDraftRowStatus.POSSIBLE_DUPLICATE ||
          row.status === ImportDraftRowStatus.USER_SKIPPED),
    ) ?? [];
  const visibleDuplicateRows = duplicateRows.slice(0, duplicateReviewRowLimit);
  const hiddenDuplicateRowCount = duplicateRows.length - visibleDuplicateRows.length;
  const isCompleted = summary?.status === ImportDraftStatus.COMPLETED;

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ios-muted)]">
            {messages.import.eyebrow}
          </p>
          <h1 className="text-2xl font-semibold">{messages.import.title}</h1>
          <p className="text-sm text-stone-500">{messages.import.description}</p>
        </div>
        <Link
          className="self-start rounded-full border border-stone-200 bg-white px-3 py-2 text-sm font-medium text-stone-700 shadow-sm transition hover:bg-stone-50 sm:self-auto"
          href="/records"
        >
          {messages.import.backToRecords}
        </Link>
      </header>

      {errorMessage ? (
        <div className="ios-panel border-red-100 bg-red-50 p-4 text-sm text-red-700">
          {errorMessage}
        </div>
      ) : null}

      {!summary ? (
        <form action={uploadSuiShouJiImportDraft} className="ios-panel space-y-4 p-5">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">{messages.import.uploadTitle}</h2>
            <p className="text-sm text-stone-500">{messages.import.uploadDescription}</p>
          </div>
          <label className="block space-y-2 text-sm font-medium text-stone-700">
            <span>{messages.import.file}</span>
            <input
              accept=".xlsx"
              className="block w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm file:mr-3 file:rounded-full file:border-0 file:bg-stone-900 file:px-3 file:py-1.5 file:text-sm file:font-medium file:text-white"
              name="file"
              required
              type="file"
            />
          </label>
          <button
            className="w-full rounded-full bg-stone-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-stone-700"
            type="submit"
          >
            {messages.import.upload}
          </button>
        </form>
      ) : isCompleted ? (
        <div className="ios-panel space-y-4 p-5">
          <div className="space-y-1">
            <h2 className="text-lg font-semibold">{messages.import.completedTitle}</h2>
            <p className="text-sm text-stone-500">{messages.import.completedDescription}</p>
          </div>
          <Link
            className="inline-flex rounded-full bg-stone-900 px-4 py-2 text-sm font-semibold text-white transition hover:bg-stone-700"
            href="/records"
          >
            {messages.import.backToRecords}
          </Link>
        </div>
      ) : (
        <>
          <div className="ios-panel grid grid-cols-2 gap-3 p-5 sm:grid-cols-3">
            <div className="col-span-2 space-y-1 sm:col-span-3">
              <h2 className="text-lg font-semibold">{messages.import.summaryTitle}</h2>
              <p className="truncate text-sm text-stone-500">
                {messages.import.fileName}: {summary.fileName}
              </p>
            </div>
            {[
              [messages.import.totalRows, summary.counts.total],
              [messages.import.readyRows, summary.counts.importable],
              [messages.import.needsMappingRows, summary.counts.needsMapping],
              [messages.import.duplicateRows, summary.counts.possibleDuplicate],
              [messages.import.sourceDuplicateRows, summary.counts.sourceDuplicate],
              [messages.import.skippedRows, summary.counts.userSkipped],
              [messages.import.invalidRows, summary.counts.invalid],
            ].map(([label, value]) => (
              <div className="rounded-2xl bg-stone-50 p-3" key={label}>
                <p className="text-xs text-stone-500">{label}</p>
                <p className="mt-1 text-xl font-semibold">{value}</p>
              </div>
            ))}
          </div>

          {summary.missingMappings.length > 0 ? (
            <form action={saveImportMappings} className="ios-panel space-y-4 p-5">
              <input name="draftId" type="hidden" value={summary.id} />
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">{messages.import.mappingTitle}</h2>
                <p className="text-sm text-stone-500">{messages.import.mappingDescription}</p>
              </div>
              <div className="space-y-3">
                {summary.missingMappings.map((mapping) => {
                  const options = categories.filter((category) => {
                    if (mapping.transactionType === TransactionType.INCOME) {
                      return category.type === "INCOME";
                    }

                    return category.type === "EXPENSE";
                  });

                  return (
                    <label
                      className="block space-y-2 rounded-2xl border border-stone-100 bg-stone-50 p-3"
                      key={mapping.mappingKey}
                    >
                      <span className="block text-sm font-medium text-stone-800">
                        {transactionTypeLabel(mapping.transactionType, messages.common)} ·{" "}
                        {mapping.primaryCategory || "-"} / {mapping.secondaryCategory || "-"}
                      </span>
                      <span className="block text-xs text-stone-500">
                        {messages.import.mappingCount(mapping.count)}
                      </span>
                      <select
                        className="w-full rounded-xl border border-stone-200 bg-white px-3 py-2 text-sm"
                        name={`mapping:${mapping.mappingKey}`}
                        required
                      >
                        <option value="">{messages.common.category}</option>
                        {options.map((category) => (
                          <option key={category.id} value={category.id}>
                            {getCategoryDisplayName(category.name, locale)}
                          </option>
                        ))}
                      </select>
                    </label>
                  );
                })}
              </div>
              <button
                className="w-full rounded-full bg-stone-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-stone-700"
                type="submit"
              >
                {messages.import.saveMappings}
              </button>
            </form>
          ) : null}

          {duplicateRows.length > 0 ? (
            <form action={saveImportDecisions} className="ios-panel space-y-4 p-5">
              <input name="draftId" type="hidden" value={summary.id} />
              <div className="space-y-1">
                <h2 className="text-lg font-semibold">{messages.import.duplicateTitle}</h2>
                <p className="text-sm text-stone-500">{messages.import.duplicateDescription}</p>
              </div>
              <div className="space-y-3">
                {visibleDuplicateRows.map((row) => {
                  const visibleCandidates = row.duplicateCandidates.slice(0, duplicateCandidateLimit);
                  const hiddenCandidateCount = row.duplicateCandidates.length - visibleCandidates.length;

                  return (
                    <div className="space-y-3 rounded-2xl border border-stone-100 bg-stone-50 p-3" key={row.id}>
                      <div className="space-y-1">
                        <p className="text-sm font-medium text-stone-800">
                          {messages.import.importedRow} #{row.rowNumber}
                        </p>
                        <p className="text-xs text-stone-500">
                          {row.occurredAt ? formatLocaleDateTime(row.occurredAt, locale) : "-"} ·{" "}
                          {formatNullableAmount(row.amountFen)} · {row.primaryCategory || "-"} /{" "}
                          {row.secondaryCategory || "-"}
                        </p>
                      </div>
                      <div className="space-y-2">
                        {visibleCandidates.map((candidate) => (
                          <div className="rounded-xl bg-white p-3 text-xs text-stone-600" key={candidate.id}>
                            <p className="font-medium text-stone-800">
                              {messages.import.duplicateCandidate}
                            </p>
                            <p>
                              {formatLocaleDateTime(new Date(candidate.occurredAt), locale)} ·{" "}
                              {formatFen(candidate.amountFen)} ·{" "}
                              {sourceLabel(candidate.source, messages.import.manualSource)}
                            </p>
                          </div>
                        ))}
                        {hiddenCandidateCount > 0 ? (
                          <p className="text-xs text-stone-500">
                            {messages.import.hiddenDuplicateCandidates(hiddenCandidateCount)}
                          </p>
                        ) : null}
                      </div>
                      <div className="grid grid-cols-2 gap-2">
                        <label className="flex items-center justify-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-2 text-sm font-medium">
                          <input
                            defaultChecked={row.userDecision === ImportRowDecision.KEEP}
                            name={`decision:${row.id}`}
                            type="radio"
                            value={ImportRowDecision.KEEP}
                          />
                          {messages.import.keep}
                        </label>
                        <label className="flex items-center justify-center gap-2 rounded-full border border-stone-200 bg-white px-3 py-2 text-sm font-medium">
                          <input
                            defaultChecked={row.userDecision === ImportRowDecision.SKIP}
                            name={`decision:${row.id}`}
                            type="radio"
                            value={ImportRowDecision.SKIP}
                          />
                          {messages.import.skip}
                        </label>
                      </div>
                    </div>
                  );
                })}
                {hiddenDuplicateRowCount > 0 ? (
                  <p className="rounded-2xl bg-stone-50 p-3 text-sm text-stone-500">
                    {messages.import.hiddenDuplicateRows(hiddenDuplicateRowCount)}
                  </p>
                ) : null}
              </div>
              <button
                className="w-full rounded-full bg-stone-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-stone-700"
                type="submit"
              >
                {messages.import.saveDecisions}
              </button>
            </form>
          ) : null}

          <form action={confirmImportDraftAction} className="ios-panel space-y-3 p-5">
            <input name="draftId" type="hidden" value={summary.id} />
            {summary.counts.needsMapping > 0 ? (
              <p className="text-sm text-stone-500">{messages.import.confirmDisabled}</p>
            ) : null}
            <button
              className="w-full rounded-full bg-stone-900 px-4 py-3 text-sm font-semibold text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-300"
              disabled={summary.counts.needsMapping > 0}
              type="submit"
            >
              {messages.import.confirmImport}
            </button>
          </form>
        </>
      )}
    </section>
  );
}
