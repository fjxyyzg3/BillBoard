"use client";

import { useAppFilters } from "@/components/app-filters-provider";
import type { RangePreset } from "@/lib/time-range";

const options: Array<{ value: RangePreset; label: string }> = [
  { value: "this-month", label: "This Month" },
  { value: "last-7-days", label: "Last 7 Days" },
  { value: "last-30-days", label: "Last 30 Days" },
  { value: "last-12-months", label: "Last 12 Months" },
];

export function TimeRangeSelector() {
  const { rangePreset, setRangePreset } = useAppFilters();

  return (
    <label className="flex items-center gap-2 text-sm text-stone-600">
      <span>Range</span>
      <select
        className="rounded-2xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900"
        onChange={(event) => {
          setRangePreset(event.target.value as RangePreset);
        }}
        value={rangePreset}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </label>
  );
}
