"use client";

import { CircleEllipsis } from "lucide-react";
import { motion, useReducedMotion } from "motion/react";
import { useEffect, useMemo, useState } from "react";
import { CategoryIconBadge } from "@/components/category-icon-badge";
import styles from "./finance-b2.module.css";
import { getCategoryDisplayName, type Locale, type Messages } from "@/lib/i18n";
import {
  getCollapsedCategoryIds,
  type PreferenceCategory,
} from "@/lib/transactions/category-preferences";

type TransactionCategory = PreferenceCategory;

type CategoryPickerProps = {
  categories: TransactionCategory[];
  label: Messages["common"]["category"];
  labels: Pick<Messages["common"], "collapse" | "more">;
  locale: Locale;
  selectedType: TransactionCategory["type"];
  selectedCategoryId: string;
  onSelect: (categoryId: string) => void;
};

const collapsedLimit = 7;

export type { TransactionCategory };

export function CategoryPicker({
  categories,
  label,
  labels,
  locale,
  selectedType,
  selectedCategoryId,
  onSelect,
}: CategoryPickerProps) {
  const [isExpanded, setIsExpanded] = useState(false);
  const reduceMotion = useReducedMotion();

  const availableCategories = useMemo(
    () => categories.filter((category) => category.type === selectedType),
    [categories, selectedType],
  );
  const visibleCategoryIds = isExpanded
    ? availableCategories.map((category) => category.id)
    : getCollapsedCategoryIds(availableCategories, selectedCategoryId, collapsedLimit);
  const visibleCategoryIdSet = new Set(visibleCategoryIds);
  const visibleCategories = availableCategories.filter((category) => visibleCategoryIdSet.has(category.id));
  const canToggle = availableCategories.length > collapsedLimit;

  useEffect(() => {
    // This is required to collapse type-specific category choices after switching type.
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setIsExpanded(false);
  }, [selectedType]);

  return (
    <fieldset className="min-w-0 space-y-2">
      <legend className="mb-2 text-sm font-medium text-[var(--bb-ink)]">{label}</legend>
      <motion.div layout className={styles.categoryGrid} transition={{ duration: reduceMotion ? 0 : 0.2 }}>
        {visibleCategories.map((category) => (
          <motion.label
            layout="position"
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
            className={`${styles.categoryTile} bb-tap category-picker__chip relative flex min-w-0 cursor-pointer flex-col items-center justify-center gap-1.5 border px-1.5 py-2 has-[:focus-visible]:outline-2 has-[:focus-visible]:outline-offset-2 has-[:focus-visible]:outline-[var(--bb-primary)] ${
              selectedCategoryId === category.id
                ? "border-[var(--bb-accent)]/35 bg-[var(--bb-accent-soft)] text-[var(--bb-accent-ink)]"
                : "border-[var(--bb-warm-line)] bg-white/80 text-[var(--bb-ink)] hover:border-[var(--bb-accent)] hover:bg-white"
            }`}
            key={category.id}
          >
            <input
              checked={selectedCategoryId === category.id}
              className="absolute inset-0 h-full w-full cursor-pointer opacity-0 disabled:cursor-not-allowed"
              name="categoryId"
              onChange={() => onSelect(category.id)}
              required
              type="radio"
              value={category.id}
            />
            <CategoryIconBadge
              categoryName={category.name}
              className="h-6 w-6 bg-transparent"
              iconClassName="h-5 w-5 [stroke-width:1.6]"
            />
            <span className="min-w-0 leading-tight [overflow-wrap:anywhere]">{getCategoryDisplayName(category.name, locale)}</span>
          </motion.label>
        ))}
        {canToggle ? (
          <motion.button
            layout="position"
            transition={{ duration: reduceMotion ? 0 : 0.2 }}
            aria-expanded={isExpanded}
            className={`${styles.categoryTile} bb-tap category-picker__chip flex min-w-0 flex-col items-center justify-center gap-1.5 border border-[var(--bb-warm-line)] px-1.5 py-2 text-[var(--bb-muted)] hover:bg-[var(--bb-warm-surface)]`}
            onClick={() => setIsExpanded((current) => !current)}
            type="button"
          >
            <span
              aria-hidden="true"
              className="inline-flex h-6 w-6 shrink-0 items-center justify-center text-[var(--bb-muted)]"
            >
              <CircleEllipsis className="h-5 w-5" strokeWidth={1.6} />
            </span>
            <span className="min-w-0 truncate">{isExpanded ? labels.collapse : labels.more}</span>
          </motion.button>
        ) : null}
      </motion.div>
    </fieldset>
  );
}
