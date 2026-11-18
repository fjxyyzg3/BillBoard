# 首页与报表合并 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Merge the standalone reports page into `/home`, make `/home` and `/records` share month/year/all range semantics, and remove the reports navigation entry and route.

**Architecture:** Introduce one shared report range module for month/year/all parsing, clamping, bounds, and URL helpers. Replace the old dashboard query with a single home report query that applies session-derived household/member scope, perspective filtering, `deletedAt: null`, unified trend aggregation, and both income and expense category sections. Update `/home`, `/records`, `/add`, navigation, i18n, tests, and route stubs to use the shared range model and to remove the old `/reports` path.

**Tech Stack:** Next.js App Router, React Server Components, Prisma, Vitest, Playwright, TypeScript, Tailwind CSS.

---

## File Structure

- Create: `src/lib/reports/report-range.ts`
  - Owns `ReportRangeMode`, `ReportRangeSelection`, `ReportRangeOptions`, `ReportRange`, parsing, clamping, Shanghai range math, and query-string helpers.
- Modify: `src/lib/reports/aggregate.ts`
  - Replace shortcut `RangePreset` aggregation with unified `HomeReport` aggregation over month/year/all ranges.
  - Keep `ReportTrendPoint` export for `TrendChart`.
  - Remove `recentTransactions` from the report shape.
- Create: `src/lib/reports/query-home-report.ts`
  - Loads household timezone, members, first transaction, scoped transactions, and returns the unified home report.
- Keep until consumer migration: `src/lib/reports/query-dashboard.ts`
  - Old shortcut-range dashboard query remains only while `/home` still imports it; remove after Task 5 migrates the consumer.
- Keep until route removal: `src/lib/reports/query-financial-report.ts`
  - Standalone reports query remains only while `/reports` still imports it; remove when Task 6 deletes the route.
- Modify: `src/lib/records/list-records.ts`
  - Accepts resolved `rangeBounds` instead of shortcut `rangePreset`.
- Modify: `src/lib/app-navigation.ts`
  - Preserves only shared `perspective`, `mode`, `month`, and `year` params across app navigation.
- Modify: `src/components/app-filters-provider.tsx`
  - Uses the shared report range query params instead of `range`.
- Modify: `src/components/report-range-controls.tsx`
  - Becomes the shared month/year/all control and preserves unrelated query params while patching range params.
- Modify: `src/components/category-breakdown.tsx`
  - Supports both income and expense labels and keeps category rows as drill-down links.
- Modify: `src/app/(app)/home/page.tsx`
  - Uses `queryHomeReport`, shared range controls, category type URL state, summary/trend/category drill-down links, and removes recent transactions.
- Modify: `src/app/(app)/records/page.tsx`
  - Uses shared range controls and computes `rangeBounds`; legal `from/to` still takes query priority for list filtering.
- Modify: `src/app/(app)/add/page.tsx`
  - Passes `perspective/mode/month/year` hidden fields to the form.
- Modify: `src/app/(app)/add/actions.ts`
  - Persists only valid shared range params after save.
- Modify: `src/app/(app)/records/actions.ts`
  - Changes the default records redirect target to month mode.
- Delete: `src/app/(app)/reports/page.tsx`
  - `/reports` becomes 404 by absence.
- Modify: `src/components/bottom-nav.tsx`, `src/components/desktop-nav.tsx`
  - Remove reports item and `ChartPie` import.
- Modify: `src/lib/i18n.ts`
  - Remove `nav.reports`, move needed range/category/reporting copy under `home` and shared keys.
- Delete if unused after imports are removed:
  - `src/components/time-range-selector.tsx`
  - `src/components/recent-transactions.tsx`
  - `src/components/report-category-pie.tsx`
  - `src/lib/reports/display.ts`
- Tests to modify or delete:
  - Modify: `tests/unit/financial-report.test.ts` to target `report-range.ts`.
  - Modify: `tests/unit/report-aggregate.test.ts`.
  - Modify: `tests/unit/report-range-controls.test.tsx`.
  - Modify: `tests/unit/app-navigation.test.ts`.
  - Modify: `tests/unit/i18n.test.ts`.
  - Modify: `tests/unit/navigation-version-marker.test.tsx`.
  - Modify: `tests/integration/report-query.test.ts`.
  - Modify: `tests/integration/records-query.test.ts`.
  - Modify: `tests/integration/records-page-and-actions.test.ts`.
  - Modify: `tests/integration/ops-instrumentation.test.ts`.
  - Modify: `tests/integration/import-page-and-actions.test.ts`.
  - Modify: `tests/integration/app-route-stubs.test.ts`.
  - Modify: `tests/e2e/filter-navigation.spec.ts`.
  - Modify: `tests/e2e/home-drilldown.spec.ts`.
  - Modify: `tests/e2e/create-expense.spec.ts`.
  - Modify: `tests/e2e/ui-layout.spec.ts`.
  - Delete if component files are deleted:
    - `tests/unit/report-category-pie.test.tsx`
    - `tests/unit/report-display.test.ts`
  - Keep unchanged unless failures reveal type drift:
    - `tests/unit/time-range.test.ts`; old shortcut helper can remain only if no code imports it. If no code imports `src/lib/time-range.ts`, delete both file and test in Task 8.

---

### Task 1: Shared Report Range Model

**Files:**
- Create: `src/lib/reports/report-range.ts`
- Modify: `tests/unit/financial-report.test.ts`
- Modify: `tests/unit/report-range-controls.test.tsx`
- Modify: `src/components/report-range-controls.tsx`

- [ ] **Step 1: Replace range helper tests with shared report range tests**

Replace `tests/unit/financial-report.test.ts` with this content:

```ts
import { describe, expect, it } from "vitest";
import {
  buildReportRangeOptions,
  clampReportRangeSelection,
  getReportRangeBounds,
  parseReportRangeSearchParams,
} from "@/lib/reports/report-range";

describe("report range helpers", () => {
  it("parses month, year, and all-time report ranges in Asia/Shanghai", () => {
    const now = new Date("2026-05-17T02:30:00.000Z");

    expect(
      parseReportRangeSearchParams(
        { mode: "unsupported", month: "not-a-month", year: "x" },
        now,
      ),
    ).toEqual({
      mode: "month",
      month: "2026-05",
      year: "2026",
    });

    expect(
      getReportRangeBounds(
        { mode: "month", month: "2026-02", year: "2026" },
        now,
        null,
        "Asia/Shanghai",
      ),
    ).toEqual({
      from: new Date("2026-01-31T16:00:00.000Z"),
      to: new Date("2026-02-28T15:59:59.999Z"),
    });
    expect(
      getReportRangeBounds(
        { mode: "year", month: "2026-05", year: "2025" },
        now,
        null,
        "Asia/Shanghai",
      ),
    ).toEqual({
      from: new Date("2024-12-31T16:00:00.000Z"),
      to: new Date("2025-12-31T15:59:59.999Z"),
    });
    expect(
      getReportRangeBounds(
        { mode: "all", month: "2026-05", year: "2026" },
        now,
        new Date("2024-03-03T19:00:00.000Z"),
        "Asia/Shanghai",
      ),
    ).toEqual({
      from: new Date("2024-03-03T16:00:00.000Z"),
      to: new Date("2026-05-17T15:59:59.999Z"),
    });
  });

  it("builds month and year options from now back to the first transaction month", () => {
    const options = buildReportRangeOptions(
      new Date("2024-03-03T19:00:00.000Z"),
      new Date("2026-05-17T02:30:00.000Z"),
      "Asia/Shanghai",
    );

    expect(options.years).toEqual(["2026", "2025", "2024"]);
    expect(options.months[0]).toBe("2026-05");
    expect(options.months.at(-1)).toBe("2024-03");
    expect(options.months).toHaveLength(27);
  });

  it("clamps selected month and year to the available report options", () => {
    const options = {
      months: ["2026-05", "2026-04", "2026-03", "2026-02", "2026-01"],
      years: ["2026"],
    };

    expect(
      clampReportRangeSelection(
        { mode: "month", month: "2025-12", year: "2025" },
        options,
      ),
    ).toEqual({ mode: "month", month: "2026-01", year: "2026" });
    expect(
      clampReportRangeSelection(
        { mode: "year", month: "2026-06", year: "2030" },
        options,
      ),
    ).toEqual({ mode: "year", month: "2026-05", year: "2026" });
  });
});
```

- [ ] **Step 2: Run range helper test to verify it fails**

Run: `npm run test:unit -- tests/unit/financial-report.test.ts`

Expected: FAIL with `Cannot find module '@/lib/reports/report-range'`.

- [ ] **Step 3: Add shared report range module**

Create `src/lib/reports/report-range.ts` with this content:

```ts
export type ReportRangeMode = "month" | "year" | "all";

export type ReportRangeSelection = {
  mode: ReportRangeMode;
  month: string;
  year: string;
};

export type ReportRangeOptions = {
  months: string[];
  years: string[];
};

export type ReportRange = ReportRangeSelection & {
  from: Date;
  to: Date;
};

const SHANGHAI_OFFSET_HOURS = 8;
const SHANGHAI_OFFSET_MS = SHANGHAI_OFFSET_HOURS * 60 * 60 * 1000;

function padTwoDigits(value: number) {
  return String(value).padStart(2, "0");
}

function getShanghaiDateParts(date: Date) {
  const shanghaiDate = new Date(date.getTime() + SHANGHAI_OFFSET_MS);

  return {
    day: shanghaiDate.getUTCDate(),
    month: shanghaiDate.getUTCMonth() + 1,
    year: shanghaiDate.getUTCFullYear(),
  };
}

function getShanghaiStart(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day, -SHANGHAI_OFFSET_HOURS, 0, 0, 0));
}

function getShanghaiEnd(year: number, month: number, day: number) {
  return new Date(Date.UTC(year, month, day, 23 - SHANGHAI_OFFSET_HOURS, 59, 59, 999));
}

function formatMonth(year: number, month: number) {
  return `${year}-${padTwoDigits(month)}`;
}

function formatMonthIndex(monthIndex: number) {
  const year = Math.floor(monthIndex / 12);
  const month = (monthIndex % 12) + 1;

  return formatMonth(year, month);
}

function getMonthIndex(year: number, month: number) {
  return year * 12 + month - 1;
}

function isValidMonth(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}-(0[1-9]|1[0-2])$/.test(value);
}

function isValidYear(value: string | null | undefined): value is string {
  return typeof value === "string" && /^\d{4}$/.test(value);
}

export function parseReportRangeSearchParams(
  params: {
    mode?: string | null;
    month?: string | null;
    year?: string | null;
  },
  now: Date,
): ReportRangeSelection {
  const current = getShanghaiDateParts(now);
  const mode =
    params.mode === "year" || params.mode === "all" || params.mode === "month"
      ? params.mode
      : "month";

  return {
    mode,
    month: isValidMonth(params.month) ? params.month : formatMonth(current.year, current.month),
    year: isValidYear(params.year) ? params.year : String(current.year),
  };
}

export function buildReportRangeOptions(
  firstOccurredAt: Date | null,
  now: Date,
  timezone: string,
): ReportRangeOptions {
  if (timezone !== "Asia/Shanghai") {
    throw new Error("v1 supports Asia/Shanghai report math only");
  }

  const current = getShanghaiDateParts(now);
  const first = firstOccurredAt ? getShanghaiDateParts(firstOccurredAt) : current;
  const currentMonthIndex = getMonthIndex(current.year, current.month);
  const firstMonthIndex = getMonthIndex(first.year, first.month);
  const earliestMonthIndex = Math.min(firstMonthIndex, currentMonthIndex);
  const months: string[] = [];

  for (let monthIndex = currentMonthIndex; monthIndex >= earliestMonthIndex; monthIndex -= 1) {
    months.push(formatMonthIndex(monthIndex));
  }

  const earliestYear = Math.floor(earliestMonthIndex / 12);
  const years: string[] = [];

  for (let year = current.year; year >= earliestYear; year -= 1) {
    years.push(String(year));
  }

  return { months, years };
}

function clampDescendingOption(value: string, options: string[]) {
  if (options.length === 0) {
    return value;
  }

  const newest = options[0] ?? value;
  const oldest = options[options.length - 1] ?? value;

  if (value > newest) {
    return newest;
  }

  if (value < oldest) {
    return oldest;
  }

  return options.includes(value) ? value : newest;
}

export function clampReportRangeSelection(
  selection: ReportRangeSelection,
  options: ReportRangeOptions,
): ReportRangeSelection {
  return {
    mode: selection.mode,
    month: clampDescendingOption(selection.month, options.months),
    year: clampDescendingOption(selection.year, options.years),
  };
}

export function getReportRangeBounds(
  selection: ReportRangeSelection,
  now: Date,
  firstOccurredAt: Date | null,
  timezone: string,
) {
  if (timezone !== "Asia/Shanghai") {
    throw new Error("v1 supports Asia/Shanghai report math only");
  }

  const current = getShanghaiDateParts(now);

  if (selection.mode === "month") {
    const [year, month] = selection.month.split("-").map(Number);

    return {
      from: getShanghaiStart(year, month - 1, 1),
      to: getShanghaiEnd(year, month, 0),
    };
  }

  if (selection.mode === "year") {
    const year = Number(selection.year);

    return {
      from: getShanghaiStart(year, 0, 1),
      to: getShanghaiEnd(year, 12, 0),
    };
  }

  const first = firstOccurredAt ? getShanghaiDateParts(firstOccurredAt) : current;

  return {
    from: getShanghaiStart(first.year, first.month - 1, first.day),
    to: getShanghaiEnd(current.year, current.month - 1, current.day),
  };
}
```

- [ ] **Step 4: Run range helper test to verify it passes**

Run: `npm run test:unit -- tests/unit/financial-report.test.ts`

Expected: PASS.

- [ ] **Step 5: Update range control test to use `/home` and shared labels**

Modify `tests/unit/report-range-controls.test.tsx` so the navigation mock and labels are:

```ts
vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => ({
    replace: vi.fn(),
  }),
  useSearchParams: () =>
    new URLSearchParams("perspective=spouse&categoryType=income&mode=month&month=2026-05&year=2026"),
}));

const labels = {
  all: "All",
  allDescription: "From the first record to today.",
  month: "Month",
  monthLabel: "Month",
  year: "Year",
  yearLabel: "Year",
};
```

Keep the two existing render tests, and change their label type later in Task 6 if TypeScript reports `Messages["reports"]` no longer exists.

- [ ] **Step 6: Modify range controls to preserve unrelated query params**

In `src/components/report-range-controls.tsx`, add `useSearchParams`, switch imports to `report-range`, and replace `buildReportHref` with:

```ts
function buildReportHref(
  pathname: string,
  currentParams: URLSearchParams,
  selection: ReportRangeSelection,
  patch: Partial<ReportRangeSelection>,
) {
  const nextSelection = { ...selection, ...patch };
  const params = new URLSearchParams(currentParams.toString());

  params.set("mode", nextSelection.mode);
  params.set("month", nextSelection.month);
  params.set("year", nextSelection.year);
  params.delete("from");
  params.delete("to");
  params.delete("record");

  return `${pathname}?${params.toString()}`;
}
```

Inside `ReportRangeControls`, define:

```ts
const searchParams = useSearchParams();
const currentParams = new URLSearchParams(searchParams.toString());

function navigate(patch: Partial<ReportRangeSelection>) {
  router.replace(buildReportHref(pathname, currentParams, selection, patch), { scroll: false });
}
```

- [ ] **Step 7: Run range control test to verify it passes**

Run: `npm run test:unit -- tests/unit/report-range-controls.test.tsx`

Expected: PASS.

- [ ] **Step 8: Commit Task 1**

```powershell
git add src/lib/reports/report-range.ts src/components/report-range-controls.tsx tests/unit/financial-report.test.ts tests/unit/report-range-controls.test.tsx
git commit -m "v1.10.0 统一报表范围模型" -m "新增月年全部范围模型和共享范围控件行为，作为首页与记录页合并的基础。"
```

---

### Task 2: Unified Home Report Aggregation and Query

**Files:**
- Modify: `src/lib/reports/aggregate.ts`
- Create: `src/lib/reports/query-home-report.ts`
- Keep unchanged for now: `src/lib/reports/query-dashboard.ts`
- Keep unchanged for now: `src/lib/reports/query-financial-report.ts`
- Modify: `tests/unit/report-aggregate.test.ts`
- Modify: `tests/integration/report-query.test.ts`

- [ ] **Step 1: Add aggregate unit tests for unified home report expectations**

Keep the existing shortcut dashboard tests in `tests/unit/report-aggregate.test.ts`. Add an `aggregateHomeReport` import and a new `describe("aggregateHomeReport", ...)` block:

```ts
import { aggregateHomeReport, aggregateReport, type ReportTransaction } from "@/lib/reports/aggregate";

describe("aggregateHomeReport", () => {
  it("builds summary, daily trend, and income and expense categories for a month range", () => {
    const transactions: ReportTransaction[] = [
      {
        id: "expense-dining",
        amountFen: 4500,
        actorMemberId: "member-1",
        actorMemberName: "Me",
        categoryId: "category-dining",
        categoryName: "Dining",
        createdByMemberId: "member-1",
        createdByMemberName: "Me",
        note: "Dinner",
        occurredAt: new Date("2026-04-25T10:00:00.000Z"),
        type: "expense",
      },
      {
        id: "income-salary",
        amountFen: 10000,
        actorMemberId: "member-2",
        actorMemberName: "Spouse",
        categoryId: "category-salary",
        categoryName: "Salary",
        createdByMemberId: "member-2",
        createdByMemberName: "Spouse",
        note: "Payroll",
        occurredAt: new Date("2026-04-24T01:30:00.000Z"),
        type: "income",
      },
      {
        id: "expense-travel",
        amountFen: 9000,
        actorMemberId: "member-2",
        actorMemberName: "Spouse",
        categoryId: "category-travel",
        categoryName: "Travel",
        createdByMemberId: "member-1",
        createdByMemberName: "Me",
        note: "Train tickets",
        occurredAt: new Date("2026-04-23T04:00:00.000Z"),
        type: "expense",
      },
    ];

    const report = aggregateHomeReport({
      range: {
        from: new Date("2026-03-31T16:00:00.000Z"),
        mode: "month",
        month: "2026-04",
        to: new Date("2026-04-30T15:59:59.999Z"),
        year: "2026",
      },
      rangeOptions: {
        months: ["2026-04"],
        years: ["2026"],
      },
      timezone: "Asia/Shanghai",
      transactions,
    });

    expect(report.summary).toEqual({
      expenseFen: 13500,
      incomeFen: 10000,
      netFen: -3500,
      transactionCount: 3,
    });
    expect(report.trend.granularity).toBe("day");
    expect(report.trend.points.find((point) => point.bucketKey === "2026-04-24")).toMatchObject({
      incomeFen: 10000,
      expenseFen: 0,
      transactionCount: 1,
    });
    expect(report.categories.expense.items.map((item) => item.categoryName)).toEqual([
      "Travel",
      "Dining",
    ]);
    expect(report.categories.expense.items[0]?.share).toBeCloseTo(9000 / 13500);
    expect(report.categories.income.items).toEqual([
      {
        amountFen: 10000,
        categoryId: "category-salary",
        categoryName: "Salary",
        share: 1,
        transactionCount: 1,
      },
    ]);
  });

  it("groups year and all ranges by month and fills empty buckets", () => {
    const report = aggregateHomeReport({
      range: {
        from: new Date("2025-12-31T16:00:00.000Z"),
        mode: "year",
        month: "2026-05",
        to: new Date("2026-12-31T15:59:59.999Z"),
        year: "2026",
      },
      rangeOptions: {
        months: ["2026-05", "2026-04"],
        years: ["2026"],
      },
      timezone: "Asia/Shanghai",
      transactions: [
        {
          id: "travel-may",
          amountFen: 3600,
          actorMemberId: "member-1",
          actorMemberName: "Me",
          categoryId: "category-travel",
          categoryName: "Travel",
          createdByMemberId: "member-1",
          createdByMemberName: "Me",
          note: null,
          occurredAt: new Date("2026-05-20T03:00:00.000Z"),
          type: "expense",
        },
        {
          id: "salary-april",
          amountFen: 120000,
          actorMemberId: "member-1",
          actorMemberName: "Me",
          categoryId: "category-salary",
          categoryName: "Salary",
          createdByMemberId: "member-1",
          createdByMemberName: "Me",
          note: null,
          occurredAt: new Date("2026-04-02T01:00:00.000Z"),
          type: "income",
        },
      ],
    });

    expect(report.trend.granularity).toBe("month");
    expect(report.trend.points).toHaveLength(12);
    expect(report.trend.points[0]?.bucketKey).toBe("2026-01");
    expect(report.trend.points[11]?.bucketKey).toBe("2026-12");
  });
});
```

- [ ] **Step 2: Run aggregate unit test to verify it fails**

Run: `npm run test:unit -- tests/unit/report-aggregate.test.ts`

Expected: FAIL because `aggregateHomeReport` does not exist yet.

- [ ] **Step 3: Add unified home aggregation without breaking the old dashboard aggregation**

In `src/lib/reports/aggregate.ts`, keep the existing `RangePreset`, `DashboardReport`, `buildTrendPoints`, and `aggregateReport` exports unchanged for the old `/home` consumer. Add the `HomeReport` type and `aggregateHomeReport` export alongside them.

Add imports:

```ts
import type {
  ReportRange,
  ReportRangeOptions,
  ReportRangeSelection,
} from "@/lib/reports/report-range";
```

Add:

```ts
export type ReportCategoryItem = {
  amountFen: number;
  categoryId: string;
  categoryName: string;
  share: number;
  transactionCount: number;
};

export type HomeReport = {
  categories: {
    expense: { items: ReportCategoryItem[]; totalFen: number };
    income: { items: ReportCategoryItem[]; totalFen: number };
  };
  range: ReportRange;
  rangeOptions: ReportRangeOptions;
  summary: {
    expenseFen: number;
    incomeFen: number;
    netFen: number;
    transactionCount: number;
  };
  trend: {
    granularity: "day" | "month";
    points: ReportTrendPoint[];
  };
};

type AggregateHomeReportInput = {
  range: ReportRange;
  rangeOptions: ReportRangeOptions;
  timezone: string;
  transactions: ReportTransaction[];
};
```

Add a `buildHomeTrendPoints(selection: ReportRangeSelection, rangeBounds, timezone)` helper that reuses the same day/month cursor behavior as the existing `buildTrendPoints`, but chooses `day` only for `selection.mode === "month"` and `month` for `year` and `all`.

Add a `buildCategorySection` helper for income and expense maps, then implement:

```ts
export function aggregateHomeReport({
  range,
  rangeOptions,
  timezone,
  transactions,
}: AggregateHomeReportInput): HomeReport {
  const trend = buildHomeTrendPoints(range, range, timezone);
  // Accumulate incomeFen, expenseFen, trend buckets, incomeCategoryTotals, and expenseCategoryTotals.
  return {
    categories: {
      expense: buildCategorySection(expenseCategoryTotals),
      income: buildCategorySection(incomeCategoryTotals),
    },
    range,
    rangeOptions,
    summary: {
      expenseFen,
      incomeFen,
      netFen: incomeFen - expenseFen,
      transactionCount: transactions.length,
    },
    trend,
  };
}
```

- [ ] **Step 4: Run aggregate unit test to verify it passes**

Run: `npm run test:unit -- tests/unit/report-aggregate.test.ts`

Expected: PASS.

- [ ] **Step 5: Add report query integration coverage for the unified home report**

In `tests/integration/report-query.test.ts`, keep the existing `queryDashboard` and `queryFinancialReport` imports/tests until their consumers are migrated. Add:

```ts
let queryHomeReport: typeof import("@/lib/reports/query-home-report").queryHomeReport;
```

Add this to the existing `beforeAll` query imports:

```ts
({ queryHomeReport } = await import("@/lib/reports/query-home-report"));
```

Add a new `describe("queryHomeReport", ...)` block.

In the first query test, call:

```ts
const report = await queryHomeReport({
  householdId: household.householdId,
  currentMemberId: household.ownerMember.id,
  perspective: "household",
  range: { mode: "month", month: "2026-04", year: "2026" },
  now: new Date("2026-04-26T04:00:00.000Z"),
});
```

Assert:

```ts
expect(report.summary).toEqual({
  expenseFen: 12500,
  incomeFen: 500000,
  netFen: 487500,
  transactionCount: 3,
});
expect(report.categories.expense.items.map((item) => item.categoryName)).toEqual([
  "Travel",
  "Dining",
]);
expect(report.categories.income.items.map((item) => item.categoryName)).toEqual(["Salary"]);
expect(report.trend.points.find((point) => point.bucketKey === "2026-04-25")).toMatchObject({
  incomeFen: 500000,
  expenseFen: 0,
  transactionCount: 1,
});
```

In the perspective test, call `queryHomeReport` for `mine` and `spouse` with `range: { mode: "month", month: "2026-04", year: "2026" }`. Assert category coverage:

```ts
expect(spouse.categories.expense.items).toHaveLength(1);
expect(spouse.categories.income.items).toHaveLength(1);
```

Add an all-range test named:

```ts
it("summarizes all non-deleted perspective-scoped transactions by income and expense categories", async () => {
```

Use `queryHomeReport` with `range: { mode: "all", month: "2026-04", year: "2026" }` and assert the summary, income and expense categories, range, and range options from the unified home report.

Add an unauthorized test that calls `queryHomeReport`.

- [ ] **Step 6: Run report query integration test to verify it fails**

Run: `npm run test:integration -- tests/integration/report-query.test.ts`

Expected: FAIL with `Cannot find module '@/lib/reports/query-home-report'`.

- [ ] **Step 7: Implement `queryHomeReport`**

Create `src/lib/reports/query-home-report.ts`:

```ts
import { TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { type Perspective, resolvePerspective } from "@/lib/perspective";
import { aggregateHomeReport, type HomeReport } from "@/lib/reports/aggregate";
import {
  buildReportRangeOptions,
  clampReportRangeSelection,
  getReportRangeBounds,
  type ReportRangeSelection,
} from "@/lib/reports/report-range";

type QueryHomeReportInput = {
  currentMemberId: string;
  householdId: string;
  now?: Date;
  perspective: Perspective;
  range: ReportRangeSelection;
};

export async function queryHomeReport({
  currentMemberId,
  householdId,
  now = new Date(),
  perspective,
  range,
}: QueryHomeReportInput): Promise<HomeReport> {
  const [household, householdMembers, firstTransaction] = await Promise.all([
    db.household.findUniqueOrThrow({
      where: { id: householdId },
      select: { timezone: true },
    }),
    db.householdMember.findMany({
      where: { householdId },
      select: { id: true },
    }),
    db.transaction.findFirst({
      orderBy: { occurredAt: "asc" },
      select: { occurredAt: true },
      where: {
        deletedAt: null,
        householdId,
      },
    }),
  ]);
  const memberIds = householdMembers.map((member) => member.id);

  if (!memberIds.includes(currentMemberId)) {
    throw new Error("Unauthorized");
  }

  const rangeOptions = buildReportRangeOptions(
    firstTransaction?.occurredAt ?? null,
    now,
    household.timezone,
  );
  const resolvedRange = clampReportRangeSelection(range, rangeOptions);
  const rangeBounds = getReportRangeBounds(
    resolvedRange,
    now,
    firstTransaction?.occurredAt ?? null,
    household.timezone,
  );
  const reportRange = {
    ...resolvedRange,
    ...rangeBounds,
  };
  const actorMemberIds = resolvePerspective(perspective, currentMemberId, memberIds);

  if (actorMemberIds.length === 0) {
    return aggregateHomeReport({
      range: reportRange,
      rangeOptions,
      timezone: household.timezone,
      transactions: [],
    });
  }

  const transactions = await db.transaction.findMany({
    orderBy: [{ occurredAt: "desc" }, { createdAt: "desc" }],
    select: {
      actorMember: { select: { id: true, memberName: true } },
      amountFen: true,
      category: { select: { id: true, name: true } },
      createdByMember: { select: { id: true, memberName: true } },
      id: true,
      note: true,
      occurredAt: true,
      type: true,
    },
    where: {
      actorMemberId: { in: actorMemberIds },
      deletedAt: null,
      householdId,
      occurredAt: { gte: rangeBounds.from, lte: rangeBounds.to },
    },
  });

  return aggregateHomeReport({
    range: reportRange,
    rangeOptions,
    timezone: household.timezone,
    transactions: transactions.map((transaction) => ({
      actorMemberId: transaction.actorMember.id,
      actorMemberName: transaction.actorMember.memberName,
      amountFen: transaction.amountFen,
      categoryId: transaction.category.id,
      categoryName: transaction.category.name,
      createdByMemberId: transaction.createdByMember.id,
      createdByMemberName: transaction.createdByMember.memberName,
      id: transaction.id,
      note: transaction.note,
      occurredAt: transaction.occurredAt,
      type: transaction.type === TransactionType.INCOME ? "income" : "expense",
    })),
  });
}
```

- [ ] **Step 8: Confirm old query files stay until their consumers are migrated**

Do not delete these files in Task 2:

```text
src/lib/reports/query-dashboard.ts
src/lib/reports/query-financial-report.ts
```

They are still imported by `/home` and `/reports` until later tasks. Removing them here would make intermediate commits fail lint/type checks. They are cleaned up in Task 6 or Task 8 after imports are gone.

- [ ] **Step 9: Run report query integration test to verify it passes**

Run: `npm run test:integration -- tests/integration/report-query.test.ts`

Expected: PASS.

- [ ] **Step 10: Commit Task 2**

```powershell
git add src/lib/reports/aggregate.ts src/lib/reports/query-home-report.ts tests/unit/report-aggregate.test.ts tests/integration/report-query.test.ts
git commit -m "v1.10.0 统一首页报表查询" -m "用单一首页报表查询承载月年全部范围、成员视角、趋势和收入支出分类。"
```

---

### Task 3: Shared Navigation Filters and Add Persistence

**Files:**
- Modify: `src/lib/app-navigation.ts`
- Modify: `src/components/app-filters-provider.tsx`
- Modify: `src/app/(app)/add/page.tsx`
- Modify: `src/components/transaction-form.tsx`
- Modify: `src/app/(app)/add/actions.ts`
- Modify: `tests/unit/app-navigation.test.ts`
- Modify: `tests/e2e/filter-navigation.spec.ts`
- Modify: `tests/e2e/create-expense.spec.ts`

- [ ] **Step 1: Update app navigation unit test**

Replace `tests/unit/app-navigation.test.ts` with:

```ts
import { describe, expect, it } from "vitest";
import { buildAppHref } from "@/lib/app-navigation";

describe("app navigation", () => {
  it("keeps shared report filters for app pages and drops page-local filters", () => {
    const params = new URLSearchParams(
      "mode=month&month=2026-04&year=2026&perspective=me&type=expense&categoryType=income&record=abc",
    );

    expect(buildAppHref("/records", params)).toBe(
      "/records?perspective=me&mode=month&month=2026-04&year=2026",
    );
    expect(buildAppHref("/add", params)).toBe(
      "/add?perspective=me&mode=month&month=2026-04&year=2026",
    );
    expect(buildAppHref("/home", params)).toBe(
      "/home?perspective=me&mode=month&month=2026-04&year=2026",
    );
  });
});
```

- [ ] **Step 2: Run app navigation test to verify it fails**

Run: `npm run test:unit -- tests/unit/app-navigation.test.ts`

Expected: FAIL because `buildAppHref` still preserves `range` and special-cases `/reports`.

- [ ] **Step 3: Update `buildAppHref` shared keys**

Replace `src/lib/app-navigation.ts` with:

```ts
type SearchParamReader = Pick<URLSearchParams, "get">;

const SHARED_FILTER_KEYS = ["perspective", "mode", "month", "year"] as const;

export function buildAppHref(pathname: string, searchParams: SearchParamReader) {
  const params = new URLSearchParams();

  for (const key of SHARED_FILTER_KEYS) {
    const value = searchParams.get(key);

    if (value) {
      params.set(key, value);
    }
  }

  const query = params.toString();

  return query ? `${pathname}?${query}` : pathname;
}
```

- [ ] **Step 4: Update `AppFiltersProvider` shared navigation while keeping legacy range controls**

In `src/components/app-filters-provider.tsx`, keep `parseRangePreset`, `RangePreset`, `setRangePreset`, and `rangePreset` until `TimeRangeSelector` consumers are migrated in later tasks. Only update shared navigation and perspective behavior in this task.

Keep this context shape for now:

```ts
type AppFiltersContextValue = {
  buildHref: (pathname: string) => string;
  navigateTo: (pathname: string) => void;
  perspective: Perspective;
  rangePreset: RangePreset;
  setPerspective: (perspective: Perspective) => void;
  setRangePreset: (rangePreset: RangePreset) => void;
};
```

In `setPerspective`, keep deleting `record`, `from`, and `to`:

```ts
nextParams.delete("from");
nextParams.delete("to");
nextParams.delete("record");
```

The context value keeps the legacy range fields while using the new shared navigation builder:

```ts
const value: AppFiltersContextValue = {
  buildHref(pathname: string) {
    return buildAppHref(pathname, currentParams);
  },
  navigateTo(nextPathname: string) {
    router.push(buildAppHref(nextPathname, new URLSearchParams(queryRef.current)));
  },
  perspective: parsePerspective(currentParams.get("perspective")),
  rangePreset: parseRangePreset(currentParams.get("range")),
  setPerspective,
  setRangePreset,
};
```

- [ ] **Step 5: Update add page shared params**

In `src/app/(app)/add/page.tsx`, replace `buildSharedParams` with:

```ts
function buildSharedParams(
  searchParams:
    | {
        mode?: string;
        month?: string;
        perspective?: string;
        year?: string;
      }
    | undefined,
) {
  return {
    mode: searchParams?.mode,
    month: searchParams?.month,
    perspective: searchParams?.perspective,
    year: searchParams?.year,
  };
}
```

Update `AddPageProps` search params to include `mode`, `month`, and `year`, and remove `range`.

- [ ] **Step 6: Update transaction form hidden filters**

In `src/components/transaction-form.tsx`, change the `sharedFilters` type to:

```ts
sharedFilters: {
  mode?: string;
  month?: string;
  perspective?: string;
  year?: string;
};
```

Replace the old hidden `range` input with:

```tsx
{sharedFilters.mode ? <input name="mode" type="hidden" value={sharedFilters.mode} /> : null}
{sharedFilters.month ? <input name="month" type="hidden" value={sharedFilters.month} /> : null}
{sharedFilters.year ? <input name="year" type="hidden" value={sharedFilters.year} /> : null}
```

- [ ] **Step 7: Update add action shared param validation**

In `src/app/(app)/add/actions.ts`, replace `getSharedFilterParams` with:

```ts
function getSharedFilterParams(formData: FormData) {
  const params = new URLSearchParams();
  const perspective = String(formData.get("perspective") ?? "");
  const mode = String(formData.get("mode") ?? "");
  const month = String(formData.get("month") ?? "");
  const year = String(formData.get("year") ?? "");

  if (perspective === "me" || perspective === "spouse") {
    params.set("perspective", perspective);
  }

  if (mode === "month" || mode === "year" || mode === "all") {
    params.set("mode", mode);
  }

  if (/^\d{4}-(0[1-9]|1[0-2])$/.test(month)) {
    params.set("month", month);
  }

  if (/^\d{4}$/.test(year)) {
    params.set("year", year);
  }

  return params;
}
```

- [ ] **Step 8: Run focused navigation and add tests**

Run:

```powershell
npm run test:unit -- tests/unit/app-navigation.test.ts
npm run test:e2e -- tests/e2e/filter-navigation.spec.ts tests/e2e/create-expense.spec.ts
```

Expected: PASS. If E2E tests fail only because expectations still use old `range` URLs, update those focused E2E assertions in this task so the commit stays green. Do not wait until Task 7 for failures introduced by this task.

- [ ] **Step 9: Commit Task 3**

```powershell
git add src/lib/app-navigation.ts src/components/app-filters-provider.tsx src/app/(app)/add/page.tsx src/components/transaction-form.tsx src/app/(app)/add/actions.ts tests/unit/app-navigation.test.ts tests/e2e/filter-navigation.spec.ts tests/e2e/create-expense.spec.ts
git commit -m "v1.10.0 同步共享筛选导航" -m "导航与新增页改用月年全部共享参数，保存记录后保留同一查看上下文。"
```

---

### Task 4: Records Query and Page Range Migration

**Files:**
- Modify: `src/lib/records/list-records.ts`
- Modify: `src/app/(app)/records/page.tsx`
- Modify: `src/app/(app)/records/actions.ts`
- Modify: `tests/integration/records-query.test.ts`
- Modify: `tests/integration/records-page-and-actions.test.ts`
- Modify: `tests/integration/ops-instrumentation.test.ts`
- Modify: `tests/integration/import-page-and-actions.test.ts`

- [ ] **Step 1: Update records query tests to pass resolved range bounds**

In `tests/integration/records-query.test.ts`, replace every `rangePreset`, `timezone`, and `now` argument group in `listRecords` calls with:

```ts
rangeBounds: {
  from: new Date("2026-03-31T16:00:00.000Z"),
  to: new Date("2026-04-30T15:59:59.999Z"),
},
```

For the first test, this call becomes:

```ts
const records = await listRecords({
  householdId: household.householdId,
  currentMemberId: household.ownerMember.id,
  rangeBounds: {
    from: new Date("2026-03-31T16:00:00.000Z"),
    to: new Date("2026-04-30T15:59:59.999Z"),
  },
  perspective: "household",
});
```

- [ ] **Step 2: Run records query test to verify it fails**

Run: `npm run test:integration -- tests/integration/records-query.test.ts`

Expected: FAIL because `listRecords` does not accept `rangeBounds` yet.

- [ ] **Step 3: Modify `listRecords` input**

In `src/lib/records/list-records.ts`, remove imports from `time-range` and change `ListRecordsInput` to:

```ts
type ListRecordsInput = {
  householdId: string;
  currentMemberId: string;
  perspective: Perspective;
  categoryId?: string;
  rangeBounds: {
    from: Date;
    to: Date;
  };
  type?: RecordTypeFilter;
};
```

In `listRecords`, remove `timezone`, `rangePreset`, `now`, `from`, and `to` from destructuring. Replace:

```ts
const rangeBounds = from && to ? { from, to } : getRangeBounds(rangePreset, now, timezone);
```

with direct use of the input `rangeBounds`.

- [ ] **Step 4: Run records query test to verify it passes**

Run: `npm run test:integration -- tests/integration/records-query.test.ts`

Expected: PASS.

- [ ] **Step 5: Update records page range calculation**

In `src/app/(app)/records/page.tsx`:

Remove:

```ts
import { TimeRangeSelector } from "@/components/time-range-selector";
import { parseRangePreset } from "@/lib/range-preset";
```

Add:

```ts
import { ReportRangeControls } from "@/components/report-range-controls";
import {
  buildReportRangeOptions,
  clampReportRangeSelection,
  getReportRangeBounds,
  parseReportRangeSearchParams,
} from "@/lib/reports/report-range";
```

Delete the redirect block that forces `range=last-30-days`.

After loading `household`, query the first transaction:

```ts
const firstTransaction = await db.transaction.findFirst({
  orderBy: { occurredAt: "asc" },
  select: { occurredAt: true },
  where: {
    deletedAt: null,
    householdId: user.householdId,
  },
});
const now = new Date();
const parsedRange = parseReportRangeSearchParams(
  {
    mode: currentParams.get("mode"),
    month: currentParams.get("month"),
    year: currentParams.get("year"),
  },
  now,
);
const rangeOptions = buildReportRangeOptions(
  firstTransaction?.occurredAt ?? null,
  now,
  household.timezone,
);
const selectedRange = clampReportRangeSelection(parsedRange, rangeOptions);
const selectedRangeBounds = getReportRangeBounds(
  selectedRange,
  now,
  firstTransaction?.occurredAt ?? null,
  household.timezone,
);
const drillDownRangeBounds =
  drillDownFrom && drillDownTo ? { from: drillDownFrom, to: drillDownTo } : null;
```

Pass to `listRecords`:

```ts
rangeBounds: drillDownRangeBounds ?? selectedRangeBounds,
```

Replace `<TimeRangeSelector labels={messages.range} />` with:

```tsx
<ReportRangeControls
  labels={messages.reports.range}
  rangeOptions={rangeOptions}
  selection={selectedRange}
/>
```

- [ ] **Step 6: Update records actions default URL**

In `src/app/(app)/records/actions.ts`, replace:

```ts
const defaultRecordsHref = "/records?range=last-30-days";
```

with:

```ts
const defaultRecordsHref = "/records?mode=month";
```

The action sanitizers can keep preserving unknown valid return URLs; only the default changes.

- [ ] **Step 7: Update page/action tests for new URLs**

In `tests/integration/records-page-and-actions.test.ts`:

- Replace `TimeRangeSelector` mocks with `ReportRangeControls` mocks:

```ts
ReportRangeControls: () => createElement("div", { "data-testid": "report-range-controls" }),
```

- Replace URL expectations containing `range=last-30-days` with `mode=month&month=2026-04&year=2026` where the test is about shared filters.
- Keep the `AppFiltersProvider` legacy `setRangePreset` tests until the old home `TimeRangeSelector` consumer is migrated in Task 5.
- For action return URLs, change examples to `/records?mode=month&month=2026-04&year=2026&type=expense&record=record-1`.

In `tests/integration/ops-instrumentation.test.ts` and `tests/integration/import-page-and-actions.test.ts`, update component mocks and return URL literals the same way.

- [ ] **Step 8: Run focused records page/action tests**

Run:

```powershell
npm run test:integration -- tests/integration/records-page-and-actions.test.ts tests/integration/ops-instrumentation.test.ts tests/integration/import-page-and-actions.test.ts
```

Expected: PASS.

- [ ] **Step 9: Commit Task 4**

```powershell
git add src/lib/records/list-records.ts src/app/(app)/records/page.tsx src/app/(app)/records/actions.ts tests/integration/records-query.test.ts tests/integration/records-page-and-actions.test.ts tests/integration/ops-instrumentation.test.ts tests/integration/import-page-and-actions.test.ts
git commit -m "v1.10.0 迁移记录页范围筛选" -m "记录页改用月年全部范围，并保留趋势钻取的 from/to 查询优先级。"
```

---

### Task 5: Home Page Merge UI

**Files:**
- Modify: `src/app/(app)/home/page.tsx`
- Modify: `src/components/category-breakdown.tsx`
- Modify: `src/lib/i18n.ts`
- Modify: `tests/integration/records-page-and-actions.test.ts`
- Modify: `tests/integration/ops-instrumentation.test.ts`

- [ ] **Step 1: Add home copy for range and category analysis**

In `src/lib/i18n.ts`, under Chinese `home`, add:

```ts
range: {
  month: "月",
  year: "年",
  all: "全部",
  monthLabel: "月份",
  yearLabel: "年份",
  allDescription: "从第一条有效记录统计至今天",
},
categories: {
  title: "分类分析",
  expenseTab: "支出",
  incomeTab: "收入",
  expenseDescription: "当前范围内支出集中在哪里。",
  incomeDescription: "当前范围内收入来自哪里。",
  emptyExpense: "当前筛选下还没有支出记录。",
  emptyIncome: "当前筛选下还没有收入记录。",
  transactionCount: (countLabel: string) => `${countLabel} 笔记录`,
},
```

Under English `home`, add:

```ts
range: {
  month: "Month",
  year: "Year",
  all: "All",
  monthLabel: "Month",
  yearLabel: "Year",
  allDescription: "From the first active record through today",
},
categories: {
  title: "Category analysis",
  expenseTab: "Expense",
  incomeTab: "Income",
  expenseDescription: "Where spending is concentrated in this range.",
  incomeDescription: "Where income came from in this range.",
  emptyExpense: "No expense activity yet for the selected filters.",
  emptyIncome: "No income activity yet for the selected filters.",
  transactionCount: (countLabel: string, count: number) =>
    `${countLabel} transaction${count === 1 ? "" : "s"}`,
},
```

- [ ] **Step 2: Expand `CategoryBreakdown` props for the category type switch**

In `src/components/category-breakdown.tsx`, change labels to:

```ts
labels: {
  description: string;
  empty: string;
  title: string;
  transactionCount: (countLabel: string, count: number) => string;
};
```

Add an optional `headerAction?: ReactNode` prop. Keep the component as one `ios-panel` with the title/description on the left and `headerAction` on the right. Keep the body as a link-based row list and do not add chart code.

- [ ] **Step 3: Replace home imports**

In `src/app/(app)/home/page.tsx`, remove:

```ts
import { RecentTransactions } from "@/components/recent-transactions";
import { TimeRangeSelector } from "@/components/time-range-selector";
import type { ReportTransaction } from "@/lib/reports/aggregate";
import { parseRangePreset } from "@/lib/range-preset";
import { queryDashboard } from "@/lib/reports/query-dashboard";
```

Add:

```ts
import { ReportRangeControls } from "@/components/report-range-controls";
import {
  parseReportRangeSearchParams,
  type ReportRangeSelection,
} from "@/lib/reports/report-range";
import { queryHomeReport } from "@/lib/reports/query-home-report";
```

- [ ] **Step 4: Add category type parsing and shared params**

In `src/app/(app)/home/page.tsx`, add:

```ts
function parseCategoryType(value: string | null) {
  return value === "income" ? "income" : "expense";
}

function buildSharedParams(range: ReportRangeSelection, perspective: string) {
  const params = new URLSearchParams();

  params.set("mode", range.mode);
  params.set("month", range.month);
  params.set("year", range.year);

  if (perspective !== "household") {
    params.set("perspective", perspective);
  }

  return params;
}
```

- [ ] **Step 5: Update home query and header controls**

In `HomePage`, replace range parsing and query with:

```ts
const now = new Date();
const rangeSelection = parseReportRangeSearchParams(
  {
    mode: readParam(resolvedSearchParams, "mode"),
    month: readParam(resolvedSearchParams, "month"),
    year: readParam(resolvedSearchParams, "year"),
  },
  now,
);
const perspective = parsePerspective(readParam(resolvedSearchParams, "perspective"));
const categoryType = parseCategoryType(readParam(resolvedSearchParams, "categoryType"));
const report = await queryHomeReport({
  currentMemberId: user.memberId,
  householdId: user.householdId,
  now,
  perspective,
  range: rangeSelection,
});
const sharedParams = buildSharedParams(report.range, perspective);
const recordsHref = buildPageHref("/records", sharedParams);
const addHref = buildPageHref("/add", sharedParams);
const activeCategories = report.categories[categoryType];
```

Replace `<TimeRangeSelector labels={messages.range} />` with:

```tsx
<ReportRangeControls
  labels={messages.home.range}
  rangeOptions={report.rangeOptions}
  selection={report.range}
/>
```

- [ ] **Step 6: Update summary and trend references**

Replace all `dashboard` references with `report`.

For `TrendChart`, use:

```tsx
points={report.trend.points}
granularity={report.trend.granularity}
```

Keep the `getPointHref` logic with `from` and `to`.

- [ ] **Step 7: Replace category section with type switch and drill-down**

Replace the existing `CategoryBreakdown` usage with one non-nested panel. Put the expense/income switch in `CategoryBreakdown`'s `headerAction` prop:

```tsx
<CategoryBreakdown
  getCategoryHref={(item) =>
    buildPageHref("/records", sharedParams, {
      category: item.categoryId,
      type: categoryType,
    })
  }
  headerAction={
    <div className="grid grid-cols-2 gap-1 rounded-full bg-stone-100 p-1">
      {(["expense", "income"] as const).map((type) => (
        <Link
          aria-current={categoryType === type ? "true" : undefined}
          className={`rounded-full px-4 py-2 text-sm font-semibold transition ${
            categoryType === type
              ? "bg-white text-stone-950 shadow-sm"
              : "text-stone-500 hover:bg-white/70 hover:text-stone-800"
          }`}
          href={buildPageHref("/home", sharedParams, {
            categoryType: type === "income" ? "income" : undefined,
          })}
          key={type}
          scroll={false}
        >
          {type === "expense"
            ? messages.home.categories.expenseTab
            : messages.home.categories.incomeTab}
        </Link>
      ))}
    </div>
  }
  items={activeCategories.items}
  labels={{
    description:
      categoryType === "expense"
        ? messages.home.categories.expenseDescription
        : messages.home.categories.incomeDescription,
    empty:
      categoryType === "expense"
        ? messages.home.categories.emptyExpense
        : messages.home.categories.emptyIncome,
    title: messages.home.categories.title,
    transactionCount: messages.home.categories.transactionCount,
  }}
  locale={locale}
  totalExpenseLabel={(amountFen) => formatFen(amountFen)}
/>
```

Do not ship card nesting.

- [ ] **Step 8: Remove recent transactions section**

Delete the final `<RecentTransactions ... />` block from `src/app/(app)/home/page.tsx`.

- [ ] **Step 9: Update mocked home report data in integration tests**

In `tests/integration/records-page-and-actions.test.ts` and `tests/integration/ops-instrumentation.test.ts`, replace `queryDashboardMock` with `queryHomeReportMock`, module path `@/lib/reports/query-home-report`, and mocked report shape:

```ts
queryHomeReportMock.mockResolvedValue({
  categories: {
    expense: { items: [], totalFen: 0 },
    income: { items: [], totalFen: 0 },
  },
  range: {
    from: new Date("2026-03-31T16:00:00.000Z"),
    mode: "month",
    month: "2026-04",
    to: new Date("2026-04-30T15:59:59.999Z"),
    year: "2026",
  },
  rangeOptions: {
    months: ["2026-04"],
    years: ["2026"],
  },
  summary: {
    expenseFen: 0,
    incomeFen: 0,
    netFen: 0,
    transactionCount: 0,
  },
  trend: {
    granularity: "day",
    points: [],
  },
});
```

- [ ] **Step 10: Run focused home and mocked page tests**

Run:

```powershell
npm run test:integration -- tests/integration/records-page-and-actions.test.ts tests/integration/ops-instrumentation.test.ts
```

Expected: PASS.

- [ ] **Step 11: Commit Task 5**

```powershell
git add src/app/(app)/home/page.tsx src/components/category-breakdown.tsx src/lib/i18n.ts tests/integration/records-page-and-actions.test.ts tests/integration/ops-instrumentation.test.ts
git commit -m "v1.10.0 合并首页报表界面" -m "首页使用统一报表查询和月年全部控件，移除近期记录并加入收入支出分类切换。"
```

---

### Task 6: Remove Reports Route, Navigation Item, and Dead Report UI

**Files:**
- Delete: `src/app/(app)/reports/page.tsx`
- Delete if no imports remain: `src/lib/reports/query-dashboard.ts`
- Delete if no imports remain: `src/lib/reports/query-financial-report.ts`
- Delete: `src/components/report-category-pie.tsx`
- Delete: `src/lib/reports/display.ts`
- Delete: `tests/unit/report-category-pie.test.tsx`
- Delete: `tests/unit/report-display.test.ts`
- Modify: `src/app/(app)/records/page.tsx`
- Modify: `src/components/bottom-nav.tsx`
- Modify: `src/components/desktop-nav.tsx`
- Modify: `src/lib/i18n.ts`
- Modify: `tests/unit/i18n.test.ts`
- Modify: `tests/unit/navigation-version-marker.test.tsx`
- Modify: `tests/integration/app-route-stubs.test.ts`

- [ ] **Step 1: Update navigation tests to expect three items**

In `tests/unit/navigation-version-marker.test.tsx`, replace report assertions:

```ts
expect(desktopMarkup).not.toContain("报表");
expect(mobileMarkup).not.toContain("报表");
expect(desktopMarkup).toContain("首页");
expect(desktopMarkup).toContain("记一笔");
expect(desktopMarkup).toContain("记录");
```

In `tests/unit/i18n.test.ts`, remove assertions for `nav.reports` and `reports.title`. Add:

```ts
expect(getMessages("zh-CN").home.range.month).toBe("月");
expect(getMessages("zh-CN").home.categories.expenseTab).toBe("支出");
expect(getMessages("en-US").home.range.month).toBe("Month");
expect(getMessages("en-US").home.categories.incomeTab).toBe("Income");
```

In `tests/integration/app-route-stubs.test.ts`, replace:

```ts
expect(existsSync(path.resolve(process.cwd(), "src/app/(app)/reports/page.tsx"))).toBe(true);
```

with:

```ts
expect(existsSync(path.resolve(process.cwd(), "src/app/(app)/reports/page.tsx"))).toBe(false);
```

- [ ] **Step 2: Run navigation and route tests to verify they fail**

Run:

```powershell
npm run test:unit -- tests/unit/i18n.test.ts tests/unit/navigation-version-marker.test.tsx
npm run test:integration -- tests/integration/app-route-stubs.test.ts
```

Expected: FAIL because reports navigation and route still exist.

- [ ] **Step 3: Remove reports nav items**

In `src/components/bottom-nav.tsx`, change import:

```ts
import { Home, List, PlusCircle, type LucideIcon } from "lucide-react";
```

Change `NavItem` to:

```ts
type NavItem = {
  href: "/home" | "/add" | "/records";
  label: string;
  Icon: LucideIcon;
};
```

Change `items` to:

```ts
const items: NavItem[] = [
  { href: "/home", label: labels.nav.home, Icon: Home },
  { href: "/add", label: labels.nav.add, Icon: PlusCircle },
  { href: "/records", label: labels.nav.records, Icon: List },
];
```

Change the mobile grid from `grid-cols-4` to `grid-cols-3`.

Repeat the same item/import/type changes in `src/components/desktop-nav.tsx`.

- [ ] **Step 4: Remove report route and unused report-only files**

Delete:

```text
src/app/(app)/reports/page.tsx
src/lib/reports/query-dashboard.ts
src/lib/reports/query-financial-report.ts
src/components/report-category-pie.tsx
src/lib/reports/display.ts
tests/unit/report-category-pie.test.tsx
tests/unit/report-display.test.ts
```

- [ ] **Step 5: Remove report navigation and standalone report messages**

In `src/app/(app)/records/page.tsx`, change the range control labels from `messages.reports.range` to `messages.home.range`.

In `src/lib/i18n.ts`, remove `nav.reports` from both locales.

Remove the top-level `reports` object from both locales after all component imports have been migrated to `home.range` and `home.categories`.

- [ ] **Step 6: Run navigation and route tests to verify they pass**

Run:

```powershell
npm run test:unit -- tests/unit/i18n.test.ts tests/unit/navigation-version-marker.test.tsx
npm run test:integration -- tests/integration/app-route-stubs.test.ts
```

Expected: PASS.

- [ ] **Step 7: Search for remaining reports route references**

Run:

```powershell
rg -n "\"/reports\"|nav\\.reports|messages\\.reports|ReportCategoryPie|buildReportCategoryDisplayItems|queryFinancialReport|queryDashboard" src tests
```

Expected: no matches. If matches remain in tests for deleted files, delete or update those tests in this task.

- [ ] **Step 8: Commit Task 6**

```powershell
git add src/app/(app)/reports/page.tsx src/lib/reports/query-dashboard.ts src/lib/reports/query-financial-report.ts src/components/report-category-pie.tsx src/lib/reports/display.ts tests/unit/report-category-pie.test.tsx tests/unit/report-display.test.ts src/app/(app)/records/page.tsx src/components/bottom-nav.tsx src/components/desktop-nav.tsx src/lib/i18n.ts tests/unit/i18n.test.ts tests/unit/navigation-version-marker.test.tsx tests/integration/app-route-stubs.test.ts
git commit -m "v1.10.0 移除独立报表入口" -m "删除报表路由和导航项，清理报表专用组件、文案和测试引用。"
```

---

### Task 7: E2E Flow Updates

**Files:**
- Modify: `tests/e2e/filter-navigation.spec.ts`
- Modify: `tests/e2e/home-drilldown.spec.ts`
- Modify: `tests/e2e/create-expense.spec.ts`
- Modify: `tests/e2e/ui-layout.spec.ts`

- [ ] **Step 1: Update filter navigation e2e URLs**

In `tests/e2e/filter-navigation.spec.ts`, replace:

```ts
await page.goto("/home?perspective=spouse&range=last-30-days");
await expect(page).toHaveURL(/range=last-30-days/);
```

with:

```ts
await page.goto("/home?perspective=spouse&mode=month&month=2026-05&year=2026");
await expect(page).toHaveURL(/perspective=spouse/);
await expect(page).toHaveURL(/mode=month/);
await expect(page).toHaveURL(/month=2026-05/);
await expect(page).toHaveURL(/year=2026/);
```

Update subsequent URL assertions to check `mode`, `month`, and `year`, and remove any `range` checks.

- [ ] **Step 2: Update home drill-down e2e**

In `tests/e2e/home-drilldown.spec.ts`, replace:

```ts
await page.goto("/home?perspective=spouse&range=last-30-days");
```

with a date based on the inserted transaction if the test uses current time, or a fixed current test month if seed/test clock already makes that stable:

```ts
await page.goto("/home?perspective=spouse&mode=month");
```

After clicking the expense summary link, assert:

```ts
expect(recordsUrl.searchParams.get("perspective")).toBe("spouse");
expect(recordsUrl.searchParams.get("mode")).toBe("month");
expect(recordsUrl.searchParams.get("type")).toBe("expense");
```

Do not assert an exact `month` if the test creates records using current date and the app fills the current Shanghai month.

- [ ] **Step 3: Update create expense e2e**

In `tests/e2e/create-expense.spec.ts`, replace `/add?perspective=spouse&range=last-30-days` with:

```ts
await page.goto("/add?perspective=spouse&mode=month");
```

After save, assert:

```ts
await expect(page).toHaveURL(/mode=month/);
await expect(page).not.toHaveURL(/range=/);
```

- [ ] **Step 4: Update UI layout e2e**

In `tests/e2e/ui-layout.spec.ts`, replace:

```ts
await page.goto("/home?range=last-30-days");
```

with:

```ts
await page.goto("/home?mode=month");
```

- [ ] **Step 5: Run focused e2e tests**

Run:

```powershell
npm run test:e2e -- tests/e2e/filter-navigation.spec.ts tests/e2e/home-drilldown.spec.ts tests/e2e/create-expense.spec.ts tests/e2e/ui-layout.spec.ts
```

Expected: PASS. If Playwright reports missing database env, start the development database with `.\ops\podman\compose.ps1 -f podman-compose.dev.yml up -d db`, run `npm run prisma:seed`, and rerun the same command.

- [ ] **Step 6: Commit Task 7**

```powershell
git add tests/e2e/filter-navigation.spec.ts tests/e2e/home-drilldown.spec.ts tests/e2e/create-expense.spec.ts tests/e2e/ui-layout.spec.ts
git commit -m "v1.10.0 更新合并后端到端流程" -m "端到端用例改用月年全部范围并验证三项导航和首页钻取。"
```

---

### Task 8: Cleanup, Dead Code Scan, and Full Verification

**Files:**
- Delete if unused: `src/components/time-range-selector.tsx`
- Delete if unused: `src/components/recent-transactions.tsx`
- Delete if unused: `src/lib/range-preset.ts`
- Delete if unused: `src/lib/time-range.ts`
- Delete if unused: `tests/unit/time-range.test.ts`
- Modify any test file still referencing removed shortcut range params.

- [ ] **Step 1: Scan for old shortcut range and reports references**

Run:

```powershell
rg -n "range=last|range=this-month|last-7-days|last-30-days|last-12-months|TimeRangeSelector|parseRangePreset|RangePreset|getRangeBounds|RecentTransactions|\"/reports\"|messages\\.reports|nav\\.reports|queryDashboard|queryFinancialReport" src tests
```

Expected: no matches, except `src/lib/time-range.ts` and `tests/unit/time-range.test.ts` if the old helper is still intentionally retained.

- [ ] **Step 2: Delete old shortcut range files if no app code imports them**

If Step 1 shows no app imports for old range helpers, delete:

```text
src/lib/range-preset.ts
src/lib/time-range.ts
tests/unit/time-range.test.ts
src/components/time-range-selector.tsx
src/components/recent-transactions.tsx
```

If Step 1 shows valid remaining app imports, keep only the imported files and update this task's `git add` list to match actual deletions.

- [ ] **Step 3: Run static and targeted validation**

Run:

```powershell
npm run lint
npm run test:unit
npm run test:integration
npm run test:e2e
```

Expected: all commands PASS.

- [ ] **Step 4: Run security review scans**

Run:

```powershell
git status --short
git diff --stat origin/master...HEAD
rg -n "AUTH_SECRET|NEXTAUTH_SECRET|POSTGRES_PASSWORD|DATABASE_URL|NEXT_ALLOWED_DEV_ORIGINS|APP_BASE_PATH|frp|nginx|ECS|password|secret|token|https?://|\\b\\d{1,3}(\\.\\d{1,3}){3}\\b" src tests docs package.json package-lock.json
rg -n "deletedAt|householdId|memberId|sourceFingerprint|amountFen|Asia/Shanghai" src tests prisma
```

Expected:

- First scan has no new real credentials, real production hostnames, public IPs, private service URLs, or private entrypoint details. Package registry URLs in `package-lock.json` are acceptable existing dependency metadata.
- Second scan shows unified queries still scope by `householdId`, derive member scope from session inputs, use `deletedAt: null`, preserve `amountFen`, and keep `Asia/Shanghai` range math.

- [ ] **Step 5: Commit Task 8 cleanup**

```powershell
git add src tests docs package.json package-lock.json
git commit -m "v1.10.0 清理合并后遗留代码" -m "删除旧快捷范围和报表遗留引用，并完成合并后全量验证。"
```

- [ ] **Step 6: Final branch readiness checks**

Run:

```powershell
git fetch origin master
git branch --show-current
git rev-list --left-right --count origin/master...HEAD
git status --short
```

Expected:

- Current branch is `master`.
- Worktree is clean.
- Local branch is ahead of `origin/master` by the expected feature commits and not behind.

Do not push or restart production if any verification command failed, if the branch is not `master`, if the worktree is dirty with unreviewed files, or if the security review finds a blocking issue.

---

## Self-Review

**Spec coverage:** Covered `/home` as the only overview entry, deletion of `/reports`, three navigation items, shared month/year/all range, `perspective`, `categoryType`, summary/trend/category drill-down, records `from/to` priority, `/add` default current time, i18n sync, tests, and security checks.

**Placeholder scan:** No pending placeholder markers or incomplete task descriptions remain.

**Type consistency:** Shared range types are `ReportRangeMode`, `ReportRangeSelection`, `ReportRangeOptions`, and `ReportRange`. The unified query is consistently named `queryHomeReport`. The unified report shape is consistently named `HomeReport`.
