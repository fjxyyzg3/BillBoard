import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/account/actions", () => ({ finishReauthenticationAction: vi.fn() }));

const {
  categoryFindManyMock,
  householdMemberFindManyMock,
  ledgerFindManyMock,
  searchParamsMock,
  queryRecentCategoryUsageMock,
  recordAppEventMock,
  requireAppSessionMock,
  transactionFormMock,
} = vi.hoisted(() => ({
  categoryFindManyMock: vi.fn(),
  householdMemberFindManyMock: vi.fn(),
  ledgerFindManyMock: vi.fn(),
  searchParamsMock: vi.fn(),
  queryRecentCategoryUsageMock: vi.fn(),
  recordAppEventMock: vi.fn(),
  requireAppSessionMock: vi.fn(),
  transactionFormMock: vi.fn(() => createElement("div", { "data-testid": "transaction-form" })),
}));

vi.mock("@/components/transaction-form", () => ({
  TransactionForm: transactionFormMock,
}));

vi.mock("@/lib/auth/session", () => ({
  requireAppSession: requireAppSessionMock,
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/add",
  useSearchParams: searchParamsMock,
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth/household-context", () => ({
  resolveHouseholdContext: async (_client: unknown, session: { householdId: string; memberId: string }) => ({ ...session, userId: "user-1", role: "OWNER", ledgerId: "ledger-1", ledgerName: "Default" }),
}));

vi.mock("@/lib/db", () => ({
  db: {
    category: { findMany: categoryFindManyMock },
    householdMember: { findMany: householdMemberFindManyMock },
    ledger: { findMany: ledgerFindManyMock },
  },
}));

const ledgerCatalog = {
  identity: { householdId: "household-1", memberId: "member-1" },
  role: "OWNER" as const,
  ledgers: [
    { id: "ledger-1", name: "Default", isDefault: true, archivedAt: null },
    { id: "ledger-2", name: "Travel", isDefault: false, archivedAt: null },
  ],
  legacyDefaultLedgerId: "ledger-1",
};

vi.mock("@/lib/i18n-server", () => ({
  getServerLocale: vi.fn(async () => "zh-CN"),
}));

vi.mock("@/lib/ops/record-event", () => ({
  recordAppEvent: recordAppEventMock,
}));

vi.mock("@/lib/transactions/query-category-preferences", () => ({
  queryRecentCategoryUsage: queryRecentCategoryUsageMock,
}));

describe("AddPage category preferences", () => {
  beforeEach(() => {
    vi.resetModules();
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-22T15:30:00.000Z"));
    categoryFindManyMock.mockReset();
    householdMemberFindManyMock.mockReset();
    ledgerFindManyMock.mockReset();
    ledgerFindManyMock.mockResolvedValue(ledgerCatalog.ledgers.map((ledger) => ({ ...ledger, acceptsLegacyDrafts: ledger.id === "ledger-1" })));
    searchParamsMock.mockReset();
    searchParamsMock.mockReturnValue(new URLSearchParams());
    queryRecentCategoryUsageMock.mockReset();
    recordAppEventMock.mockReset();
    recordAppEventMock.mockResolvedValue(undefined);
    requireAppSessionMock.mockReset();
    transactionFormMock.mockClear();
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("passes categories ordered by recent usage and default category ids to the form", async () => {
    requireAppSessionMock.mockResolvedValue({
      householdId: "household-1",
      id: "user-1",
      memberId: "member-1",
    });
    categoryFindManyMock.mockResolvedValue([
      { id: "dining", name: "Dining", type: "EXPENSE" },
      { id: "shopping", name: "Shopping", type: "EXPENSE" },
      { id: "salary", name: "Salary", type: "INCOME" },
      { id: "bonus", name: "Bonus", type: "INCOME" },
    ]);
    householdMemberFindManyMock.mockResolvedValue([{ id: "member-1", memberName: "Me" }]);
    queryRecentCategoryUsageMock.mockResolvedValue([
      {
        categoryId: "shopping",
        count: 4,
        lastOccurredAt: new Date("2026-05-21T02:00:00.000Z"),
        type: "expense",
      },
      {
        categoryId: "bonus",
        count: 1,
        lastOccurredAt: new Date("2026-05-20T02:00:00.000Z"),
        type: "income",
      },
    ]);

    const { default: AddPage } = await import("@/app/(app)/add/page");
    const { LedgerProvider } = await import("@/components/ledger-provider");
    const { NaturalLanguageProvider } = await import("@/components/natural-language-provider");
    searchParamsMock.mockReturnValue(new URLSearchParams({ ledger: "ledger-2" }));
    renderToStaticMarkup(<LedgerProvider catalog={ledgerCatalog}>
      <NaturalLanguageProvider currentMemberId="member-1">{materializePageView(await AddPage({ searchParams: Promise.resolve({ ledger: "ledger-2" }) }))}</NaturalLanguageProvider>
    </LedgerProvider>);

    expect(queryRecentCategoryUsageMock).toHaveBeenCalledWith({
      householdId: "household-1",
      memberId: "member-1",
      ledgerId: "ledger-2",
      now: new Date("2026-05-22T15:30:00.000Z"),
    });
    expect(transactionFormMock).toHaveBeenCalledWith(
      expect.objectContaining({
        context: { householdId: "household-1", memberId: "member-1", ledgerId: "ledger-2" },
        categories: [
          { id: "shopping", name: "Shopping", type: "expense" },
          { id: "dining", name: "Dining", type: "expense" },
          { id: "bonus", name: "Bonus", type: "income" },
          { id: "salary", name: "Salary", type: "income" },
        ],
        defaultCategoryIds: {
          expense: "shopping",
          income: "bonus",
        },
      }),
      undefined,
    );
  });

  it("starts page data reads before best-effort page event recording finishes", async () => {
    let resolveEvent: (() => void) | undefined;

    requireAppSessionMock.mockResolvedValue({
      householdId: "household-1",
      id: "user-1",
      memberId: "member-1",
    });
    recordAppEventMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveEvent = resolve;
      }),
    );
    categoryFindManyMock.mockResolvedValue([]);
    householdMemberFindManyMock.mockResolvedValue([]);
    queryRecentCategoryUsageMock.mockResolvedValue([]);

    const { default: AddPage } = await import("@/app/(app)/add/page");
    const pagePromise = AddPage({ searchParams: Promise.resolve({}) });

    try {
      await vi.waitFor(() => {
        expect(categoryFindManyMock).toHaveBeenCalledOnce();
        expect(householdMemberFindManyMock).toHaveBeenCalledOnce();
        expect(queryRecentCategoryUsageMock).toHaveBeenCalledOnce();
      });
    } finally {
      resolveEvent?.();
      await pagePromise;
    }
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
