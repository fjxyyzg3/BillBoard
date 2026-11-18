import Link from "next/link";
import type { ReactNode } from "react";
import { getMessages, type Locale } from "@/lib/i18n";
import type { AnalyticsComparison } from "@/lib/reports/analytics-types";

export type ReportPeriodLinks = { all: string; expense: string; income: string };

export type ReportAnalyticsLinks = {
  current: ReportPeriodLinks;
  previous: ReportPeriodLinks | null;
  yearOverYear: ReportPeriodLinks | null;
  distribution: Record<string, string>;
  maximumExpense: string | null;
  annual: string | null;
};

export function analysisMoney(fen: number, locale: Locale) {
  return new Intl.NumberFormat(locale, { style: "currency", currency: "CNY" }).format(fen / 100);
}

export function analysisDelta(fen: number, locale: Locale) {
  return `${fen > 0 ? "+" : ""}${analysisMoney(fen, locale)}`;
}

export function analysisPercent(ratio: number, locale: Locale) {
  return new Intl.NumberFormat(locale, { style: "percent", maximumFractionDigits: 1 }).format(ratio);
}

export function analysisDate(value: string, locale: Locale) {
  return new Intl.DateTimeFormat(locale, { timeZone: "Asia/Shanghai", year: "numeric", month: "short", day: "numeric" })
    .format(new Date(`${value}T00:00:00+08:00`));
}

export function analysisRecordHref(href: string, extras: Record<string, string>) {
  const [pathname, query = ""] = href.split("?");
  const params = new URLSearchParams(query);
  for (const [key, value] of Object.entries(extras)) params.set(key, value);
  params.delete("page");
  return `${pathname}?${params.toString()}`;
}

export function analysisDateFilters(from: string, to = from) {
  return {
    from: new Date(`${from}T00:00:00+08:00`).toISOString(),
    to: new Date(`${to}T23:59:59.999+08:00`).toISOString(),
  };
}

export function AnalysisValue({ href, children, className = "" }: { href?: string | null; children: ReactNode; className?: string }) {
  return href ? (
    <Link className={`bb-tap rounded-md underline decoration-[var(--bb-line-strong)] underline-offset-4 hover:text-[var(--bb-primary)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--bb-primary)] ${className}`} href={href}>
      {children}
    </Link>
  ) : <span className={className}>{children}</span>;
}

export function AnalysisAvailability({ comparison, locale }: { comparison: AnalyticsComparison; locale: Locale }) {
  const labels = getMessages(locale).home.analytics;
  const text = comparison.availability === "available" ? null
    : comparison.availability === "partial" ? labels.partialBaseline
      : comparison.availability === "missing" ? labels.noBaseline : labels.noComparison;
  return text ? <p className="rounded-xl bg-[var(--bb-warm-surface)] px-3 py-2 text-sm leading-6 text-[var(--bb-muted)]">{text}</p> : null;
}
