import Link from "next/link";

type SummaryCardProps = {
  detail: string;
  href?: string;
  title: string;
  tone?: "income" | "expense" | "neutral";
  value: string;
};

const toneClasses = {
  expense: "text-stone-900",
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
      <div className="flex items-start justify-between gap-3">
        <div className="space-y-1">
          <p className="text-sm font-medium text-stone-600">{title}</p>
          <p className={`text-2xl font-semibold ${toneClasses[tone]}`}>{value}</p>
        </div>
        {href ? <span className="text-sm text-stone-400">View</span> : null}
      </div>
      <p className="text-sm text-stone-500">{detail}</p>
    </>
  );

  if (!href) {
    return (
      <article className="space-y-4 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm">
        {content}
      </article>
    );
  }

  return (
    <Link
      className="space-y-4 rounded-2xl border border-stone-200 bg-white p-4 shadow-sm transition hover:border-stone-300 hover:shadow"
      href={href}
    >
      {content}
    </Link>
  );
}
