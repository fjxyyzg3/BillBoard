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
    <div className="inline-grid grid-cols-3 rounded-2xl bg-stone-100 p-1 text-sm">
      {items.map((item) => {
        const isActive = perspective === item.value;

        return (
          <button
            aria-pressed={isActive}
            className={`rounded-xl px-3 py-2 transition ${
              isActive ? "bg-white font-medium text-stone-900 shadow-sm" : "text-stone-500"
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
