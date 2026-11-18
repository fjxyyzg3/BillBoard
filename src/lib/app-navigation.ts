import { buildSharedReportParams } from "@/lib/reports/report-range";

type SearchParamReader = Pick<URLSearchParams, "get">;

export function buildAppHref(pathname: string, searchParams: SearchParamReader) {
  const mode = searchParams.get("mode");
  const params = buildSharedReportParams({
    mode: mode === "month" || mode === "year" || mode === "all" || mode === "recent" || mode === "custom" ? mode : undefined,
    month: searchParams.get("month") ?? undefined,
    year: searchParams.get("year") ?? undefined,
    start: searchParams.get("start") ?? undefined,
    end: searchParams.get("end") ?? undefined,
  });

  for (const key of ["ledger", "entryLedger", "member"]) {
    if (pathname === "/ledgers" && key === "entryLedger") continue;
    const value = searchParams.get(key);
    if (value) params.set(key, value);
  }
  const query = params.toString();

  return query ? `${pathname}?${query}` : pathname;
}
