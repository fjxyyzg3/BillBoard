"use client";

import { useState, type ComponentProps } from "react";
import { NaturalLanguageForm } from "@/components/natural-language-form";
import { TransactionForm } from "@/components/transaction-form";
import { getMessages } from "@/lib/i18n";
import styles from "./finance-b2.module.css";

export function AccountingInput(props: ComponentProps<typeof TransactionForm>) {
  const [mode, setMode] = useState<"manual" | "natural">("manual");
  const [isFrozen, setIsFrozen] = useState(true);
  const labels = getMessages(props.locale).add;

  return (
    <div className="space-y-4">
      <div
        aria-label={labels.inputMode}
        className={`${styles.inputModes} bb-segmented grid grid-cols-2 rounded-xl p-1 text-sm`}
        role="group"
      >
        {(["manual", "natural"] as const).map((value) => (
          <button
            aria-pressed={mode === value}
            className={`bb-tap min-h-11 rounded-lg px-3 py-2 font-medium disabled:cursor-not-allowed ${mode === value ? "text-[var(--bb-accent-ink)]" : "text-[var(--bb-muted)] hover:text-[var(--bb-ink)]"}`}
            disabled={isFrozen}
            key={value}
            onClick={() => setMode(value)}
            type="button"
          >
            {value === "manual" ? labels.manualMode : labels.naturalMode}
          </button>
        ))}
      </div>
      <div hidden={mode !== "manual"}>
        <TransactionForm {...props} />
      </div>
      <div hidden={mode !== "natural"}>
        <NaturalLanguageForm
          key={props.currentMemberId}
          locale={props.locale}
          onFrozenChange={setIsFrozen}
        />
      </div>
    </div>
  );
}
