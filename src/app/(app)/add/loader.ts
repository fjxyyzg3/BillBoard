import { requireAppSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { getServerLocale } from "@/lib/i18n-server";
import { resolveLedgerPageContext } from "@/lib/ledgers/server";
import { recordAppEvent } from "@/lib/ops/record-event";
import {
  getDefaultCategoryIds,
  orderCategoriesByUsage,
  type PreferenceCategory,
} from "@/lib/transactions/category-preferences";
import { queryRecentCategoryUsage } from "@/lib/transactions/query-category-preferences";
import { AppEventType } from "@prisma/client";

type AddPageProps = {
  searchParams?: Promise<{
    mode?: string;
    month?: string;
    year?: string;
    start?: string;
    end?: string;
    ledger?: string;
    entryLedger?: string;
  }>;
};

export async function loadAddPage({ searchParams }: AddPageProps) {
  const user = await requireAppSession();
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const view = await resolveLedgerPageContext(user, resolvedSearchParams);
  const context = view.context;
  const now = new Date();
  const [locale, categories, householdMembers, categoryUsageStats] =
    await Promise.all([
      getServerLocale(),
      db.category.findMany({
        where: { isActive: true },
        orderBy: [{ type: "asc" }, { sortOrder: "asc" }, { name: "asc" }],
        select: { id: true, name: true, type: true },
      }),
      db.householdMember.findMany({
        where: { householdId: user.householdId, leftAt: null, user: { status: "ACTIVE" } },
        orderBy: [{ joinedAt: "asc" }, { memberName: "asc" }],
        select: { id: true, memberName: true },
      }),
      queryRecentCategoryUsage({
        householdId: user.householdId,
        memberId: user.memberId,
        ledgerId: context.ledgerId,
        now,
      }),
      recordAppEvent({
        eventType: AppEventType.PAGE_VIEW,
        householdId: user.householdId,
        memberId: user.memberId,
        path: "/add",
        summary: "访问 记一笔",
      }).catch(() => undefined),
    ]);
  const categoryOptions: PreferenceCategory[] = categories.map((category) => ({
    id: category.id,
    name: category.name,
    type: category.type === "INCOME" ? "income" : "expense",
  }));
  const orderedCategories = orderCategoriesByUsage(categoryOptions, categoryUsageStats);
  return { locale, form: { categories: orderedCategories, currentMemberId: user.memberId, context: { householdId: context.householdId, memberId: context.memberId, ledgerId: context.ledgerId }, legacyDefaultLedgerId: view.legacyDefaultLedgerId, defaultCategoryIds: getDefaultCategoryIds(orderedCategories), householdMembers } };
}
