export type RecordSort = "amount-desc" | "amount-asc";

export function parseRecordSort(value: string | null | undefined): RecordSort | undefined {
  if (value === "amount-desc" || value === "amount-asc") {
    return value;
  }

  return undefined;
}
