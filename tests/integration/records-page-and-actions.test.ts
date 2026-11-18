import { Children, createElement, type ComponentProps, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { formatLocaleNumber, type Locale } from "@/lib/i18n";
import { formatFen } from "@/lib/money";
import { createRecordSearchToken } from "@/lib/records/search-token";
import { buildReportAnalytics } from "@/lib/reports/analytics";
import type { HomeReport } from "@/lib/reports/aggregate";
import { buildMonthlyBalanceTrend } from "@/lib/reports/balance-trend";

type DrawerProps = ComponentProps<typeof import("@/components/transaction-editor-drawer").TransactionEditorDrawer>;

const tokenContext = { householdId: "household-1", memberId: "member-1", scope: { kind: "household" as const } };

const {
  categoryFindManyMock,
  getServerLocaleMock,
  householdFindUniqueOrThrowMock,
  householdMemberFindManyMock,
  listRecordsMock,
  queryHomeReportMock,
  queryReportAnalyticsMock,
  reportRangeControlsMock,
  redirectMock,
  replaceMock,
  pushMock,
  requireAppSessionMock,
  transactionEditorDrawerMock,
  transactionFindFirstMock,
  updateTransactionMock,
  usePathnameMock,
  useSearchParamsMock,
} = vi.hoisted(() => ({
  categoryFindManyMock: vi.fn(),
  getServerLocaleMock: vi.fn(),
  householdFindUniqueOrThrowMock: vi.fn(),
  householdMemberFindManyMock: vi.fn(),
  listRecordsMock: vi.fn(),
  queryHomeReportMock: vi.fn(),
  queryReportAnalyticsMock: vi.fn(),
  reportRangeControlsMock: vi.fn(() =>
    createElement("div", { "data-testid": "report-range-controls" }),
  ),
  redirectMock: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  replaceMock: vi.fn(),
  pushMock: vi.fn(),
  requireAppSessionMock: vi.fn(),
  transactionEditorDrawerMock: vi.fn((props: DrawerProps) =>
    createElement("div", {
      "data-record-id": props.record.id,
      "data-testid": "record-drawer",
    }),
  ),
  transactionFindFirstMock: vi.fn(),
  updateTransactionMock: vi.fn(),
  usePathnameMock: vi.fn(() => "/records"),
  useSearchParamsMock: vi.fn(() => new URLSearchParams()),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, prefetch: _prefetch, scroll: _scroll, ...props }: React.ComponentProps<"a"> & {
    prefetch?: boolean;
    scroll?: boolean;
  }) =>
    createElement("a", { href, ...props }, children),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
  usePathname: usePathnameMock,
  useRouter: () => ({
    push: pushMock,
    replace: replaceMock,
  }),
  useSearchParams: useSearchParamsMock,
}));

vi.mock("next/headers", () => ({
  cookies: async () => ({
    get: () => undefined,
  }),
}));

vi.mock("@/lib/auth/session", () => ({
  requireAppSession: requireAppSessionMock,
}));

vi.mock("@/lib/auth/household-context", () => ({
  resolveHouseholdContext: async (_client: unknown, session: { householdId: string; memberId: string }) => ({ ...session, ledgerId: "ledger-1", ledgerName: "Default", role: "OWNER", userId: "user-1" }),
}));

vi.mock("@/lib/i18n-server", () => ({
  getServerLocale: getServerLocaleMock,
}));

vi.mock("@/lib/db", () => ({
  db: {
    ledger: { findMany: async () => [{ id: "ledger-1", name: "Default", isDefault: true, archivedAt: null, acceptsLegacyDrafts: true }] },
    category: { findMany: categoryFindManyMock },
    household: { findUniqueOrThrow: householdFindUniqueOrThrowMock },
    householdMember: { findMany: householdMemberFindManyMock },
    transaction: { findFirst: transactionFindFirstMock },
  },
}));

vi.mock("@/lib/records/list-records", () => ({
  listRecords: listRecordsMock,
  RECORDS_PAGE_SIZE: 100,
}));

vi.mock("@/lib/reports/query-home-report", () => ({
  queryHomeReport: queryHomeReportMock,
}));

vi.mock("@/lib/reports/query-report-analytics", () => ({
  queryReportAnalytics: queryReportAnalyticsMock,
}));

vi.mock("@/lib/transactions/update-transaction", () => ({
  updateTransaction: updateTransactionMock,
}));

vi.mock("@/components/records-filter-bar", () => ({
  RecordsFilterBar: () => createElement("div", { "data-testid": "records-filter-bar" }),
}));

vi.mock("@/components/report-range-controls", () => ({
  ReportRangeControls: reportRangeControlsMock,
}));

vi.mock("@/components/transaction-editor-drawer", () => ({
  TransactionEditorDrawer: transactionEditorDrawerMock,
}));

// motion 组件在 node 环境的 renderToStaticMarkup 下会创建依赖 DOM 的 projection node，
// 与真实 Next.js SSR 无关，因此与上面对展示组件的处理保持一致，替换为静态标签。
vi.mock("@/components/motion-primitives", () => {
  type RevealMockProps = {
    as?: keyof HTMLElementTagNameMap;
    children?: ReactNode;
    className?: string;
  };

  type RevealGroupMockProps = RevealMockProps & {
    itemAs?: keyof HTMLElementTagNameMap;
    itemClassName?: string;
  };

  return {
    CountUp: ({
      className,
      locale,
      value,
      variant,
    }: {
      className?: string;
      locale: Locale;
      value: number;
      variant: "fen" | "integer";
    }) =>
      createElement(
        "span",
        { className },
        variant === "fen"
          ? `${value < 0 ? "-" : ""}${formatFen(Math.abs(value))}`
          : formatLocaleNumber(value, locale),
      ),
    Reveal: ({ as = "div", children, className }: RevealMockProps) =>
      createElement(as, { className }, children),
    RevealGroup: ({
      as = "div",
      children,
      className,
      itemAs = "div",
      itemClassName,
    }: RevealGroupMockProps) =>
      createElement(
        as,
        { className },
        Children.map(children, (child, index) =>
          createElement(itemAs, { className: itemClassName, key: index }, child),
        ),
      ),
  };
});

const initialRecordEditorState = {
  status: "idle" as const,
};

function mockHomeReport(report: Omit<HomeReport, "balanceTrend">) {
  queryHomeReportMock.mockResolvedValue({
    ...report,
    balanceTrend: buildMonthlyBalanceTrend({ trend: report.trend, range: report.range }),
  });
}

function primePageMocks() {
  queryReportAnalyticsMock.mockResolvedValue(buildReportAnalytics({
    range: { from: "2026-04-01", to: "2026-04-26" },
    previousRange: { from: "2026-03-01", to: "2026-03-26" },
    yearAgoRange: { from: "2025-04-01", to: "2025-04-26" },
    firstRecordedDate: null,
    categories: [],
    days: [],
    categoryMonths: [],
    distribution: { buckets: [], expenseCount: 0, totalFen: 0, medianFen: null, maxFen: null, topFiveAmountFen: 0 },
  }));
  requireAppSessionMock.mockResolvedValue({
    householdId: "household-1",
    id: "user-1",
    memberId: "member-1",
  });
  householdFindUniqueOrThrowMock.mockResolvedValue({ timezone: "Asia/Shanghai" });
  getServerLocaleMock.mockResolvedValue("zh-CN");
  categoryFindManyMock.mockResolvedValue([
    { id: "category-expense", name: "Dining", type: "EXPENSE" },
    { id: "category-income", name: "Salary", type: "INCOME" },
  ]);
  householdMemberFindManyMock.mockResolvedValue([
    { id: "member-1", memberName: "Me", leftAt: null, user: { status: "ACTIVE" } },
    { id: "member-2", memberName: "Spouse", leftAt: null, user: { status: "ACTIVE" } },
  ]);
  listRecordsMock.mockResolvedValue([]);
  mockHomeReport({
    categories: {
      expense: { items: [], totalFen: 0 },
      income: { items: [], totalFen: 0 },
    },
    range: {
      from: new Date("2026-04-19T16:00:00.000Z"),
      mode: "month",
      month: "2026-04",
      to: new Date("2026-04-26T15:59:59.999Z"),
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
  transactionFindFirstMock.mockResolvedValue({ occurredAt: new Date("2026-04-01T00:00:00.000Z") });
}

function buildRecord(id: string, index: number) {
  return {
    id,
    ledgerId: "ledger-1", ledgerName: "Default", ledgerArchivedAt: null,
    amountFen: 1000 + index,
    actorMemberId: "member-1",
    actorMemberName: "老公",
    categoryId: "category-expense",
    categoryName: "Dining",
    createdByMemberId: "member-1",
    createdByMemberName: "老公",
    note: null,
    occurredAt: new Date(`2026-04-${String((index % 25) + 1).padStart(2, "0")}T00:30:00.000Z`),
    type: "expense",
  };
}

describe("AppFiltersProvider navigation semantics", () => {
  beforeEach(() => {
    vi.resetModules();
    // This SSR harness checks URL semantics; real client transitions are covered by e2e.
    vi.doMock("react", async () => ({
      ...await vi.importActual<typeof import("react")>("react"),
      useTransition: () => [false, (work: () => void) => work()],
    }));
    replaceMock.mockReset();
    pushMock.mockReset();
    usePathnameMock.mockReset();
    useSearchParamsMock.mockReset();
    vi.unstubAllGlobals();
    usePathnameMock.mockReturnValue("/records");
    useSearchParamsMock.mockReturnValue(new URLSearchParams());
  });

  afterEach(() => { vi.doUnmock("react"); });

  it("keeps the time range and drops legacy member filters when navigating", async () => {
    const capturedContext: {
      current: ReturnType<typeof import("@/components/app-filters-provider").useAppFilters> | null;
    } = { current: null };
    const staleQuery =
      "perspective=me&mode=month&month=2026-04&year=2026&page=3&from=2026-04-01T00%3A00%3A00.000Z&to=2026-04-30T23%3A59%3A59.999Z&record=record-1";

    useSearchParamsMock.mockReturnValue(new URLSearchParams(staleQuery));
    vi.stubGlobal("window", { location: { search: `?${staleQuery}` } });

    const { AppFiltersProvider, useAppFilters } = await import("@/components/app-filters-provider");

    function Probe() {
      capturedContext.current = useAppFilters();
      return createElement("div");
    }

    renderToStaticMarkup(
      createElement(AppFiltersProvider, { locale: "zh-CN" } as ComponentProps<typeof AppFiltersProvider>, createElement(Probe)),
    );

    const context = capturedContext.current;

    if (!context) {
      throw new Error("Expected app filters context");
    }

    expect(context.buildHref("/home")).toBe("/home?mode=month&month=2026-04&year=2026");
    context.navigateTo("/add");

    expect(pushMock).toHaveBeenCalledWith("/add?mode=month&month=2026-04&year=2026");
  });
});

describe("Records page", () => {
  it.each([null, new Date("2026-10-21T00:00:00Z")])("edits the record's original ledger from the family view (archived: %s)", async (ledgerArchivedAt) => {
    const record = { ...buildRecord("other-ledger-record", 0), ledgerId: "ledger-2", ledgerName: "Travel", ledgerArchivedAt };
    listRecordsMock.mockResolvedValue([record]);
    const { default: RecordsPage } = await import("@/app/(app)/records/page");
    renderToStaticMarkup(materializePageView(await RecordsPage({ searchParams: Promise.resolve({ ledger: "all", record: record.id }) })));
    const props = transactionEditorDrawerMock.mock.calls[0]?.[0];
    expect(props.context).toEqual({ householdId: "household-1", memberId: "member-1", ledgerId: "ledger-2" });
    expect(props.readOnly).toBe(ledgerArchivedAt !== null);
  });
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-04-26T04:00:00.000Z"));
    vi.stubEnv("AUTH_SECRET", "record-search-test-secret");
    vi.resetModules();
    redirectMock.mockClear();
    requireAppSessionMock.mockReset();
    getServerLocaleMock.mockReset();
    householdFindUniqueOrThrowMock.mockReset();
    categoryFindManyMock.mockReset();
    householdMemberFindManyMock.mockReset();
    listRecordsMock.mockReset();
    transactionFindFirstMock.mockReset();
    transactionEditorDrawerMock.mockClear();
    reportRangeControlsMock.mockClear();
    primePageMocks();
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllEnvs();
  });

  it("uses an explicit month range without redirecting to the recent default", async () => {
    const { default: RecordsPage } = await import("@/app/(app)/records/page");

    renderToStaticMarkup(
      materializePageView(await RecordsPage({
        searchParams: Promise.resolve({ mode: "month", month: "2026-04", year: "2026" }),
      })),
    );

    expect(redirectMock).not.toHaveBeenCalled();
    expect(listRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rangeBounds: {
          from: new Date("2026-03-31T16:00:00.000Z"),
          to: new Date("2026-04-26T15:59:59.999Z"),
        },
      }),
    );
    expect(reportRangeControlsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rangeOptions: {
          months: ["2026-04"],
          years: ["2026"],
        },
        selection: {
          mode: "month",
          month: "2026-04",
          year: "2026",
        },
      }),
      undefined,
    );
  });

  it("passes supported amount sort options to the records query", async () => {
    const { default: RecordsPage } = await import("@/app/(app)/records/page");

    renderToStaticMarkup(
      materializePageView(await RecordsPage({
        searchParams: Promise.resolve({
          mode: "month",
          month: "2026-04",
          sort: "amount-desc",
          year: "2026",
        }),
      })),
    );

    expect(listRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        sort: "amount-desc",
      }),
    );
  });

  it("uses custom calendar dates for records and preserves them in the range control", async () => {
    const { default: RecordsPage } = await import("@/app/(app)/records/page");

    renderToStaticMarkup(
      materializePageView(await RecordsPage({
        searchParams: Promise.resolve({
          mode: "custom",
          month: "2026-04",
          year: "2026",
          start: "2026-04-05",
          end: "2026-04-20",
        }),
      })),
    );

    expect(listRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rangeBounds: {
          from: new Date("2026-04-04T16:00:00.000Z"),
          to: new Date("2026-04-20T15:59:59.999Z"),
        },
      }),
    );
    expect(reportRangeControlsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        selection: expect.objectContaining({
          mode: "custom",
          start: "2026-04-05",
          end: "2026-04-20",
        }),
      }),
      undefined,
    );
  });

  it("passes a normalized search and current-locale category candidates to the records query", async () => {
    const { default: RecordsPage } = await import("@/app/(app)/records/page");
    const zhSearchToken = createRecordSearchToken("餐饮", tokenContext);

    materializePageView(await RecordsPage({
      searchParams: Promise.resolve({
        mode: "month",
        month: "2026-04",
        search: zhSearchToken,
        year: "2026",
      }),
    }));

    expect(listRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        search: "餐饮",
        searchCategoryIds: ["category-expense"],
      }),
    );

    getServerLocaleMock.mockResolvedValue("en-US");
    listRecordsMock.mockClear();
    const enSearchToken = createRecordSearchToken("Dining", tokenContext);

    materializePageView(await RecordsPage({
      searchParams: Promise.resolve({
        mode: "month",
        month: "2026-04",
        search: enSearchToken,
        year: "2026",
      }),
    }));

    expect(listRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        search: "Dining",
        searchCategoryIds: ["category-expense"],
      }),
    );
  });

  it("keeps the search parameter in pagination links", async () => {
    const searchToken = createRecordSearchToken("Dinner", tokenContext);
    listRecordsMock.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => buildRecord(`record-${index + 1}`, index)),
    );
    const { default: RecordsPage } = await import("@/app/(app)/records/page");
    const markup = renderToStaticMarkup(
      materializePageView(await RecordsPage({
        searchParams: Promise.resolve({
          mode: "month",
          month: "2026-04",
          search: searchToken,
          year: "2026",
        }),
      })),
    );

    expect(markup).toContain(
      `/records?mode=month&amp;month=2026-04&amp;search=${searchToken}&amp;year=2026&amp;ledger=all&amp;entryLedger=ledger-1&amp;page=2`,
    );
    expect(markup).toContain(
      `/records?mode=month&amp;month=2026-04&amp;search=${searchToken}&amp;year=2026&amp;ledger=all&amp;entryLedger=ledger-1&amp;record=record-1`,
    );
  });

  it("does not reopen the drawer for a selected record that is outside the filtered result set", async () => {
    listRecordsMock.mockResolvedValueOnce([
      {
        id: "record-1",
        ledgerId: "ledger-1", ledgerName: "Default", ledgerArchivedAt: null,
        amountFen: 1860,
        actorMemberId: "member-1",
        actorMemberName: "Me",
        categoryId: "category-expense",
        categoryName: "Dining",
        createdByMemberId: "member-1",
        createdByMemberName: "Me",
        note: "Lunch",
        occurredAt: new Date("2026-04-26T00:30:00.000Z"),
        type: "expense",
      },
    ]).mockResolvedValueOnce([]);
    transactionFindFirstMock.mockResolvedValue({
      id: "record-2",
      ledgerId: "ledger-1", ledgerName: "Default", ledgerArchivedAt: null,
      amountFen: 500000,
      actorMemberId: "member-2",
      categoryId: "category-income",
      createdByMember: { memberName: "Spouse" },
      note: "Salary",
      occurredAt: new Date("2026-04-25T01:45:00.000Z"),
      type: "INCOME",
    });

    const { default: RecordsPage } = await import("@/app/(app)/records/page");
    const markup = renderToStaticMarkup(
      materializePageView(await RecordsPage({
        searchParams: Promise.resolve({
          mode: "month",
          month: "2026-04",
          year: "2026",
          type: "expense",
          record: "record-2",
        }),
      })),
    );

    expect(markup).not.toContain("data-testid=\"record-drawer\"");
    expect(transactionEditorDrawerMock).not.toHaveBeenCalled();
  });

  it("keeps the drawer open when the selected record still matches the filters", async () => {
    const searchToken = createRecordSearchToken("Lunch", tokenContext);
    const matchingRecord = {
      id: "record-1",
      ledgerId: "ledger-1", ledgerName: "Default", ledgerArchivedAt: null,
      amountFen: 1860,
      actorMemberId: "member-1",
      actorMemberName: "Me",
      categoryId: "category-expense",
      categoryName: "Dining",
      createdByMemberId: "member-1",
      createdByMemberName: "Me",
      note: "Lunch",
      occurredAt: new Date("2026-04-26T00:30:00.000Z"),
      type: "expense" as const,
    };
    listRecordsMock.mockResolvedValueOnce([matchingRecord]).mockResolvedValueOnce([matchingRecord]);

    const { default: RecordsPage } = await import("@/app/(app)/records/page");
    const markup = renderToStaticMarkup(
      materializePageView(await RecordsPage({
        searchParams: Promise.resolve({
          mode: "month",
          month: "2026-04",
          record: "record-1",
          search: searchToken,
          year: "2026",
        }),
      })),
    );

    expect(markup).toContain('data-testid="record-drawer"');
    expect(listRecordsMock).toHaveBeenLastCalledWith(
      expect.objectContaining({
        recordId: "record-1",
        search: "Lunch",
      }),
    );
  });

  it("passes only serializable editor labels to the record drawer", async () => {
    listRecordsMock.mockResolvedValue([
      {
        id: "record-1",
        ledgerId: "ledger-1", ledgerName: "Default", ledgerArchivedAt: null,
        amountFen: 1860,
        actorMemberId: "member-1",
        actorMemberName: "Me",
        categoryId: "category-expense",
        categoryName: "Dining",
        createdByMemberId: "member-1",
        createdByMemberName: "Me",
        note: "Lunch",
        occurredAt: new Date("2026-04-26T00:30:00.000Z"),
        type: "expense",
      },
    ]);
    transactionFindFirstMock
      .mockResolvedValueOnce({ occurredAt: new Date("2026-04-01T00:00:00.000Z") })
      .mockResolvedValueOnce({
        id: "record-1",
        ledgerId: "ledger-1", ledgerName: "Default", ledgerArchivedAt: null,
        amountFen: 1860,
        actorMemberId: "member-1",
        categoryId: "category-expense",
        createdByMember: { memberName: "Me" },
        note: "Lunch",
        occurredAt: new Date("2026-04-26T00:30:00.000Z"),
        type: "EXPENSE",
      });

    const { default: RecordsPage } = await import("@/app/(app)/records/page");

    renderToStaticMarkup(
      materializePageView(await RecordsPage({
        searchParams: Promise.resolve({
          mode: "month",
          month: "2026-04",
          year: "2026",
          record: "record-1",
        }),
      })),
    );

    const drawerProps = transactionEditorDrawerMock.mock.calls[0]?.[0];

    expect(drawerProps.record.createdByLabel).toEqual(expect.any(String));
    expect(drawerProps.record.createdByLabel).toContain("Me");
    expect(drawerProps.labels.editor).toEqual({
      deleteConfirm: expect.any(String),
      deleteRecord: expect.any(String),
      deleting: expect.any(String),
      saveChanges: expect.any(String),
      title: expect.any(String),
    });
    expect(Reflect.get(drawerProps.labels.editor, "createdBy")).toBeUndefined();
  });

  it("renders record rows with a note preview and compact summary fields", async () => {
    listRecordsMock.mockResolvedValue([
      {
        id: "record-1",
        ledgerId: "ledger-1", ledgerName: "Default", ledgerArchivedAt: null,
        amountFen: 1860,
        actorMemberId: "member-1",
        actorMemberName: "老公",
        categoryId: "category-expense",
        categoryName: "Dining",
        createdByMemberId: "member-2",
        createdByMemberName: "老婆",
        note: "Lunch with family",
        occurredAt: new Date("2026-04-26T00:30:00.000Z"),
        type: "expense",
      },
    ]);

    const { default: RecordsPage } = await import("@/app/(app)/records/page");
    const markup = renderToStaticMarkup(
      materializePageView(await RecordsPage({
        searchParams: Promise.resolve({ mode: "month", month: "2026-04", year: "2026" }),
      })),
    );

    expect(markup).toContain("-18.60");
    expect(markup).toContain("餐饮");
    expect(markup).toContain("老公");
    expect(markup).toContain("4月26日");
    expect(markup).toContain("Lunch with family");
    expect(markup).not.toContain("支出");
    expect(markup).not.toContain("创建人");
    expect(markup).not.toContain("老婆");
  });

  it("passes a drill-down bucket window through to the records query", async () => {
    const { default: RecordsPage } = await import("@/app/(app)/records/page");

    renderToStaticMarkup(
      materializePageView(await RecordsPage({
        searchParams: Promise.resolve({
          from: "2026-04-24T16:00:00.000Z",
          mode: "month",
          month: "2026-04",
          year: "2026",
          to: "2026-04-25T15:59:59.999Z",
        }),
      })),
    );

    expect(listRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rangeBounds: {
          from: new Date("2026-04-24T16:00:00.000Z"),
          to: new Date("2026-04-25T15:59:59.999Z"),
        },
      }),
    );
  });

  it("renders only one records page and links to the next page when more records exist", async () => {
    listRecordsMock.mockResolvedValue(
      Array.from({ length: 101 }, (_, index) => buildRecord(`record-${index + 1}`, index)),
    );
    const { default: RecordsPage } = await import("@/app/(app)/records/page");
    const markup = renderToStaticMarkup(
      materializePageView(await RecordsPage({
        searchParams: Promise.resolve({
          mode: "month",
          month: "2026-04",
          record: "record-from-old-page",
          sort: "amount-desc",
          type: "expense",
          year: "2026",
        }),
      })),
    );

    expect(listRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        limit: 101,
        offset: 0,
      }),
    );
    expect(markup).toContain("record-100");
    expect(markup).not.toContain("record-101");
    expect(markup).toContain("第 1 页");
    expect(markup).toContain("下一页");
    expect(markup).toContain(
      "/records?mode=month&amp;month=2026-04&amp;sort=amount-desc&amp;type=expense&amp;year=2026&amp;ledger=all&amp;entryLedger=ledger-1&amp;page=2",
    );
    expect(markup).not.toContain("record-from-old-page");
  });
});

describe("Home page trend drill-down", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "report-link-test-secret");
    vi.resetModules();
    requireAppSessionMock.mockReset();
    queryHomeReportMock.mockReset();
    queryReportAnalyticsMock.mockReset();
    primePageMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("links home summary cards and trend buckets to amount-desc records", async () => {
    mockHomeReport({
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
        expenseFen: 2500,
        incomeFen: 500000,
        netFen: 497500,
        transactionCount: 2,
      },
      trend: {
        granularity: "day",
        points: [
          {
            bucketEnd: new Date("2026-04-25T15:59:59.999Z"),
            bucketKey: "2026-04-25",
            bucketStart: new Date("2026-04-24T16:00:00.000Z"),
            expenseFen: 2500,
            incomeFen: 500000,
            label: "Apr 25",
            netFen: 497500,
            transactionCount: 2,
          },
        ],
      },
    });

    const { default: HomePage } = await import("@/app/(app)/home/page");
    const markup = renderToStaticMarkup(
      materializePageView(await HomePage({
        searchParams: Promise.resolve({ mode: "month", month: "2026-04", year: "2026" }),
      })),
    );

    expect(markup).toContain(
      "/records?mode=month&amp;month=2026-04&amp;year=2026&amp;ledger=all&amp;entryLedger=ledger-1&amp;sort=amount-desc&amp;type=income",
    );
    expect(markup).toContain(
      "/records?mode=month&amp;month=2026-04&amp;year=2026&amp;ledger=all&amp;entryLedger=ledger-1&amp;sort=amount-desc&amp;type=expense",
    );
    expect(markup).toContain(
      "/records?mode=month&amp;month=2026-04&amp;year=2026&amp;ledger=all&amp;entryLedger=ledger-1&amp;sort=amount-desc",
    );
    expect(markup).toContain('data-testid="trend-point"');
    expect(markup).toContain('data-testid="trend-date-picker"');
    expect(markup).toContain('type="range"');
    expect(markup).toContain("4月25日");
  });

  it("renders the dashboard with localized Chinese labels and category display names", async () => {
    mockHomeReport({
      categories: {
        expense: {
          items: [
            {
              amountFen: 1860,
              categoryId: "category-expense",
              categoryName: "Dining",
              share: 1,
              transactionCount: 1,
            },
          ],
          totalFen: 1860,
        },
        income: {
          items: [
            {
              amountFen: 500000,
              categoryId: "category-income",
              categoryName: "Salary",
              share: 1,
              transactionCount: 1,
            },
          ],
          totalFen: 500000,
        },
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
        expenseFen: 1860,
        incomeFen: 500000,
        netFen: 498140,
        transactionCount: 2,
      },
      trend: {
        granularity: "day",
        points: [
          {
            bucketEnd: new Date("2026-04-25T15:59:59.999Z"),
            bucketKey: "2026-04-25",
            bucketStart: new Date("2026-04-24T16:00:00.000Z"),
            expenseFen: 1860,
            incomeFen: 0,
            label: "Apr 25",
            netFen: -1860,
            transactionCount: 1,
          },
        ],
      },
    });

    const { default: HomePage } = await import("@/app/(app)/home/page");
    const markup = renderToStaticMarkup(
      materializePageView(await HomePage({
        searchParams: Promise.resolve({ mode: "month", month: "2026-04", year: "2026" }),
      })),
    );

    expect(markup).toContain("首页");
    expect(markup).toContain("查看");
    expect(markup).toContain("趋势");
    expect(markup).toContain("1 笔");
    expect(markup).toContain("4月25日");
    expect(markup).not.toContain("Apr 25");
    expect(markup).toContain("分类分析");
    expect(markup).toContain("支出");
    expect(markup).toContain("收入");
    expect(markup).toContain("餐饮");
    expect(markup).not.toContain('href="/add?');
    expect(markup).not.toContain("记一笔");
    expect(markup).not.toContain("近期记录");
    expect(markup).not.toContain("无备注");
    expect(markup).not.toContain("记账人");
  });

  it("links income category rows to income records with the shared report range", async () => {
    mockHomeReport({
      categories: {
        expense: { items: [], totalFen: 0 },
        income: {
          items: [
            {
              amountFen: 500000,
              categoryId: "category-income",
              categoryName: "Salary",
              share: 1,
              transactionCount: 1,
            },
          ],
          totalFen: 500000,
        },
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
        incomeFen: 500000,
        netFen: 500000,
        transactionCount: 1,
      },
      trend: {
        granularity: "day",
        points: [],
      },
    });

    const { default: HomePage } = await import("@/app/(app)/home/page");
    const markup = renderToStaticMarkup(
      materializePageView(await HomePage({
        searchParams: Promise.resolve({
          categoryType: "income",
          mode: "month",
          month: "2026-04",
          year: "2026",
        }),
      })),
    );

    expect(markup).toContain("收入");
    expect(markup).toContain("工资");
    expect(markup).toContain(
      "/records?mode=month&amp;month=2026-04&amp;year=2026&amp;ledger=all&amp;entryLedger=ledger-1&amp;sort=amount-desc&amp;category=category-income&amp;type=income",
    );
    expect(markup).not.toContain("近期记录");
  });
});

describe("submitRecordUpdate", () => {
  beforeEach(() => {
    vi.resetModules();
    redirectMock.mockClear();
    requireAppSessionMock.mockReset();
    updateTransactionMock.mockReset();
  });

  it("closes the drawer and removes legacy perspective after a successful update", async () => {
    requireAppSessionMock.mockResolvedValue({
      householdId: "household-1",
      id: "user-1",
      memberId: "member-1",
    });
    updateTransactionMock.mockResolvedValue({ id: "record-1" });

    const { submitRecordUpdate } = await import("@/app/(app)/records/actions");
    const formData = new FormData();
    formData.set("transactionId", "record-1");
    formData.set("type", "expense");
    formData.set("amount", "18.60");
    formData.set("categoryId", "category-expense");
    formData.set("actorMemberId", "member-1");
    formData.set("occurredAt", "2026-04-26T08:30");
    formData.set("note", "Lunch");
    formData.set(
      "returnTo",
      "/records?mode=month&month=2026-04&year=2026&type=expense&perspective=spouse&record=record-1",
    );

    await expect(submitRecordUpdate(initialRecordEditorState, formData)).rejects.toThrow(
      "REDIRECT:/records?mode=month&month=2026-04&year=2026&type=expense",
    );

    expect(redirectMock).toHaveBeenCalledWith(
      "/records?mode=month&month=2026-04&year=2026&type=expense",
    );
  });

  it("localizes update validation messages from the submitted locale", async () => {
    requireAppSessionMock.mockResolvedValue({
      householdId: "household-1",
      id: "user-1",
      memberId: "member-1",
    });
    updateTransactionMock.mockRejectedValue(
      new ZodError([{ code: "custom", message: "Select a category", path: ["categoryId"] }]),
    );

    const { submitRecordUpdate } = await import("@/app/(app)/records/actions");
    const formData = new FormData();
    formData.set("locale", "zh-CN");
    formData.set("returnTo", "/records?mode=month&month=2026-04&year=2026&record=record-1");

    await expect(submitRecordUpdate(initialRecordEditorState, formData)).resolves.toEqual({
      status: "error",
      message: "请选择分类",
    });
  });

  it("asks an old editor to refresh when its ledger context is missing", async () => {
    requireAppSessionMock.mockResolvedValue({ householdId: "household-1", id: "user-1", memberId: "member-1" });
    updateTransactionMock.mockRejectedValue(new ZodError([{ code: "custom", message: "Missing context", path: ["context"] }]));
    const { submitRecordUpdate } = await import("@/app/(app)/records/actions");
    const form = new FormData();
    form.set("locale", "zh-CN");
    await expect(submitRecordUpdate(initialRecordEditorState, form)).resolves.toEqual({ status: "error", message: "页面已更新，请刷新并选择账本。" });
  });
});

describe("submitRecordDelete", () => {
  beforeEach(() => {
    vi.resetModules();
    redirectMock.mockClear();
    requireAppSessionMock.mockReset();
  });

  it("uses the localized delete fallback for unknown thrown values", async () => {
    requireAppSessionMock.mockRejectedValue("database unavailable");

    const { submitRecordDelete } = await import("@/app/(app)/records/actions");
    const formData = new FormData();
    formData.set("locale", "zh-CN");
    formData.set("returnTo", "/records?mode=month&month=2026-04&year=2026&record=record-1");

    await expect(submitRecordDelete(initialRecordEditorState, formData)).resolves.toEqual({
      status: "error",
      message: "无法删除记录",
    });
  });
});

vi.mock("@/lib/encryption/request", () => ({
  getHouseholdEncryptionStatus: async () => ({ mode: "UNENCRYPTED", revision: 0, generation: null, keyVersion: 0, isOwner: false, operation: null }),
  withHouseholdEncryption: async (_input: unknown, work: () => Promise<unknown>) => work(),
  extractEncryption: (form: FormData) => { form.delete("__householdEncryption"); return undefined; },
}));

function materializePageView<T>(node: T): Exclude<T, null> {
  const element = node as unknown as { type: unknown; props: { data?: unknown } };
  return (typeof element?.type === "function" && Object.hasOwn(element.props, "data") ? element.type(element.props) : node) as Exclude<T, null>;
}
