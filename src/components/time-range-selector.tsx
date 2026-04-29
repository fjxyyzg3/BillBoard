"use client";

import { useAppFilters } from "@/components/app-filters-provider";
import { IosSelect } from "@/components/ios-select";
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
      <IosSelect
        onChange={(event) => {
          setRangePreset(event.target.value as RangePreset);
        }}
        options={options}
        value={rangePreset}
        variant="pill"
      />
    </label>
  );
}
