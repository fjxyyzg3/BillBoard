import type { RangePreset } from "@/lib/time-range";

export function parseRangePreset(value: string | null): RangePreset {
  if (value === "this-month") {
    return value;
  }

  if (
    value === "last-7-days" ||
    value === "last-30-days" ||
    value === "last-12-months"
  ) {
    return value;
  }

  return "this-month";
}
