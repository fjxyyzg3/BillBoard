"use client";

import { useActionState, useEffect, useState } from "react";
import {
  submitTransaction,
  type CreateTransactionActionState,
} from "@/app/(app)/add/actions";
import {
  CategoryPicker,
  type TransactionCategory,
} from "@/components/category-picker";
import { IosSelect } from "@/components/ios-select";
import type { Locale, Messages } from "@/lib/i18n";
import { getCurrentShanghaiDateTimeLocal } from "@/lib/transactions/datetime";

type HouseholdMemberOption = {
  id: string;
  memberName: string;
};

type TransactionFormProps = {
  categories: TransactionCategory[];
  householdMembers: HouseholdMemberOption[];
  currentMemberId: string;
  labels: {
    add: Pick<Messages["add"], "save">;
    common: Messages["common"];
  };
  locale: Locale;
  sharedFilters: {
    perspective?: string;
    range?: string;
  };
  successDetail?: string;
  successMessage?: string;
};

const initialCreateTransactionState: CreateTransactionActionState = {
  status: "idle",
};

function getFirstCategoryId(
  categories: TransactionCategory[],
  type: TransactionCategory["type"],
) {
  return categories.find((category) => category.type === type)?.id ?? "";
}

function SuccessToast({ detail, message }: { detail?: string; message: string }) {
  const [isVisible, setIsVisible] = useState(true);

  useEffect(() => {
    const timeoutId = window.setTimeout(() => {
      setIsVisible(false);
    }, 2500);

    return () => window.clearTimeout(timeoutId);
  }, []);

  if (!isVisible) {
    return null;
  }

  return (
    <div
      aria-live="polite"
      className="fixed left-4 right-4 top-[calc(env(safe-area-inset-top)+1rem)] z-50 mx-auto max-w-md rounded-2xl border border-emerald-200 bg-white/95 px-4 py-3 text-sm text-emerald-800 shadow-[0_12px_32px_rgba(15,23,42,0.16)] backdrop-blur"
      role="status"
    >
      <p className="font-medium">{message}</p>
      {detail ? <p>{detail}</p> : null}
    </div>
  );
}

export function TransactionForm({
  categories,
  householdMembers,
  currentMemberId,
  labels,
  locale,
  sharedFilters,
  successDetail,
  successMessage,
}: TransactionFormProps) {
  const defaultType = "expense" as const;
  const occurredAtDefault = getCurrentShanghaiDateTimeLocal();
  const [state, formAction, isPending] = useActionState(
    submitTransaction,
    initialCreateTransactionState,
  );
  const [selectedType, setSelectedType] = useState<TransactionCategory["type"]>(defaultType);
  const [selectedCategoryId, setSelectedCategoryId] = useState(
    getFirstCategoryId(categories, defaultType),
  );

  function handleTypeChange(type: TransactionCategory["type"]) {
    setSelectedType(type);

    const categoryStillMatches = categories.some(
      (category) => category.id === selectedCategoryId && category.type === type,
    );

    if (!categoryStillMatches) {
      setSelectedCategoryId(getFirstCategoryId(categories, type));
    }
  }

  return (
    <form action={formAction} className="ios-panel space-y-5 p-4 sm:p-5">
      <input name="locale" type="hidden" value={locale} />
      {sharedFilters.perspective ? (
        <input name="perspective" type="hidden" value={sharedFilters.perspective} />
      ) : null}
      {sharedFilters.range ? <input name="range" type="hidden" value={sharedFilters.range} /> : null}
      <div className="space-y-2">
        <span className="text-sm font-medium text-[var(--ios-text)]">{labels.common.type}</span>
        <div className="grid grid-cols-2 rounded-full bg-[#e8e8ed] p-1 text-sm">
          {(["expense", "income"] as const).map((type) => {
            const isActive = selectedType === type;

            return (
              <label
                className={`cursor-pointer rounded-full px-3 py-2 text-center font-medium transition ${
                  isActive
                    ? "bg-white text-[var(--ios-text)] shadow-[0_3px_10px_rgba(0,0,0,0.12)]"
                    : "text-[var(--ios-muted)]"
                }`}
                key={type}
              >
                <input
                  checked={isActive}
                  className="sr-only"
                  name="type"
                  onChange={() => handleTypeChange(type)}
                  type="radio"
                  value={type}
                />
                {type === "expense" ? labels.common.expense : labels.common.income}
              </label>
            );
          })}
        </div>
      </div>

      <label className="space-y-2">
        <span className="text-sm font-medium text-[var(--ios-text)]">{labels.common.amount}</span>
        <input
          autoFocus
          className="ios-field w-full"
          inputMode="decimal"
          name="amount"
          placeholder="0.00"
          required
          type="text"
        />
      </label>

      <CategoryPicker
        categories={categories}
        label={labels.common.category}
        locale={locale}
        onSelect={setSelectedCategoryId}
        selectedCategoryId={selectedCategoryId}
        selectedType={selectedType}
      />

      <label className="space-y-2">
        <span className="text-sm font-medium text-[var(--ios-text)]">{labels.common.who}</span>
        <IosSelect
          defaultValue={currentMemberId}
          name="actorMemberId"
          options={householdMembers.map((member) => ({
            value: member.id,
            label: member.memberName,
          }))}
          required
        />
      </label>

      <label className="space-y-2">
        <span className="text-sm font-medium text-[var(--ios-text)]">{labels.common.when}</span>
        <input
          className="ios-field w-full"
          defaultValue={occurredAtDefault}
          name="occurredAt"
          required
          type="datetime-local"
        />
      </label>

      <label className="space-y-2">
        <span className="text-sm font-medium text-[var(--ios-text)]">{labels.common.note}</span>
        <textarea
          className="ios-field min-h-24 w-full"
          name="note"
          placeholder={labels.common.optional}
        />
      </label>

      {successMessage && state.status === "idle" ? (
        <SuccessToast
          detail={successDetail}
          key={`${successMessage}-${successDetail ?? ""}`}
          message={successMessage}
        />
      ) : null}
      {state.status === "error" ? <p className="text-sm text-rose-700">{state.message}</p> : null}

      <button
        className="w-full rounded-2xl bg-[var(--ios-blue)] px-4 py-3 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(0,122,255,0.22)] transition hover:bg-[#006ee6] disabled:cursor-not-allowed disabled:bg-[#9ecbff] disabled:shadow-none"
        disabled={isPending}
        type="submit"
      >
        {isPending ? labels.common.saving : labels.add.save}
      </button>
    </form>
  );
}
