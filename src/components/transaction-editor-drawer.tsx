"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  initialRecordEditorState,
  submitRecordDelete,
  submitRecordUpdate,
} from "@/app/(app)/records/actions";
import { IosSelect } from "@/components/ios-select";
import { getCategoryDisplayName, type Locale, type Messages } from "@/lib/i18n";
import { formatFen } from "@/lib/money";

type CategoryOption = {
  id: string;
  name: string;
  type: "income" | "expense";
};

type HouseholdMemberOption = {
  id: string;
  memberName: string;
};

type EditableRecord = {
  id: string;
  amountFen: number;
  actorMemberId: string;
  categoryId: string;
  createdByLabel: string;
  note: string | null;
  occurredAtLocal: string;
  type: "income" | "expense";
};

type TransactionEditorDrawerProps = {
  categories: CategoryOption[];
  closeHref: string;
  householdMembers: HouseholdMemberOption[];
  labels: {
    common: Messages["common"];
    editor: Pick<
      Messages["editor"],
      "deleteConfirm" | "deleteRecord" | "deleting" | "saveChanges" | "title"
    >;
  };
  locale: Locale;
  record: EditableRecord;
  returnTo: string;
};

function getFirstCategoryId(
  categories: CategoryOption[],
  type: CategoryOption["type"],
  preferredCategoryId: string,
) {
  const preferredCategory = categories.find(
    (category) => category.id === preferredCategoryId && category.type === type,
  );

  if (preferredCategory) {
    return preferredCategory.id;
  }

  return categories.find((category) => category.type === type)?.id ?? "";
}

export function TransactionEditorDrawer({
  categories,
  closeHref,
  householdMembers,
  labels,
  locale,
  record,
  returnTo,
}: TransactionEditorDrawerProps) {
  const [selectedType, setSelectedType] = useState<CategoryOption["type"]>(record.type);
  const [selectedCategoryId, setSelectedCategoryId] = useState(
    getFirstCategoryId(categories, record.type, record.categoryId),
  );
  const [updateState, updateAction, isUpdating] = useActionState(
    submitRecordUpdate,
    initialRecordEditorState,
  );
  const [deleteState, deleteAction, isDeleting] = useActionState(
    submitRecordDelete,
    initialRecordEditorState,
  );
  const visibleCategories = categories.filter((category) => category.type === selectedType);
  const categoryOptions = visibleCategories.map((category) => ({
    value: category.id,
    label: getCategoryDisplayName(category.name, locale),
  }));
  const householdMemberOptions = householdMembers.map((member) => ({
    value: member.id,
    label: member.memberName,
  }));
  const message = updateState.status === "error" ? updateState.message : deleteState.message;

  function handleTypeChange(type: CategoryOption["type"]) {
    setSelectedType(type);
    setSelectedCategoryId(getFirstCategoryId(categories, type, selectedCategoryId));
  }

  return (
    <div className="fixed inset-0 z-40">
      <Link aria-label={labels.common.close} className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" href={closeHref} />
      <aside className="absolute inset-x-0 bottom-0 z-10 flex max-h-[92vh] flex-col overflow-y-auto rounded-t-[1.75rem] bg-white p-5 shadow-2xl md:inset-y-4 md:left-auto md:right-4 md:w-full md:max-w-md md:rounded-[1.75rem] md:p-6">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold text-[var(--ios-text)]">{labels.editor.title}</h2>
            <p className="text-sm text-[var(--ios-muted)]">
              {record.createdByLabel}
            </p>
          </div>
          <Link
            className="rounded-full bg-[#f2f2f7] px-3 py-1 text-sm font-medium text-[var(--ios-blue)] transition hover:bg-[#e8e8ed]"
            href={closeHref}
          >
            {labels.common.close}
          </Link>
        </div>

        <form action={updateAction} className="mt-6 space-y-4">
          <input name="locale" type="hidden" value={locale} />
          <input name="transactionId" type="hidden" value={record.id} />
          <input name="returnTo" type="hidden" value={returnTo} />

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
              className="ios-field w-full"
              defaultValue={formatFen(record.amountFen)}
              inputMode="decimal"
              name="amount"
              required
              type="text"
            />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium text-[var(--ios-text)]">
              {labels.common.category}
            </span>
            <IosSelect
              name="categoryId"
              onChange={(event) => {
                setSelectedCategoryId(event.target.value);
              }}
              options={categoryOptions}
              required
              value={selectedCategoryId}
            />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium text-[var(--ios-text)]">{labels.common.who}</span>
            <IosSelect
              defaultValue={record.actorMemberId}
              name="actorMemberId"
              options={householdMemberOptions}
              required
            />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium text-[var(--ios-text)]">{labels.common.when}</span>
            <input
              className="ios-field w-full"
              defaultValue={record.occurredAtLocal}
              name="occurredAt"
              required
              type="datetime-local"
            />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium text-[var(--ios-text)]">{labels.common.note}</span>
            <textarea
              className="ios-field min-h-28 w-full"
              defaultValue={record.note ?? ""}
              name="note"
              placeholder={labels.common.optional}
            />
          </label>

          {message ? <p className="text-sm text-rose-700">{message}</p> : null}

          <div className="space-y-3 border-t border-stone-200 pt-4">
            <button
              className="w-full rounded-2xl bg-[var(--ios-blue)] px-4 py-3 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(0,122,255,0.22)] transition hover:bg-[#006ee6] disabled:cursor-not-allowed disabled:bg-[#9ecbff] disabled:shadow-none"
              disabled={isUpdating || isDeleting}
              type="submit"
            >
              {isUpdating ? labels.common.saving : labels.editor.saveChanges}
            </button>
          </div>
        </form>

        <form
          action={deleteAction}
          className="mt-4 border-t border-stone-200 pt-4"
          onSubmit={(event) => {
            if (!window.confirm(labels.editor.deleteConfirm)) {
              event.preventDefault();
            }
          }}
        >
          <input name="locale" type="hidden" value={locale} />
          <input name="transactionId" type="hidden" value={record.id} />
          <input name="returnTo" type="hidden" value={returnTo} />
          <button
            className="w-full rounded-2xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-semibold text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isUpdating || isDeleting}
            type="submit"
          >
            {isDeleting ? labels.editor.deleting : labels.editor.deleteRecord}
          </button>
        </form>
      </aside>
    </div>
  );
}
