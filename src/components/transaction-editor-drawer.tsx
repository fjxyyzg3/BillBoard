"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  initialRecordEditorState,
  submitRecordDelete,
  submitRecordUpdate,
} from "@/app/(app)/records/actions";
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
  createdByMemberName: string;
  note: string | null;
  occurredAtLocal: string;
  occurredAtLabel: string;
  type: "income" | "expense";
};

type TransactionEditorDrawerProps = {
  categories: CategoryOption[];
  closeHref: string;
  householdMembers: HouseholdMemberOption[];
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
  const message = updateState.status === "error" ? updateState.message : deleteState.message;

  function handleTypeChange(type: CategoryOption["type"]) {
    setSelectedType(type);
    setSelectedCategoryId(getFirstCategoryId(categories, type, selectedCategoryId));
  }

  return (
    <div className="fixed inset-0 z-40">
      <Link aria-label="Close editor" className="absolute inset-0 bg-stone-950/30" href={closeHref} />
      <aside className="absolute inset-y-0 right-0 z-10 flex w-full max-w-md flex-col overflow-y-auto bg-white p-6 shadow-2xl">
        <div className="flex items-start justify-between gap-4">
          <div className="space-y-1">
            <h2 className="text-xl font-semibold text-stone-900">Edit record</h2>
            <p className="text-sm text-stone-500">
              {record.occurredAtLabel} • created by {record.createdByMemberName}
            </p>
          </div>
          <Link
            className="rounded-full border border-stone-200 px-3 py-1 text-sm text-stone-600 transition hover:border-stone-400 hover:text-stone-900"
            href={closeHref}
          >
            Close
          </Link>
        </div>

        <form action={updateAction} className="mt-6 space-y-4">
          <input name="transactionId" type="hidden" value={record.id} />
          <input name="returnTo" type="hidden" value={returnTo} />

          <div className="space-y-2">
            <span className="text-sm font-medium text-stone-700">Type</span>
            <div className="grid grid-cols-2 rounded-xl border border-stone-300 bg-stone-50 p-1">
              {(["expense", "income"] as const).map((type) => {
                const isActive = selectedType === type;

                return (
                  <label
                    className={`cursor-pointer rounded-lg px-3 py-2 text-center text-sm font-medium transition ${
                      isActive ? "bg-stone-900 text-white" : "text-stone-600"
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
                    {type === "expense" ? "Expense" : "Income"}
                  </label>
                );
              })}
            </div>
          </div>

          <label className="space-y-2">
            <span className="text-sm font-medium text-stone-700">Amount</span>
            <input
              className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
              defaultValue={formatFen(record.amountFen)}
              inputMode="decimal"
              name="amount"
              required
              type="text"
            />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium text-stone-700">Category</span>
            <select
              className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
              name="categoryId"
              onChange={(event) => {
                setSelectedCategoryId(event.target.value);
              }}
              required
              value={selectedCategoryId}
            >
              {visibleCategories.map((category) => (
                <option key={category.id} value={category.id}>
                  {category.name}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium text-stone-700">Who</span>
            <select
              className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
              defaultValue={record.actorMemberId}
              name="actorMemberId"
              required
            >
              {householdMembers.map((member) => (
                <option key={member.id} value={member.id}>
                  {member.memberName}
                </option>
              ))}
            </select>
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium text-stone-700">When</span>
            <input
              className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
              defaultValue={record.occurredAtLocal}
              name="occurredAt"
              required
              type="datetime-local"
            />
          </label>

          <label className="space-y-2">
            <span className="text-sm font-medium text-stone-700">Note</span>
            <textarea
              className="min-h-28 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900"
              defaultValue={record.note ?? ""}
              name="note"
              placeholder="Optional"
            />
          </label>

          {message ? <p className="text-sm text-rose-700">{message}</p> : null}

          <div className="space-y-3 border-t border-stone-200 pt-4">
            <button
              className="w-full rounded-xl bg-stone-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-400"
              disabled={isUpdating || isDeleting}
              type="submit"
            >
              {isUpdating ? "Saving..." : "Save changes"}
            </button>
          </div>
        </form>

        <form
          action={deleteAction}
          className="mt-4 border-t border-stone-200 pt-4"
          onSubmit={(event) => {
            if (!window.confirm("Delete this record?")) {
              event.preventDefault();
            }
          }}
        >
          <input name="transactionId" type="hidden" value={record.id} />
          <input name="returnTo" type="hidden" value={returnTo} />
          <button
            className="w-full rounded-xl border border-rose-200 bg-rose-50 px-4 py-3 text-sm font-medium text-rose-700 transition hover:border-rose-300 hover:bg-rose-100 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={isUpdating || isDeleting}
            type="submit"
          >
            {isDeleting ? "Deleting..." : "Delete record"}
          </button>
        </form>
      </aside>
    </div>
  );
}
