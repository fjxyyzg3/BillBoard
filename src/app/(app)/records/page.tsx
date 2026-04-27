import Link from "next/link";
import { redirect } from "next/navigation";
import { PerspectiveToggle } from "@/components/perspective-toggle";
import { RecordsFilterBar } from "@/components/records-filter-bar";
import { TimeRangeSelector } from "@/components/time-range-selector";
import { TransactionEditorDrawer } from "@/components/transaction-editor-drawer";
import { requireAppSession } from "@/lib/auth/session";
import { db } from "@/lib/db";
import { formatFen } from "@/lib/money";
import { parsePerspective } from "@/lib/perspective";
import { parseRangePreset } from "@/lib/range-preset";
import { getCurrentShanghaiDateTimeLocal } from "@/lib/transactions/datetime";
import { listRecords } from "@/lib/records/list-records";

type RecordsPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

function buildSearchParams(
  values: Record<string, string | string[] | undefined> | undefined,
) {
  const params = new URLSearchParams();

  for (const [key, value] of Object.entries(values ?? {})) {
    if (Array.isArray(value)) {
      for (const item of value) {
        if (item) {
          params.append(key, item);
        }
      }

      continue;
    }

    if (value) {
      params.set(key, value);
    }
  }

  return params;
}

function buildRecordsHref(params: URLSearchParams) {
  const query = params.toString();

  return query ? `/records?${query}` : "/records";
}

function formatOccurredAt(date: Date) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: "Asia/Shanghai",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  }).format(date);
}

function getNoteExcerpt(note: string | null) {
  if (!note) {
    return "No note";
  }

  if (note.length <= 72) {
    return note;
  }

  return `${note.slice(0, 69)}...`;
}

function parseTypeFilter(value: string | null) {
  if (value === "income" || value === "expense") {
    return value;
  }

  return undefined;
}

function parseDrillDownDate(value: string | null) {
  if (!value) {
    return undefined;
  }

  const parsed = new Date(value);

  if (Number.isNaN(parsed.getTime()) || parsed.toISOString() !== value) {
    return undefined;
  }

  return parsed;
}

export default async function RecordsPage({ searchParams }: RecordsPageProps) {
  const user = await requireAppSession();
  const resolvedSearchParams = searchParams ? await searchParams : undefined;
  const currentParams = buildSearchParams(resolvedSearchParams);

  if (!currentParams.get("range")) {
    currentParams.set("range", "last-30-days");
    redirect(buildRecordsHref(currentParams));
  }

  const rangePreset = parseRangePreset(currentParams.get("range"));
  const perspective = parsePerspective(currentParams.get("perspective"));
  const typeFilter = parseTypeFilter(currentParams.get("type"));
  const categoryIdFilter = currentParams.get("category")?.trim() || undefined;
  const drillDownFrom = parseDrillDownDate(currentParams.get("from"));
  const drillDownTo = parseDrillDownDate(currentParams.get("to"));
  const selectedRecordId = currentParams.get("record")?.trim() || undefined;

  const [household, categories, householdMembers] = await Promise.all([
    db.household.findUniqueOrThrow({
      where: { id: user.householdId },
      select: { timezone: true },
    }),
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

  const records = await listRecords({
    householdId: user.householdId,
    currentMemberId: user.memberId,
    from: drillDownFrom && drillDownTo ? drillDownFrom : undefined,
    timezone: household.timezone,
    rangePreset,
    perspective,
    to: drillDownFrom && drillDownTo ? drillDownTo : undefined,
    type: typeFilter,
    categoryId: categoryIdFilter,
  });
  const selectedRecord = selectedRecordId && records.some((record) => record.id === selectedRecordId)
    ? await db.transaction.findFirst({
        where: {
          id: selectedRecordId,
          householdId: user.householdId,
          deletedAt: null,
        },
        select: {
          id: true,
          amountFen: true,
          actorMemberId: true,
          categoryId: true,
          note: true,
          occurredAt: true,
          type: true,
          createdByMember: { select: { memberName: true } },
        },
      })
    : null;

  const categoryOptions = categories.map((category) => ({
    id: category.id,
    name: category.name,
    type: category.type === "INCOME" ? "income" : "expense",
  })) as Array<{ id: string; name: string; type: "income" | "expense" }>;
  const closeParams = new URLSearchParams(currentParams.toString());
  const selectedRecordParams = new URLSearchParams(currentParams.toString());

  closeParams.delete("record");
  const closeHref = buildRecordsHref(closeParams);
  const returnTo = buildRecordsHref(currentParams);

  return (
    <section className="space-y-6">
      <header className="flex flex-col gap-4 sm:flex-row sm:items-end sm:justify-between">
        <div className="space-y-2">
          <p className="text-xs font-semibold uppercase tracking-[0.14em] text-[var(--ios-muted)]">History</p>
          <h1 className="text-2xl font-semibold">Records</h1>
          <p className="text-sm text-stone-500">
            Review household history, filter it quickly, and adjust records in place.
          </p>
        </div>
        <TimeRangeSelector />
      </header>

      <div className="flex flex-col gap-4 lg:flex-row lg:items-end lg:justify-between">
        <PerspectiveToggle />
        <div className="w-full lg:max-w-xl">
          <RecordsFilterBar categories={categoryOptions} />
        </div>
      </div>

      <div className="ios-panel overflow-hidden">
        {records.length === 0 ? (
          <div className="p-6">
            <p className="text-sm text-stone-600">
              No records match the current filters. Try a wider range or clear a filter.
            </p>
          </div>
        ) : (
          <ul className="divide-y divide-stone-100">
            {records.map((record) => {
              const rowParams = new URLSearchParams(selectedRecordParams.toString());

              rowParams.set("record", record.id);

              return (
                <li key={record.id}>
                  <Link
                    className="block px-4 py-4 transition hover:bg-black/[0.03] sm:px-5"
                    href={buildRecordsHref(rowParams)}
                    scroll={false}
                  >
                    <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between">
                      <div className="space-y-2">
                        <div className="flex flex-wrap items-center gap-2">
                          <span
                            className={`ios-amount text-lg ${
                              record.type === "income" ? "text-[var(--ios-green)]" : "text-[var(--ios-text)]"
                            }`}
                          >
                            {record.type === "income" ? "+" : "-"}
                            {formatFen(record.amountFen)}
                          </span>
                          <span
                            className={`rounded-full px-2.5 py-1 text-xs font-medium ${
                              record.type === "income"
                                ? "bg-emerald-50 text-emerald-700"
                                : "bg-stone-100 text-stone-700"
                            }`}
                          >
                            {record.type === "income" ? "Income" : "Expense"}
                          </span>
                          <span className="text-sm text-stone-600">{record.categoryName}</span>
                        </div>
                        <p className="text-sm text-stone-600">{getNoteExcerpt(record.note)}</p>
                        <div className="flex flex-wrap gap-x-4 gap-y-1 text-xs text-stone-500">
                          <span>Actor: {record.actorMemberName}</span>
                          <span>Created by: {record.createdByMemberName}</span>
                        </div>
                      </div>
                      <div className="text-sm text-stone-500">{formatOccurredAt(record.occurredAt)}</div>
                    </div>
                  </Link>
                </li>
              );
            })}
          </ul>
        )}
      </div>

      {selectedRecord ? (
        <TransactionEditorDrawer
          categories={categoryOptions}
          closeHref={closeHref}
          householdMembers={householdMembers}
          record={{
            id: selectedRecord.id,
            amountFen: selectedRecord.amountFen,
            actorMemberId: selectedRecord.actorMemberId,
            categoryId: selectedRecord.categoryId,
            createdByMemberName: selectedRecord.createdByMember.memberName,
            note: selectedRecord.note,
            occurredAtLabel: formatOccurredAt(selectedRecord.occurredAt),
            occurredAtLocal: getCurrentShanghaiDateTimeLocal(selectedRecord.occurredAt),
            type: selectedRecord.type === "INCOME" ? "income" : "expense",
          }}
          returnTo={returnTo}
        />
      ) : null}
    </section>
  );
}
