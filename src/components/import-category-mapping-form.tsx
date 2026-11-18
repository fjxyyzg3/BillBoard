"use client";

import { IosSelect } from "@/components/ios-select";

import { invokeEncryptedAction } from "@/lib/encryption/client";

import { useProcessingChoice } from "@/components/processing-provider";
import { useImportMappingNavigationGuard } from "@/components/use-import-mapping-navigation-guard";
import styles from "./finance-b2.module.css";

import { TransactionType } from "@prisma/client";
import { useRouter } from "next/navigation";
import { useEffect, useRef, useState, useTransition } from "react";
import type { FormEvent } from "react";

import { saveImportMappingChanges } from "@/app/(app)/records/import/actions";
import { recommendImportMappings } from "@/app/(app)/records/import/agent-actions";
import { getCategoryDisplayName, getMessages, type Locale } from "@/lib/i18n";
import {
  getImportMappingChanges,
  getImportMappingRecommendationTargets,
  IGNORE_IMPORT_MAPPING_VALUE,
  mergeImportMappingSuggestions,
  type ImportMappingFormGroup,
} from "@/lib/imports/mapping-form";

type Props = {
  draftId: string;
  locale: Locale;
  groups: ImportMappingFormGroup[];
  categories: Array<{ id: string; name: string; type: "EXPENSE" | "INCOME" }>;
};

type RecommendationError = Extract<Awaited<ReturnType<typeof recommendImportMappings>>, { success: false }>["error"];

export function ImportCategoryMappingForm(props: Props) {
  const [processedOpen, setProcessedOpen] = useState(false);

  return <ImportCategoryMappingEditor
    key={`${props.draftId}:${JSON.stringify(props.groups)}`}
    onProcessedOpenChange={setProcessedOpen}
    processedOpen={processedOpen}
    {...props}
  />;
}

function ImportCategoryMappingEditor({ draftId, locale, groups, categories, processedOpen, onProcessedOpenChange }: Props & {
  processedOpen: boolean;
  onProcessedOpenChange: (open: boolean) => void;
}) {
  const processing = useProcessingChoice();
  const router = useRouter();
  const messages = getMessages(locale);
  const labels = messages.import;
  const [baseline, setBaseline] = useState(groups);
  const [choices, setChoices] = useState<Record<string, string>>({});
  const [saving, setSaving] = useState(false);
  const [refreshing, startRefresh] = useTransition();
  const [feedback, setFeedback] = useState<"saved" | "failed" | null>(null);
  const [recommending, setRecommending] = useState(false);
  const [progress, setProgress] = useState({ completed: 0, total: 0 });
  const [recommendationFeedback, setRecommendationFeedback] = useState<RecommendationError | "complete" | null>(null);
  const busyRef = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const choicesRef = useRef<Record<string, string>>({});
  const choiceVersions = useRef<Record<string, number>>({});
  const activeRecommendation = useRef<object | null>(null);
  const busy = saving || refreshing;
  const remaining = getImportMappingRecommendationTargets(baseline, choices).length;
  const pendingGroups = baseline.filter((group) => !group.initialValue);
  const processedGroups = baseline.filter((group) => !!group.initialValue);
  const changeCount = getImportMappingChanges(baseline, choices).length;
  useImportMappingNavigationGuard({
    dirty: changeCount > 0, pending: busy || recommending, formRef, locale,
    onDiscard: () => { choicesRef.current = {}; setChoices({}); },
  });

  useEffect(() => () => {
    activeRecommendation.current = null;
  }, []);

  async function recommendMappings() {
    if (busyRef.current || busy || activeRecommendation.current) return;
    if (!processing.ensure("ai")) return;

    const targets = getImportMappingRecommendationTargets(baseline, choicesRef.current);
    if (targets.length === 0) return;

    const run = {};
    const versions = Object.fromEntries(targets.map((key) => [key, choiceVersions.current[key] ?? 0]));
    activeRecommendation.current = run;
    setRecommending(true);
    setFeedback(null);
    setRecommendationFeedback(null);
    setProgress({ completed: 0, total: targets.length });

    try {
      for (let offset = 0; offset < targets.length; offset += 25) {
        if (activeRecommendation.current !== run) return;
        const eligible = new Set(getImportMappingRecommendationTargets(baseline, choicesRef.current));
        const batch = targets.slice(offset, offset + 25).filter((key) =>
          eligible.has(key) && (choiceVersions.current[key] ?? 0) === versions[key],
        );

        if (batch.length > 0) {
          const result = await invokeEncryptedAction(recommendImportMappings, draftId, batch);
          if (activeRecommendation.current !== run) return;
          if (!result.success) {
            setRecommendationFeedback(result.error);
            return;
          }

          const requestedVersions = Object.fromEntries(batch.map((key) => [key, versions[key]]));
          const nextChoices = mergeImportMappingSuggestions(
            baseline, choicesRef.current, result.suggestions, requestedVersions, choiceVersions.current,
          );
          choicesRef.current = nextChoices;
          setChoices(nextChoices);
        }

        setProgress({ completed: Math.min(offset + 25, targets.length), total: targets.length });
      }
      setRecommendationFeedback("complete");
    } catch {
      if (activeRecommendation.current === run) setRecommendationFeedback("FAILED");
    } finally {
      if (activeRecommendation.current === run) {
        activeRecommendation.current = null;
        setRecommending(false);
      }
    }
  }

  async function saveMappings(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    if (busyRef.current || busy || activeRecommendation.current) return;

    const changes = getImportMappingChanges(baseline, choices);
    if (changes.length === 0) return;

    busyRef.current = true;
    setSaving(true);
    setFeedback(null);
    try {
      const result = await invokeEncryptedAction(saveImportMappingChanges, draftId, changes);
      if (!result.success) {
        setFeedback("failed");
        return;
      }

      const savedChoices = new Map(changes.map((mapping) => [
        mapping.mappingKey, mapping.categoryId ?? IGNORE_IMPORT_MAPPING_VALUE,
      ]));
      setBaseline(baseline.map((group) => ({
        ...group,
        initialValue: savedChoices.get(group.mappingKey) ?? group.initialValue,
      })));
      setFeedback("saved");
      startRefresh(() => router.refresh());
    } catch {
      setFeedback("failed");
    } finally {
      busyRef.current = false;
      setSaving(false);
    }
  }

  function renderMapping(mapping: ImportMappingFormGroup) {
    const typeLabel = mapping.transactionType === TransactionType.INCOME
      ? messages.common.income
      : mapping.transactionType === TransactionType.EXPENSE ? messages.common.expense : "-";
    const categoryLabel = mapping.secondaryCategory
      ? `${mapping.primaryCategory || "-"} / ${mapping.secondaryCategory}`
      : mapping.primaryCategory || "-";
    const options = categories.filter((category) =>
      category.type === (mapping.transactionType === TransactionType.INCOME ? "INCOME" : "EXPENSE"),
    );

    return (
      <label className={`${styles.mappingCard} block min-w-0 space-y-2 rounded-2xl border p-3`} key={mapping.mappingKey}>
        <span className="flex items-start justify-between gap-3">
          <span className="min-w-0 break-words text-sm font-medium text-[var(--bb-ink)]">{`${typeLabel} · ${categoryLabel}`}</span>
          <span className="shrink-0 text-xs leading-5 text-[var(--bb-muted)]">{labels.mappingCount(mapping.count)}</span>
        </span>
        <IosSelect
          disabled={busy}
          name={`mapping:${mapping.mappingKey}`}
          onChange={(event) => {
            choiceVersions.current[mapping.mappingKey] = (choiceVersions.current[mapping.mappingKey] ?? 0) + 1;
            const nextChoices = { ...choicesRef.current, [mapping.mappingKey]: event.target.value };
            choicesRef.current = nextChoices;
            setChoices(nextChoices);
            setFeedback(null);
          }}
          value={choices[mapping.mappingKey] ?? mapping.initialValue}
          options={[
            { value: "", label: messages.common.category },
            { value: IGNORE_IMPORT_MAPPING_VALUE, label: labels.ignoreMapping },
            ...options.map((category) => ({ value: category.id, label: getCategoryDisplayName(category.name, locale) })),
          ]}
        />
      </label>
    );
  }

  return (
    <form
      data-apk-update-blocked={busy || recommending || undefined}
      data-desktop-update-dirty={changeCount > 0 || undefined}
      className={`${styles.workflow} ios-panel scroll-mt-4 space-y-4 p-4 sm:p-5`}
      id="import-mappings"
      onSubmit={saveMappings}
      ref={formRef}
    >
      <div className="space-y-1">
        <h2 className="text-lg font-semibold">{labels.mappingTitle}</h2>
        <p className="text-sm leading-relaxed text-[var(--bb-muted)]">{labels.mappingDescription}</p>
        <p className="text-xs leading-relaxed text-[var(--bb-muted)]">{labels.ignoreMappingDescription}</p>
      </div>
      <div className="space-y-2">
        <button
          className="min-h-11 w-full rounded-xl border border-[var(--bb-line-strong)] bg-white px-4 py-2.5 text-sm font-semibold text-[var(--bb-ink)] transition hover:bg-[var(--bb-warm-surface)] disabled:opacity-50 sm:w-auto"
          disabled={busy || recommending || remaining === 0}
          onClick={recommendMappings}
          type="button"
        >
          {recommending ? labels.recommendingMappings : labels.recommendMappings}
        </button>
        <p className="text-xs text-stone-500">{labels.recommendationDescription}</p>
        {recommending ? (
          <p className="text-sm text-stone-600" role="status">
            {labels.recommendationProgress(progress.completed, progress.total)}
          </p>
        ) : recommendationFeedback ? (
          <p
            className={`text-sm ${recommendationFeedback === "complete" ? "text-stone-600" : "text-red-700"}`}
            role={recommendationFeedback === "complete" ? "status" : "alert"}
          >
            {recommendationFeedback === "complete"
              ? labels.recommendationsReady(remaining)
              : labels.recommendationErrors[recommendationFeedback]}
          </p>
        ) : null}
      </div>
      {pendingGroups.length > 0 ? (
        <section className="space-y-3">
          <h3 className="text-sm font-semibold text-[var(--bb-ink)]">{labels.pendingMappings(pendingGroups.length)}</h3>
          <div className="grid gap-3 sm:grid-cols-2">{pendingGroups.map(renderMapping)}</div>
        </section>
      ) : null}
      {processedGroups.length > 0 ? (
        <details className="rounded-2xl border border-[var(--bb-warm-line)] px-3" data-testid="import-processed-mappings" onToggle={(event) => {
          if (event.currentTarget.open !== processedOpen) onProcessedOpenChange(event.currentTarget.open);
        }} open={processedOpen}>
          <summary className="min-h-11 cursor-pointer py-3 text-sm font-semibold text-[var(--bb-muted)]" onClick={(event) => {
            event.preventDefault();
            onProcessedOpenChange(!processedOpen);
          }}>{labels.processedMappings(processedGroups.length)}</summary>
          <div className="grid gap-3 pb-3 sm:grid-cols-2">{processedGroups.map(renderMapping)}</div>
        </details>
      ) : null}
      {feedback ? (
        <p
          className={`text-sm ${feedback === "failed" ? "text-red-700" : "text-emerald-700"}`}
          role={feedback === "failed" ? "alert" : "status"}
        >
          {feedback === "failed" ? labels.mappingsSaveFailed : labels.mappingsSaved}
        </p>
      ) : null}
      <div className="space-y-2 border-t border-[var(--bb-warm-line)] pt-4">
        {changeCount > 0 ? <p className="text-sm text-amber-800" role="status">{labels.unsavedMappings(changeCount)}</p> : null}
        <button
          className={`${styles.primaryButton} w-full bg-[var(--bb-primary)] px-4 text-white transition hover:bg-[var(--bb-primary-hover)] disabled:bg-stone-200 disabled:text-stone-500 sm:w-auto`}
          disabled={busy || recommending || changeCount === 0}
          type="submit"
        >
          {busy ? labels.savingMappings : labels.saveMappings}
        </button>
      </div>
    </form>
  );
}
