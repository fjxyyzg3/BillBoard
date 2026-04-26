import { TransactionForm } from "@/components/transaction-form";
import { requireAppSession } from "@/lib/auth/session";
import { db } from "@/lib/db";

type AddPageProps = {
  searchParams?: Promise<{
    created?: string;
  }>;
};

export default async function AddPage({ searchParams }: AddPageProps) {
  const user = await requireAppSession();
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
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
        successMessage={resolvedSearchParams?.created === "1" ? "Transaction saved" : undefined}
      />
    </section>
  );
}
