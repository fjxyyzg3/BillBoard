import { notFound } from "next/navigation";
import { requireAppSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { financialSnapshotOptions, readFinancialTransactions } from "@/lib/encryption/financial-queries";
import { isEncryptedRequest } from "@/lib/encryption/request-context";
import { getServerLocale } from "@/lib/i18n-server";
import { resolveLedgerPageContext } from "@/lib/ledgers/server";
import { authorizeMemberReadScope, parseMemberFilter } from "@/lib/records/member-filter";
import { buildReportRangeOptions, clampReportRangeSelection, parseReportRangeSearchParams } from "@/lib/reports/report-range";

type PageProps = { searchParams?: Promise<Record<string, string | string[] | undefined>> };
const single = (value: string | string[] | undefined) => typeof value === "string" ? value : undefined;

export async function loadReconciliationPage({ searchParams }: PageProps) {
  const user = await requireAppSession();
  const params = searchParams ? await searchParams : {};
  const view = await resolveLedgerPageContext(user, params);
  const ledgerId = view.scope.kind === "ledger" ? view.scope.ledgerId : undefined;
  let actorMemberId: string | undefined;
  try {
    actorMemberId = parseMemberFilter(params.member);
    await authorizeMemberReadScope(db, user.householdId, actorMemberId);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") notFound();
    throw error;
  }
  const [locale, householdMembers, firstRecord] = await Promise.all([
    getServerLocale(),
    db.householdMember.findMany({
      where: { householdId: user.householdId }, orderBy: [{ joinedAt: "asc" }, { id: "asc" }],
      select: { id: true, memberName: true, leftAt: true, user: { select: { status: true } } },
    }),
    isEncryptedRequest() ? db.$transaction(async (tx) => {
      const rows = await readFinancialTransactions(tx, { householdId: user.householdId, ledgerId, ...(actorMemberId ? { actorMemberIds: [actorMemberId] } : {}) });
      const occurredAt = rows.reduce<Date | null>((first, row) => !first || row.occurredAt < first ? row.occurredAt : first, null);
      return occurredAt ? { occurredAt } : null;
    }, financialSnapshotOptions) : db.transaction.findFirst({
      where: { householdId: user.householdId, ...(ledgerId ? { ledgerId } : {}), ...(actorMemberId ? { actorMemberId } : {}), deletedAt: null },
      orderBy: { occurredAt: "asc" }, select: { occurredAt: true },
    }),
  ]);
  const now = new Date();
  const mode = single(params.mode);
  const rangeReset = (mode === undefined && single(params.rangeReset) === "1") || (mode !== undefined && mode !== "month" && mode !== "year");
  const parsed = parseReportRangeSearchParams(rangeReset ? {} : { mode, month: single(params.month), year: single(params.year) }, now);
  const rangeOptions = buildReportRangeOptions(firstRecord?.occurredAt ?? null, now, "Asia/Shanghai");
  const selectedRange = clampReportRangeSelection(parsed, rangeOptions);
  return { locale, householdMembers, ledgerId, actorMemberId, rangeOptions, selectedRange, rangeReset };
}
