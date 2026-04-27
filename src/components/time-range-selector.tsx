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
    <label className="flex min-w-0 items-center gap-2 text-sm text-[var(--ios-muted)]">
      <span className="shrink-0 font-medium">Range</span>
      <select
        className="ios-field min-h-10 rounded-full py-2 pr-9"
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
