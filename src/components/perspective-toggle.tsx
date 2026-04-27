"use client";

import { useAppFilters } from "@/components/app-filters-provider";
import type { Perspective } from "@/lib/perspective";

const items: Array<{ value: Perspective; label: string }> = [
  { value: "household", label: "Household" },
  { value: "me", label: "Me" },
  { value: "spouse", label: "Spouse" },
];

export function PerspectiveToggle() {
  const { perspective, setPerspective } = useAppFilters();

  return (
    <div className="inline-grid max-w-full grid-cols-3 rounded-full bg-[#e8e8ed] p-1 text-sm text-[var(--ios-muted)]">
      {items.map((item) => {
        const isActive = perspective === item.value;

        return (
          <button
            aria-pressed={isActive}
            className={`min-h-10 rounded-full px-4 text-center font-medium transition ${
              isActive
                ? "bg-white text-[var(--ios-text)] shadow-[0_1px_4px_rgba(0,0,0,0.14)]"
                : "hover:text-[var(--ios-text)]"
            }`}
            key={item.value}
            onClick={() => {
              setPerspective(item.value);
            }}
            type="button"
          >
            {item.label}
          </button>
        );
      })}
    </div>
  );
}
