import Link from "next/link";

type SummaryCardProps = {
  detail: string;
  href?: string;
  title: string;
  tone?: "income" | "expense" | "neutral";
  value: string;
};

const toneClasses = {
  expense: "text-[var(--ios-red)]",
  income: "text-emerald-700",
  neutral: "text-stone-900",
} as const;

export function SummaryCard({
  detail,
  href,
  title,
  tone = "neutral",
  value,
}: SummaryCardProps) {
  const content = (
    <>
      <div className="flex min-w-0 items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <p className="text-sm font-medium text-stone-600">{title}</p>
          <p className={`ios-amount text-[clamp(1.15rem,5vw,1.65rem)] ${toneClasses[tone]}`}>
            {value}
          </p>
        </div>
        {href ? <span className="shrink-0 text-sm text-stone-400">View</span> : null}
      </div>
      <p className="min-w-0 text-sm text-stone-500">{detail}</p>
    </>
  );

  if (!href) {
    return (
      <article className="ios-panel min-w-0 space-y-4 p-4" data-testid="summary-card">
        {content}
      </article>
    );
  }

  return (
    <Link
      className="ios-panel min-w-0 space-y-4 p-4 transition hover:bg-black/[0.03]"
      data-testid="summary-card"
      href={href}
    >
      {content}
    </Link>
  );
}
