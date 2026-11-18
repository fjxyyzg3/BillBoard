"use client";

import { ChevronDown } from "lucide-react";
import { useId, useState, type ReactNode } from "react";

type CategoryListExpanderProps = {
  rows: ReactNode[];
  showAllLabel: string;
  showLessLabel: string;
};

export function CategoryListExpander({
  rows,
  showAllLabel,
  showLessLabel,
}: CategoryListExpanderProps) {
  const [expanded, setExpanded] = useState(false);
  const extraRowsId = useId();
  const extraRows = rows.slice(3);

  return (
    <div className="min-w-0">
      <div className="space-y-1">{rows.slice(0, 3)}</div>
      {extraRows.length ? (
        <>
          <div
            data-testid="category-extra-rows"
            aria-hidden={!expanded}
            className="grid transition-[grid-template-rows,opacity] duration-[180ms] ease-[cubic-bezier(0.22,1,0.36,1)] motion-reduce:transition-none"
            id={extraRowsId}
            inert={!expanded}
            style={{ gridTemplateRows: expanded ? "1fr" : "0fr", opacity: expanded ? 1 : 0 }}
          >
            <div className="min-h-0 overflow-hidden">
              <div className="space-y-1">{extraRows}</div>
            </div>
          </div>
          <button
            aria-controls={extraRowsId}
            aria-expanded={expanded}
            className="mt-1 flex min-h-11 w-full items-center justify-center gap-1.5 rounded-xl border-t border-[var(--bb-warm-line)] text-sm font-medium text-[var(--bb-muted)] transition-colors hover:bg-[var(--bb-warm-surface)] hover:text-[var(--bb-accent-ink)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bb-primary)]"
            onClick={() => setExpanded(!expanded)}
            type="button"
          >
            {expanded ? showLessLabel : showAllLabel}
            <ChevronDown
              aria-hidden="true"
              className={`h-4 w-4 transition-transform duration-[180ms] motion-reduce:transition-none ${expanded ? "rotate-180" : ""}`}
            />
          </button>
        </>
      ) : null}
    </div>
  );
}
