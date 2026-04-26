import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  categoryFindManyMock,
  householdFindUniqueOrThrowMock,
  householdMemberFindManyMock,
  listRecordsMock,
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
});
