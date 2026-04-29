import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";

const {
  categoryFindManyMock,
  householdFindUniqueOrThrowMock,
  householdMemberFindManyMock,
  listRecordsMock,
  queryDashboardMock,
  redirectMock,
  replaceMock,
  requireAppSessionMock,
  transactionEditorDrawerMock,
  transactionFindFirstMock,
  updateTransactionMock,
  usePathnameMock,
  useSearchParamsMock,
} = vi.hoisted(() => ({
  categoryFindManyMock: vi.fn(),
  householdFindUniqueOrThrowMock: vi.fn(),
  householdMemberFindManyMock: vi.fn(),
  listRecordsMock: vi.fn(),
  queryDashboardMock: vi.fn(),
  redirectMock: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  replaceMock: vi.fn(),
  requireAppSessionMock: vi.fn(),
  transactionEditorDrawerMock: vi.fn((props: { record: { id: string } }) =>
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
  default: ({ children, href, scroll: _scroll, ...props }: React.ComponentProps<"a"> & {
    scroll?: boolean;
  }) =>
    createElement("a", { href, ...props }, children),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
  usePathname: usePathnameMock,
  useRouter: () => ({
    push: vi.fn(),
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

vi.mock("@/lib/db", () => ({
  db: {
    category: { findMany: categoryFindManyMock },
    household: { findUniqueOrThrow: householdFindUniqueOrThrowMock },
    householdMember: { findMany: householdMemberFindManyMock },
    transaction: { findFirst: transactionFindFirstMock },
  },
}));

vi.mock("@/lib/records/list-records", () => ({
  listRecords: listRecordsMock,
}));

vi.mock("@/lib/reports/query-dashboard", () => ({
  queryDashboard: queryDashboardMock,
}));

vi.mock("@/lib/transactions/update-transaction", () => ({
  updateTransaction: updateTransactionMock,
}));

vi.mock("@/components/perspective-toggle", () => ({
  PerspectiveToggle: () => createElement("div", { "data-testid": "perspective-toggle" }),
}));

vi.mock("@/components/records-filter-bar", () => ({
  RecordsFilterBar: () => createElement("div", { "data-testid": "records-filter-bar" }),
}));

vi.mock("@/components/time-range-selector", () => ({
  TimeRangeSelector: () => createElement("div", { "data-testid": "time-range-selector" }),
}));

vi.mock("@/components/transaction-editor-drawer", () => ({
  TransactionEditorDrawer: transactionEditorDrawerMock,
}));

function primePageMocks() {
  requireAppSessionMock.mockResolvedValue({
    householdId: "household-1",
    id: "user-1",
    memberId: "member-1",
  });
  householdFindUniqueOrThrowMock.mockResolvedValue({ timezone: "Asia/Shanghai" });
  categoryFindManyMock.mockResolvedValue([
    { id: "category-expense", name: "Dining", type: "EXPENSE" },
    { id: "category-income", name: "Salary", type: "INCOME" },
  ]);
  householdMemberFindManyMock.mockResolvedValue([
    { id: "member-1", memberName: "Me" },
    { id: "member-2", memberName: "Spouse" },
  ]);
  listRecordsMock.mockResolvedValue([]);
  queryDashboardMock.mockResolvedValue({
    categories: { items: [], totalExpenseFen: 0 },
    range: {
      from: new Date("2026-04-19T16:00:00.000Z"),
      preset: "last-7-days",
      to: new Date("2026-04-26T15:59:59.999Z"),
    },
    recentTransactions: [],
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
  transactionFindFirstMock.mockResolvedValue(null);
}

describe("AppFiltersProvider range semantics", () => {
  beforeEach(() => {
    vi.resetModules();
    replaceMock.mockReset();
    usePathnameMock.mockReset();
    useSearchParamsMock.mockReset();
    usePathnameMock.mockReturnValue("/records");
    useSearchParamsMock.mockReturnValue(new URLSearchParams());
  });

  it("persists an explicit this-month selection in the range query param", async () => {
    let capturedContext:
      | (Awaited<typeof import("@/components/app-filters-provider")> extends infer T
          ? T extends { useAppFilters: () => infer U }
            ? U
            : never
          : never)
      | null = null;
    const { AppFiltersProvider, useAppFilters } = await import("@/components/app-filters-provider");

    function Probe() {
      capturedContext = useAppFilters();
      return createElement("div");
    }

    renderToStaticMarkup(
      createElement(AppFiltersProvider, null, createElement(Probe)),
    );

    if (!capturedContext) {
      throw new Error("Expected app filters context");
    }

    capturedContext.setRangePreset("this-month");

    expect(replaceMock).toHaveBeenCalledWith("/records?range=this-month", { scroll: false });
  });

  it("clears a stale drill-down window when the range changes", async () => {
    let capturedContext:
      | (Awaited<typeof import("@/components/app-filters-provider")> extends infer T
          ? T extends { useAppFilters: () => infer U }
            ? U
            : never
          : never)
      | null = null;
    useSearchParamsMock.mockReturnValue(
      new URLSearchParams(
        "range=last-7-days&from=2026-04-24T16%3A00%3A00.000Z&to=2026-04-25T15%3A59%3A59.999Z&type=expense&record=record-1",
      ),
    );

    const { AppFiltersProvider, useAppFilters } = await import("@/components/app-filters-provider");

    function Probe() {
      capturedContext = useAppFilters();
      return createElement("div");
    }

    renderToStaticMarkup(
      createElement(AppFiltersProvider, null, createElement(Probe)),
    );

    if (!capturedContext) {
      throw new Error("Expected app filters context");
    }

    capturedContext.setRangePreset("last-30-days");

    expect(replaceMock).toHaveBeenCalledWith("/records?range=last-30-days&type=expense", {
      scroll: false,
    });
  });
});

describe("Records page", () => {
  beforeEach(() => {
    vi.resetModules();
    redirectMock.mockClear();
    requireAppSessionMock.mockReset();
    householdFindUniqueOrThrowMock.mockReset();
    categoryFindManyMock.mockReset();
    householdMemberFindManyMock.mockReset();
    listRecordsMock.mockReset();
    transactionFindFirstMock.mockReset();
    transactionEditorDrawerMock.mockClear();
    primePageMocks();
  });

  it("keeps an explicit this-month range instead of redirecting to the recent default", async () => {
    const { default: RecordsPage } = await import("@/app/(app)/records/page");

    renderToStaticMarkup(
      await RecordsPage({
        searchParams: Promise.resolve({ range: "this-month" }),
      }),
    );

    expect(redirectMock).not.toHaveBeenCalled();
    expect(listRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        rangePreset: "this-month",
      }),
    );
  });

  it("does not reopen the drawer for a selected record that is outside the filtered result set", async () => {
    listRecordsMock.mockResolvedValue([
      {
        id: "record-1",
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
    transactionFindFirstMock.mockResolvedValue({
      id: "record-2",
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
      await RecordsPage({
        searchParams: Promise.resolve({
          range: "last-30-days",
          type: "expense",
          record: "record-2",
        }),
      }),
    );

    expect(markup).not.toContain("data-testid=\"record-drawer\"");
    expect(transactionEditorDrawerMock).not.toHaveBeenCalled();
  });

  it("passes only serializable editor labels to the record drawer", async () => {
    listRecordsMock.mockResolvedValue([
      {
        id: "record-1",
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
    transactionFindFirstMock.mockResolvedValue({
      id: "record-1",
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
      await RecordsPage({
        searchParams: Promise.resolve({
          range: "last-30-days",
          record: "record-1",
        }),
      }),
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
    expect(drawerProps.labels.editor.createdBy).toBeUndefined();
  });

  it("passes a drill-down bucket window through to the records query", async () => {
    const { default: RecordsPage } = await import("@/app/(app)/records/page");

    renderToStaticMarkup(
      await RecordsPage({
        searchParams: Promise.resolve({
          from: "2026-04-24T16:00:00.000Z",
          range: "last-7-days",
          to: "2026-04-25T15:59:59.999Z",
        }),
      }),
    );

    expect(listRecordsMock).toHaveBeenCalledWith(
      expect.objectContaining({
        from: new Date("2026-04-24T16:00:00.000Z"),
        to: new Date("2026-04-25T15:59:59.999Z"),
      }),
    );
  });
});

describe("Home page trend drill-down", () => {
  beforeEach(() => {
    vi.resetModules();
    requireAppSessionMock.mockReset();
    queryDashboardMock.mockReset();
    primePageMocks();
  });

  it("links each trend bucket to records with an exact drill-down window", async () => {
    queryDashboardMock.mockResolvedValue({
      categories: { items: [], totalExpenseFen: 0 },
      range: {
        from: new Date("2026-04-19T16:00:00.000Z"),
        preset: "last-7-days",
        to: new Date("2026-04-26T15:59:59.999Z"),
      },
      recentTransactions: [],
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
      await HomePage({
        searchParams: Promise.resolve({ range: "last-7-days" }),
      }),
    );

    expect(markup).toContain(
      "/records?range=last-7-days&amp;from=2026-04-24T16%3A00%3A00.000Z&amp;to=2026-04-25T15%3A59%3A59.999Z",
    );
  });

  it("renders the dashboard with localized Chinese labels and category display names", async () => {
    queryDashboardMock.mockResolvedValue({
      categories: {
        items: [
          {
            amountFen: 1860,
            categoryId: "category-expense",
            categoryName: "Dining",
            share: 1,
            transactionCount: 1,
          },
        ],
        totalExpenseFen: 1860,
      },
      range: {
        from: new Date("2026-04-19T16:00:00.000Z"),
        preset: "last-7-days",
        to: new Date("2026-04-26T15:59:59.999Z"),
      },
      recentTransactions: [
        {
          id: "record-1",
          amountFen: 1860,
          actorMemberId: "member-1",
          actorMemberName: "Me",
          categoryId: "category-expense",
          categoryName: "Dining",
          createdByMemberId: "member-1",
          createdByMemberName: "Me",
          note: null,
          occurredAt: new Date("2026-04-26T00:30:00.000Z"),
          type: "expense",
        },
      ],
      summary: {
        expenseFen: 1860,
        incomeFen: 0,
        netFen: -1860,
        transactionCount: 1,
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
      await HomePage({
        searchParams: Promise.resolve({ range: "last-7-days" }),
      }),
    );

    expect(markup).toContain("家庭概览");
    expect(markup).toContain("查看");
    expect(markup).toContain("趋势");
    expect(markup).toContain("1 笔");
    expect(markup).toContain("4月25日");
    expect(markup).not.toContain("Apr 25");
    expect(markup).toContain("支出分类");
    expect(markup).toContain("餐饮");
    expect(markup).toContain("近期记录");
    expect(markup).toContain("无备注");
    expect(markup).toContain("记账人: Me");
  });
});

describe("submitRecordUpdate", () => {
  beforeEach(() => {
    vi.resetModules();
    redirectMock.mockClear();
    requireAppSessionMock.mockReset();
    updateTransactionMock.mockReset();
  });

  it("closes the drawer by removing the selected record query param after a successful update", async () => {
    requireAppSessionMock.mockResolvedValue({
      householdId: "household-1",
      id: "user-1",
      memberId: "member-1",
    });
    updateTransactionMock.mockResolvedValue({ id: "record-1" });

    const { initialRecordEditorState, submitRecordUpdate } = await import(
      "@/app/(app)/records/actions"
    );
    const formData = new FormData();
    formData.set("transactionId", "record-1");
    formData.set("type", "expense");
    formData.set("amount", "18.60");
    formData.set("categoryId", "category-expense");
    formData.set("actorMemberId", "member-1");
    formData.set("occurredAt", "2026-04-26T08:30");
    formData.set("note", "Lunch");
    formData.set("returnTo", "/records?range=last-30-days&type=expense&record=record-1");

    await expect(submitRecordUpdate(initialRecordEditorState, formData)).rejects.toThrow(
      "REDIRECT:/records?range=last-30-days&type=expense",
    );

    expect(redirectMock).toHaveBeenCalledWith("/records?range=last-30-days&type=expense");
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

    const { initialRecordEditorState, submitRecordUpdate } = await import(
      "@/app/(app)/records/actions"
    );
    const formData = new FormData();
    formData.set("locale", "zh-CN");
    formData.set("returnTo", "/records?range=last-30-days&record=record-1");

    await expect(submitRecordUpdate(initialRecordEditorState, formData)).resolves.toEqual({
      status: "error",
      message: "请选择分类",
    });
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

    const { initialRecordEditorState, submitRecordDelete } = await import(
      "@/app/(app)/records/actions"
    );
    const formData = new FormData();
    formData.set("locale", "zh-CN");
    formData.set("returnTo", "/records?range=last-30-days&record=record-1");

    await expect(submitRecordDelete(initialRecordEditorState, formData)).resolves.toEqual({
      status: "error",
      message: "无法删除记录",
    });
  });
});
