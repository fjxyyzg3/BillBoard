import { buildAppHref } from "@/lib/app-navigation";
import { TransactionForm } from "@/components/transaction-form";
import { requireAppSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getMessages, type Locale, type Messages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";

function formatSuccessAmount(amountFen: number, locale: Locale) {
  return new Intl.NumberFormat(locale, {
    maximumFractionDigits: 2,
    minimumFractionDigits: 2,
  }).format(amountFen / 100);
}

function readSuccessDetail(
  searchParams:
    | {
        amountFen?: string;
        created?: string;
        type?: string;
      }
    | undefined,
  locale: Locale,
  messages: Messages,
) {
  if (searchParams?.created !== "1") {
    return undefined;
  }

  const amountFen = Number(searchParams.amountFen ?? "");

  if (!Number.isInteger(amountFen) || amountFen <= 0) {
    return undefined;
  }

  if (searchParams.type !== "expense" && searchParams.type !== "income") {
    return undefined;
  }

  const typeLabel = searchParams.type === "expense" ? messages.common.expense : messages.common.income;

  return messages.add.successDetail(typeLabel, formatSuccessAmount(amountFen, locale));
}

function buildSharedParams(
  searchParams:
    | {
        perspective?: string;
        range?: string;
      }
    | undefined,
) {
  return {
    perspective: searchParams?.perspective,
    range: searchParams?.range,
  };
}

type AddPageProps = {
  searchParams?: Promise<{
    amountFen?: string;
    created?: string;
    perspective?: string;
    range?: string;
    type?: string;
  }>;
};

export default async function AddPage({ searchParams }: AddPageProps) {
  const user = await requireAppSession();
  const locale = await getServerLocale();
  const messages = getMessages(locale);
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const sharedParams = buildSharedParams(resolvedSearchParams);
  const sharedParamReader = {
    get(key: string) {
      return key === "perspective" ? sharedParams.perspective ?? null : sharedParams.range ?? null;
    },
  };
  const [categories, householdMembers] = await Promise.all([
    db.category.findMany({
      where: { isActive: true },
      orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
      select: { id: true, name: true, type: true },
    }),
    db.householdMember.findMany({
      where: { householdId: user.householdId },
      orderBy: [{ joinedAt: "asc" }, { memberName: "asc" }],
      select: { id: true, memberName: true },
    }),
  ]);

  return (
    <section className="space-y-6">
      <header className="space-y-1">
        <p className="text-sm font-medium text-[var(--ios-muted)]">{messages.add.eyebrow}</p>
        <h1 className="text-3xl font-semibold tracking-normal text-[var(--ios-text)]">
          {messages.add.title}
        </h1>
        <p className="text-sm text-[var(--ios-muted)]">{messages.add.description}</p>
      </header>
      <TransactionForm
        categories={categories.map((category) => ({
          id: category.id,
          name: category.name,
          type: category.type === "INCOME" ? "income" : "expense",
        }))}
        currentMemberId={user.memberId}
        householdMembers={householdMembers}
        homeHref={buildAppHref("/home", sharedParamReader)}
        labels={{ add: { save: messages.add.save }, common: messages.common }}
        locale={locale}
        nextAddHref={buildAppHref("/add", sharedParamReader)}
        sharedFilters={sharedParams}
        successDetail={readSuccessDetail(resolvedSearchParams, locale, messages)}
        successMessage={resolvedSearchParams?.created === "1" ? messages.add.successMessage : undefined}
      />
    </section>
  );
}
