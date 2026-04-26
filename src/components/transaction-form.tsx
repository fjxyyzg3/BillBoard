"use client";

import Link from "next/link";
import { useActionState, useState } from "react";
import {
  submitTransaction,
  type CreateTransactionActionState,
} from "@/app/(app)/add/actions";
import {
  CategoryPicker,
  type TransactionCategory,
} from "@/components/category-picker";
import { getCurrentShanghaiDateTimeLocal } from "@/lib/transactions/datetime";

type HouseholdMemberOption = {
  id: string;
  memberName: string;
};

type TransactionFormProps = {
  categories: TransactionCategory[];
  householdMembers: HouseholdMemberOption[];
  currentMemberId: string;
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

export function TransactionForm({
  categories,
  householdMembers,
  currentMemberId,
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
    <form action={formAction} className="space-y-4 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
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
          autoFocus
          className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-stone-500"
          inputMode="decimal"
          name="amount"
          placeholder="0.00"
          required
          type="text"
        />
      </label>

      <CategoryPicker
        categories={categories}
        onSelect={setSelectedCategoryId}
        selectedCategoryId={selectedCategoryId}
        selectedType={selectedType}
      />

      <label className="space-y-2">
        <span className="text-sm font-medium text-stone-700">Who</span>
        <select
          className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-stone-500"
          defaultValue={currentMemberId}
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
          className="w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-stone-500"
          defaultValue={occurredAtDefault}
          name="occurredAt"
          required
          type="datetime-local"
        />
      </label>

      <label className="space-y-2">
        <span className="text-sm font-medium text-stone-700">Note</span>
        <textarea
          className="min-h-24 w-full rounded-xl border border-stone-300 bg-white px-3 py-2 text-sm text-stone-900 outline-none transition focus:border-stone-500"
          name="note"
          placeholder="Optional"
        />
      </label>

      {successMessage && state.status === "idle" ? (
        <div className="space-y-3 rounded-xl border border-emerald-200 bg-emerald-50 p-3">
          <div className="space-y-1">
            <p className="text-sm text-emerald-700">{successMessage}</p>
            {successDetail ? <p className="text-sm text-emerald-700">{successDetail}</p> : null}
          </div>
          <div className="grid grid-cols-1 gap-2 sm:grid-cols-2">
            <Link
              className="rounded-xl border border-stone-300 bg-white px-4 py-3 text-center text-sm font-medium text-stone-700 transition hover:border-stone-500 hover:text-stone-900"
              href="/add"
            >
              Add another
            </Link>
            <Link
              className="rounded-xl bg-stone-900 px-4 py-3 text-center text-sm font-medium text-white transition hover:bg-stone-700"
              href="/home"
            >
              Return home
            </Link>
          </div>
        </div>
      ) : null}
      {state.status === "error" ? <p className="text-sm text-rose-700">{state.message}</p> : null}

      <button
        className="w-full rounded-xl bg-stone-900 px-4 py-3 text-sm font-medium text-white transition hover:bg-stone-700 disabled:cursor-not-allowed disabled:bg-stone-400"
        disabled={isPending}
        type="submit"
      >
        {isPending ? "Saving..." : "Save transaction"}
      </button>
    </form>
  );
}
