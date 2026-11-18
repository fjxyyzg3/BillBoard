import type { EntryContext } from "./entry-context";

export function buildEntryRecordsHref(context?: Pick<EntryContext, "ledgerId">) {
  // Result links must show the original target independently of current filters.
  // Omit entryLedger so archived results remain readable without a writable target.
  const params = new URLSearchParams({ mode: "all", ledger: context?.ledgerId ?? "all" });
  return `/records?${params}`;
}
