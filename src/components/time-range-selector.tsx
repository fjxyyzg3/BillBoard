"use client";

import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { RangePreset } from "@/lib/time-range";

const options: Array<{ value: RangePreset; label: string }> = [
  { value: "this-month", label: "This Month" },
  { value: "last-7-days", label: "Last 7 Days" },
  { value: "last-30-days", label: "Last 30 Days" },
  { value: "last-12-months", label: "Last 12 Months" },
];

function parseRangePreset(value: string | null): RangePreset {
  if (
    value === "last-7-days" ||
    value === "last-30-days" ||
    value === "last-12-months"
  ) {
    return value;
  }

  return "this-month";
}

export function TimeRangeSelector() {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const rangePreset = parseRangePreset(searchParams.get("range"));

  return (
    <label className="flex items-center gap-2 text-sm text-stone-600">
      <span>Range</span>
      <select
        className="rounded-2xl border border-stone-200 bg-white px-3 py-2 text-sm text-stone-900"
        onChange={(event) => {
          const params = new URLSearchParams(searchParams.toString());
          const nextRange = event.target.value;

          if (nextRange === "this-month") {
            params.delete("range");
          } else {
            params.set("range", nextRange);
          }

          const query = params.toString();
          router.replace(query ? `${pathname}?${query}` : pathname, { scroll: false });
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
