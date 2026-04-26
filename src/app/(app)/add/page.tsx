import { buildAppHref } from "@/lib/app-navigation";
import { TransactionForm } from "@/components/transaction-form";
import { requireAppSession } from "@/lib/auth/session";
import { db } from "@/lib/db";

function formatSuccessAmount(amountFen: number) {
  return new Intl.NumberFormat("en-US", {
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

  return `${searchParams.type === "expense" ? "Expense" : "Income"}: ${formatSuccessAmount(amountFen)}`;
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
      <header className="space-y-2">
        <h1 className="text-2xl font-semibold">Add transaction</h1>
        <p className="text-sm text-stone-500">
          Capture household income and expenses without leaving the app shell.
        </p>
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
        nextAddHref={buildAppHref("/add", sharedParamReader)}
        sharedFilters={sharedParams}
        successDetail={readSuccessDetail(resolvedSearchParams)}
        successMessage={resolvedSearchParams?.created === "1" ? "Transaction saved" : undefined}
      />
    </section>
  );
}
