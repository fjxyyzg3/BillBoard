/* eslint-disable @next/next/no-img-element */
import Link from "next/link";
import summaryExpenseArt from "@/assets/art/summary-expense.webp";
import summaryIncomeArt from "@/assets/art/summary-income.webp";
import summaryNetArt from "@/assets/art/summary-net.webp";
import summaryRecordsArt from "@/assets/art/summary-records.webp";
import { CountUp } from "@/components/motion-primitives";
import type { Locale } from "@/lib/i18n";

type SummaryCardCountUp = {
  locale: Locale;
  value: number;
  variant: "fen" | "integer";
};

type SummaryCardProps = {
  /** Optional legacy count-up for standalone summaries. */
  countUp?: SummaryCardCountUp;
  featured?: boolean;
  joined?: boolean;
  fullWidth?: boolean;
  href?: string;
  title: string;
  tone?: "income" | "expense" | "neutral" | "deficit";
  value: string;
  visual?: "expense" | "income" | "net" | "records";
  viewLabel?: string;
};

const toneClasses = {
  expense: "text-[var(--bb-ink)]",
  income: "text-[var(--bb-income)]",
  neutral: "text-[var(--bb-ink)]",
  deficit: "text-[var(--bb-danger)]",
} as const;

const visualMap: Record<
  NonNullable<SummaryCardProps["visual"]>,
  { src: string | { src: string } }
> = {
  expense: { src: summaryExpenseArt },
  income: { src: summaryIncomeArt },
  net: { src: summaryNetArt },
  records: { src: summaryRecordsArt },
};

function getStaticAssetSrc(asset: string | { src: string }) {
  return typeof asset === "string" ? asset : asset.src;
}

export function SummaryCard({
  countUp,
  featured = false,
  joined = false,
  fullWidth = false,
  href,
  title,
  tone = "neutral",
  value,
  visual,
  viewLabel,
}: SummaryCardProps) {
  const visualConfig = visual ? visualMap[visual] : null;
  const content = (
    <>
      <div className="relative z-10 min-w-0">
        <div className="min-w-0 space-y-2">
          <p className={`${joined && featured ? "pr-24 " : visualConfig ? "pr-8 " : ""}text-xs text-[var(--bb-muted)]`}>{title}</p>
          {countUp ? (
            <CountUp
              className={`ios-amount block ${featured ? "text-[clamp(1.75rem,7vw,2.25rem)]" : "text-[clamp(1rem,4vw,1.375rem)]"} ${toneClasses[tone]}`}
              locale={countUp.locale}
              value={countUp.value}
              variant={countUp.variant}
            />
          ) : (
            <p
              className={`ios-amount bb-summary-value ${featured ? "bb-summary-value--featured" : ""} ${toneClasses[tone]}`}
              style={joined ? { fontSize: featured
                ? `clamp(1.375rem, calc((100vw - 3rem) / ${Math.max(9, value.length * 0.65 + 2)}), 2.125rem)`
                : fullWidth ? undefined : `clamp(0.875rem, calc((100vw - 6rem) / ${Math.max(14, value.length + 4)}), 1.125rem)`
              } : undefined}
            >
              {joined ? <span className="mr-1 text-[0.7em]">¥</span> : null}
              {value}
            </p>
          )}
        </div>
        {href && viewLabel ? <span className="sr-only">{viewLabel}</span> : null}
      </div>
      {visualConfig ? (
        <img
          alt=""
          aria-hidden="true"
          className="pointer-events-none absolute right-3 top-3 h-7 w-7 object-contain opacity-80"
          decoding="async"
          height="1254"
          loading="lazy"
          src={getStaticAssetSrc(visualConfig.src)}
          width="1254"
        />
      ) : null}
    </>
  );

  if (!href) {
    return (
      <article className={`${joined ? "" : "ios-panel "}relative min-w-0 p-4 ${featured ? "col-span-2" : ""}`} data-testid="summary-card">
        {content}
      </article>
    );
  }

  return (
    <Link
      className={`${joined ? featured ? "border-b border-[var(--bb-warm-line)] " : tone === "income" ? fullWidth ? "border-b border-[var(--bb-warm-line)] sm:border-b-0 sm:border-r " : "border-r border-[var(--bb-warm-line)] " : "" : "ios-panel "}bb-tap relative block min-w-0 p-4 hover:bg-[var(--bb-warm-surface)] ${featured ? "col-span-2" : fullWidth ? "col-span-2 sm:col-span-1" : ""}`}
      data-testid="summary-card"
      href={href}
    >
      {content}
    </Link>
  );
}
