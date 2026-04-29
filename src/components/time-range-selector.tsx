"use client";

import { useAppFilters } from "@/components/app-filters-provider";
import { IosSelect } from "@/components/ios-select";
import type { Messages } from "@/lib/i18n";
import type { RangePreset } from "@/lib/time-range";

type TimeRangeSelectorProps = {
  labels: Messages["range"];
};

export function TimeRangeSelector({ labels }: TimeRangeSelectorProps) {
  const { rangePreset, setRangePreset } = useAppFilters();
  const options: Array<{ value: RangePreset; label: string }> = [
    { value: "this-month", label: labels.thisMonth },
    { value: "last-7-days", label: labels.last7Days },
    { value: "last-30-days", label: labels.last30Days },
    { value: "last-12-months", label: labels.last12Months },
  ];

  return (
    <label className="flex min-w-0 items-center gap-2 text-sm text-[var(--ios-muted)]">
      <span className="shrink-0 font-medium">{labels.label}</span>
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
