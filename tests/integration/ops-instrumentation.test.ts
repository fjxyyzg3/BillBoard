import { createElement } from "react";
import { AppEventType, TransactionType } from "@prisma/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { buildReportAnalytics } from "@/lib/reports/analytics";

const {
  appSessionFindFirstMock,
  appSessionUpdateManyMock,
  appSessionUpsertMock,
  authQueryRawMock,
  authTransactionMock,
  authUserFindUniqueMock,
  authConfigStore,
  categoryFindManyMock,
  confirmImportDraftMock,
  createAlipayImportDraftMock,
  createSuiShouJiImportDraftMock,
  createTransactionMock,
  createWechatPayImportDraftMock,
  credentialsProviderMock,
  householdFindUniqueOrThrowMock,
  householdMemberFindManyMock,
  householdMemberFindFirstMock,
  resolveHouseholdContextMock,
  importDraftFindFirstOrThrowMock,
  listRecordsMock,
  ledgerFindManyMock,
  nextAuthMock,
  queryRecentCategoryUsageMock,
  queryHomeReportMock,
  queryReportAnalyticsMock,
  revalidatePathMock,
  reportRangeControlsMock,
  recordAppEventMock,
  redirectMock,
  requireAppSessionMock,
  transactionFindFirstMock,
  updateTransactionMock,
  deleteTransactionMock,
  verifyLoginCredentialsMock,
} = vi.hoisted(() => {
  const authConfigStore: {
    current: {
      callbacks?: {
        jwt?: (input: { token: Record<string, unknown>; user?: unknown }) => Promise<Record<string, unknown>>;
        session?: (input: { session: Record<string, unknown>; token: Record<string, unknown> }) => Promise<Record<string, unknown>>;
      };
      providers?: Array<{ authorize?: unknown }>;
    } | null;
  } = { current: null };

  return {
    appSessionFindFirstMock: vi.fn(),
    appSessionUpdateManyMock: vi.fn(),
    appSessionUpsertMock: vi.fn(),
    authQueryRawMock: vi.fn(),
    authTransactionMock: vi.fn(),
    authUserFindUniqueMock: vi.fn(),
    authConfigStore,
    categoryFindManyMock: vi.fn(),
    confirmImportDraftMock: vi.fn(),
    createAlipayImportDraftMock: vi.fn(),
    createSuiShouJiImportDraftMock: vi.fn(),
    createTransactionMock: vi.fn(),
    createWechatPayImportDraftMock: vi.fn(),
    credentialsProviderMock: vi.fn((config: unknown) => config),
    deleteTransactionMock: vi.fn(),
    householdFindUniqueOrThrowMock: vi.fn(),
    householdMemberFindManyMock: vi.fn(),
    householdMemberFindFirstMock: vi.fn(),
    resolveHouseholdContextMock: vi.fn(),
    importDraftFindFirstOrThrowMock: vi.fn(),
    listRecordsMock: vi.fn(),
    ledgerFindManyMock: vi.fn(),
    nextAuthMock: vi.fn((config: { providers?: Array<{ authorize?: unknown }> }) => {
      authConfigStore.current = config;

      return {
        auth: vi.fn(),
        handlers: {},
        signIn: vi.fn(),
        signOut: vi.fn(),
      };
    }),
    queryRecentCategoryUsageMock: vi.fn(),
    queryHomeReportMock: vi.fn(),
    queryReportAnalyticsMock: vi.fn(),
    revalidatePathMock: vi.fn(),
    reportRangeControlsMock: vi.fn(() =>
      createElement("div", { "data-testid": "report-range-controls" }),
    ),
    recordAppEventMock: vi.fn(),
    redirectMock: vi.fn((path: string) => {
      throw new Error(`REDIRECT:${path}`);
    }),
    requireAppSessionMock: vi.fn(),
    transactionFindFirstMock: vi.fn(),
    updateTransactionMock: vi.fn(),
    verifyLoginCredentialsMock: vi.fn(),
  };
});

vi.mock("@/lib/auth/login-admission", () => ({
  verifyLoginCredentials: verifyLoginCredentialsMock,
}));

vi.mock("next-auth", async () => ({
  CredentialsSignin: (await import("@auth/core/errors")).CredentialsSignin,
  default: nextAuthMock,
}));

vi.mock("next-auth/providers/credentials", () => ({
  default: credentialsProviderMock,
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
  usePathname: vi.fn(() => "/records"),
  useRouter: () => ({
    push: vi.fn(),
    replace: vi.fn(),
  }),
  useSearchParams: vi.fn(() => new URLSearchParams()),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));

vi.mock("next/dist/client/components/redirect-error", () => ({
  isRedirectError: (error: unknown) =>
    error instanceof Error && error.message.startsWith("REDIRECT:"),
}));

vi.mock("@/lib/auth/session", () => ({
  requireAppSession: requireAppSessionMock,
}));

vi.mock("@/lib/encryption/request", () => ({
  getHouseholdEncryptionStatus: async () => ({ mode: "UNENCRYPTED", revision: 0, generation: null, keyVersion: 0, isOwner: true, operation: null }),
  withHouseholdEncryption: async (_input: unknown, work: () => Promise<unknown>) => work(),
  extractEncryption: (formData: FormData) => { formData.delete("__householdEncryption"); return undefined; },
}));

vi.mock("@/lib/auth/household-context", () => ({
  resolveHouseholdContext: resolveHouseholdContextMock,
}));

vi.mock("@/lib/db", () => ({
  db: {
    $transaction: authTransactionMock,
    category: { findMany: categoryFindManyMock },
    household: { findUniqueOrThrow: householdFindUniqueOrThrowMock },
    householdMember: { findMany: householdMemberFindManyMock, findFirst: householdMemberFindFirstMock },
    importDraft: { findFirstOrThrow: importDraftFindFirstOrThrowMock },
    appSession: {
      findFirst: appSessionFindFirstMock,
      updateMany: appSessionUpdateManyMock,
      upsert: appSessionUpsertMock,
    },
    transaction: { findFirst: transactionFindFirstMock },
    ledger: { findMany: ledgerFindManyMock },
  },
}));

vi.mock("@/lib/i18n-server", () => ({
  getServerLocale: vi.fn(async () => "zh-CN"),
}));

vi.mock("@/lib/records/list-records", () => ({
  listRecords: listRecordsMock,
  RECORDS_PAGE_SIZE: 100,
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("@/lib/reports/query-home-report", () => ({
  queryHomeReport: queryHomeReportMock,
}));

vi.mock("@/lib/reports/query-report-analytics", () => ({
  queryReportAnalytics: queryReportAnalyticsMock,
}));

vi.mock("@/lib/transactions/create-transaction", () => ({
  createTransaction: createTransactionMock,
}));

vi.mock("@/lib/transactions/update-transaction", () => ({
  updateTransaction: updateTransactionMock,
}));

vi.mock("@/lib/transactions/delete-transaction", () => ({
  deleteTransaction: deleteTransactionMock,
}));

vi.mock("@/lib/transactions/query-category-preferences", () => ({
  queryRecentCategoryUsage: queryRecentCategoryUsageMock,
}));

vi.mock("@/lib/imports/drafts", () => ({
  confirmImportDraft: confirmImportDraftMock,
  createAlipayImportDraft: createAlipayImportDraftMock,
  createSuiShouJiImportDraft: createSuiShouJiImportDraftMock,
  createWechatPayImportDraft: createWechatPayImportDraftMock,
  getImportDraftSummary: vi.fn(async () => null),
  saveImportDraftMappings: vi.fn(),
  saveImportDraftMemberMappings: vi.fn(),
  savePaymentImportDraftOwnerMember: vi.fn(),
  setImportDraftRowDecision: vi.fn(),
}));

vi.mock("@/lib/ops/record-event", () => ({
  recordAppEvent: recordAppEventMock,
}));

vi.mock("@/components/category-breakdown", () => ({
  CategoryBreakdown: () => createElement("div", { "data-testid": "category-breakdown" }),
}));

vi.mock("@/components/records-filter-bar", () => ({
  RecordsFilterBar: () => createElement("div", { "data-testid": "records-filter-bar" }),
}));

vi.mock("@/components/summary-card", () => ({
  SummaryCard: () => createElement("div", { "data-testid": "summary-card" }),
}));

vi.mock("@/components/report-range-controls", () => ({
  ReportRangeControls: reportRangeControlsMock,
}));

vi.mock("@/components/transaction-editor-drawer", () => ({
  TransactionEditorDrawer: () => createElement("div", { "data-testid": "record-drawer" }),
}));

vi.mock("@/components/transaction-form", () => ({
  TransactionForm: () => createElement("div", { "data-testid": "transaction-form" }),
}));

const sessionUser = {
  householdId: "household-1",
  id: "user-1",
  memberId: "member-1",
};
const entryContext = { householdId: sessionUser.householdId, memberId: sessionUser.memberId, ledgerId: "ledger-1" };

const initialCreateState = {
  status: "idle" as const,
};

const initialRecordEditorState = {
  status: "idle" as const,
};

function resetSharedMocks() {
  vi.resetModules();
  authConfigStore.current = null;
  appSessionFindFirstMock.mockReset();
  appSessionUpdateManyMock.mockReset();
  appSessionUpsertMock.mockReset();
  appSessionUpsertMock.mockResolvedValue({ id: "app-session-1" });
  authQueryRawMock.mockReset();
  authQueryRawMock.mockResolvedValue([]);
  authUserFindUniqueMock.mockReset();
  authUserFindUniqueMock.mockResolvedValue({ status: "ACTIVE", email: "person@example.com", passwordHash: "hash" });
  authTransactionMock.mockReset();
  authTransactionMock.mockImplementation(async (work: (transaction: unknown) => Promise<unknown>) => work({
    $queryRaw: authQueryRawMock,
    user: { findUnique: authUserFindUniqueMock },
    householdMember: { findFirst: householdMemberFindFirstMock },
    appSession: { upsert: appSessionUpsertMock },
  }));
  categoryFindManyMock.mockReset();
  confirmImportDraftMock.mockReset();
  createAlipayImportDraftMock.mockReset();
  createSuiShouJiImportDraftMock.mockReset();
  createTransactionMock.mockReset();
  createWechatPayImportDraftMock.mockReset();
  credentialsProviderMock.mockClear();
  deleteTransactionMock.mockReset();
  householdFindUniqueOrThrowMock.mockReset();
  householdMemberFindManyMock.mockReset();
  householdMemberFindFirstMock.mockReset();
  householdMemberFindFirstMock.mockResolvedValue({ id: "member-1", householdId: "household-1", userId: "user-1", role: "OWNER" });
  resolveHouseholdContextMock.mockReset();
  resolveHouseholdContextMock.mockResolvedValue({ householdId: "household-1", memberId: "member-1", userId: "user-1", role: "OWNER", ledgerId: "ledger-1", ledgerName: "Default" });
  importDraftFindFirstOrThrowMock.mockReset();
  listRecordsMock.mockReset();
  ledgerFindManyMock.mockReset();
  ledgerFindManyMock.mockResolvedValue([{ id: "ledger-1", name: "Default", isDefault: true, archivedAt: null, acceptsLegacyDrafts: true }]);
  nextAuthMock.mockClear();
  queryRecentCategoryUsageMock.mockReset();
  queryHomeReportMock.mockReset();
  queryReportAnalyticsMock.mockReset();
  revalidatePathMock.mockReset();
  reportRangeControlsMock.mockClear();
  recordAppEventMock.mockReset();
  recordAppEventMock.mockResolvedValue(undefined);
  redirectMock.mockClear();
  requireAppSessionMock.mockReset();
  transactionFindFirstMock.mockReset();
  updateTransactionMock.mockReset();
  verifyLoginCredentialsMock.mockReset();
}

function primePageMocks() {
  queryReportAnalyticsMock.mockResolvedValue(buildReportAnalytics({
    range: { from: "2026-04-01", to: "2026-04-30" },
    previousRange: { from: "2026-03-01", to: "2026-03-31" },
    yearAgoRange: { from: "2025-04-01", to: "2025-04-30" },
    firstRecordedDate: null,
    categories: [],
    days: [],
    categoryMonths: [],
    distribution: { buckets: [], expenseCount: 0, totalFen: 0, medianFen: null, maxFen: null, topFiveAmountFen: 0 },
  }));
  requireAppSessionMock.mockResolvedValue(sessionUser);
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
  categoryFindManyMock.mockResolvedValue([
    { id: "category-expense", name: "Dining", type: "EXPENSE" },
    { id: "category-income", name: "Salary", type: "INCOME" },
  ]);
  householdFindUniqueOrThrowMock.mockResolvedValue({ timezone: "Asia/Shanghai" });
  householdMemberFindManyMock.mockResolvedValue([
    { id: "member-1", memberName: "Me" },
    { id: "member-2", memberName: "Spouse" },
  ]);
  listRecordsMock.mockResolvedValue([]);
  queryRecentCategoryUsageMock.mockResolvedValue([]);
  transactionFindFirstMock.mockResolvedValue(null);
}

function transactionFormData(type: "income" | "expense" = "expense") {
  const formData = new FormData();

  formData.set("transactionId", "transaction-1");
  formData.set("context", JSON.stringify(entryContext));
  formData.set("type", type);
  formData.set("amount", "18.60");
  formData.set("categoryId", type === "income" ? "category-income" : "category-expense");
  formData.set("actorMemberId", "member-1");
  formData.set("clientRequestId", "2fa6e82e-10a5-4c2d-9dff-56679048b772");
  formData.set("occurredAt", "2026-04-26T08:30");
  formData.set("note", "private note");
  formData.set("returnTo", "/records?mode=month&month=2026-04&year=2026&record=transaction-1");

  return formData;
}

function expectNoSensitiveLoginData(payload: unknown) {
  const serialized = JSON.stringify(payload);

  expect(serialized).not.toContain("person@example.com");
  expect(serialized).not.toContain("missing@example.com");
  expect(serialized).not.toContain("not-an-email");
  expect(serialized).not.toContain("wrong-password");
  expect(serialized).not.toContain("correct-password");
  expect(serialized).not.toContain("whatever");
  expect(serialized).not.toContain("password");
  expect(serialized).not.toContain("reason");
}

async function getAuthorize() {
  await import("@/auth");

  const provider = authConfigStore.current?.providers?.[0] as
    | { authorize?: (credentials: Record<string, unknown>, request?: Request) => Promise<unknown> }
    | undefined;

  if (!provider?.authorize) {
    throw new Error("Expected credentials authorize callback");
  }

  return provider.authorize;
}

async function getAuthCallbacks() {
  await import("@/auth");

  const callbacks = authConfigStore.current?.callbacks;

  if (!callbacks?.jwt || !callbacks.session) {
    throw new Error("Expected auth callbacks");
  }

  return { jwt: callbacks.jwt, session: callbacks.session };
}

describe("ops instrumentation for transaction actions", () => {
  beforeEach(() => {
    resetSharedMocks();
    requireAppSessionMock.mockResolvedValue(sessionUser);
  });

  it("records a transaction created event after a successful create action", async () => {
    createTransactionMock.mockResolvedValue({
      amountFen: 1860,
      clientRequestId: "2fa6e82e-10a5-4c2d-9dff-56679048b772",
      id: "transaction-1",
      type: TransactionType.EXPENSE,
      wasCreated: true,
    });

    const { submitTransaction } = await import("@/app/(app)/add/actions");

    await expect(submitTransaction(initialCreateState, transactionFormData())).resolves.toEqual({
      amountFen: 1860,
      clientRequestId: "2fa6e82e-10a5-4c2d-9dff-56679048b772",
      status: "success",
      transactionId: "transaction-1",
      type: "expense",
    });

    expect(recordAppEventMock).toHaveBeenCalledWith({
      eventType: AppEventType.TRANSACTION_CREATED,
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
      metadata: { transactionType: "expense" },
      summary: "新增支出记录",
    });
    expect(JSON.stringify(recordAppEventMock.mock.calls)).not.toContain(
      "2fa6e82e-10a5-4c2d-9dff-56679048b772",
    );
  });

  it("does not record another created event for an idempotent retry", async () => {
    createTransactionMock.mockResolvedValue({
      amountFen: 1860,
      clientRequestId: "2fa6e82e-10a5-4c2d-9dff-56679048b772",
      id: "transaction-1",
      type: TransactionType.EXPENSE,
      wasCreated: false,
    });

    const { submitTransaction } = await import("@/app/(app)/add/actions");

    await expect(submitTransaction(initialCreateState, transactionFormData())).resolves.toMatchObject({
      status: "success",
      transactionId: "transaction-1",
    });

    expect(recordAppEventMock).not.toHaveBeenCalled();
  });

  it("records transaction updated and deleted events after successful record actions", async () => {
    updateTransactionMock.mockResolvedValue({
      id: "transaction-1",
      type: TransactionType.INCOME,
    });
    deleteTransactionMock.mockResolvedValue({
      id: "transaction-1",
      type: TransactionType.EXPENSE,
    });

    const { submitRecordDelete, submitRecordUpdate } = await import("@/app/(app)/records/actions");

    await expect(
      submitRecordUpdate(initialRecordEditorState, transactionFormData("income")),
    ).rejects.toThrow("REDIRECT:/records?mode=month&month=2026-04&year=2026");
    await expect(
      submitRecordDelete(initialRecordEditorState, transactionFormData()),
    ).rejects.toThrow("REDIRECT:/records?mode=month&month=2026-04&year=2026");

    expect(recordAppEventMock).toHaveBeenNthCalledWith(1, {
      eventType: AppEventType.TRANSACTION_UPDATED,
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
      metadata: { transactionType: "income" },
      summary: "编辑收入记录",
    });
    expect(recordAppEventMock).toHaveBeenNthCalledWith(2, {
      eventType: AppEventType.TRANSACTION_DELETED,
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
      metadata: { transactionType: "expense" },
      summary: "删除支出记录",
    });
  });

  it("does not record transaction events when the business operation fails", async () => {
    createTransactionMock.mockRejectedValue(new ZodError([]));
    updateTransactionMock.mockRejectedValue(new Error("Transaction not found"));
    deleteTransactionMock.mockRejectedValue(new Error("Transaction not found"));

    const { submitTransaction } = await import("@/app/(app)/add/actions");
    const { submitRecordDelete, submitRecordUpdate } = await import("@/app/(app)/records/actions");

    await expect(submitTransaction(initialCreateState, transactionFormData())).resolves.toMatchObject({
      status: "error",
    });
    await expect(
      submitRecordUpdate(initialRecordEditorState, transactionFormData()),
    ).resolves.toMatchObject({ status: "error" });
    await expect(
      submitRecordDelete(initialRecordEditorState, transactionFormData()),
    ).resolves.toMatchObject({ status: "error" });

    expect(recordAppEventMock).not.toHaveBeenCalled();
  });
});

describe("ops instrumentation for page views", () => {
  beforeEach(() => {
    vi.stubEnv("AUTH_SECRET", "report-instrumentation-test-secret");
    resetSharedMocks();
    primePageMocks();
  });

  afterEach(() => {
    vi.unstubAllEnvs();
  });

  it("records page views for app pages with whitelisted paths and summaries", async () => {
    const { default: HomePage } = await import("@/app/(app)/home/page");
    const { default: AddPage } = await import("@/app/(app)/add/page");
    const { default: RecordsPage } = await import("@/app/(app)/records/page");
    const { default: ImportRecordsPage } = await import("@/app/(app)/records/import/page");

    await HomePage({
      searchParams: Promise.resolve({
        categoryType: "income",
        mode: "month",
        month: "2026-04",
        year: "2026",
      }),
    });
    await AddPage({
      searchParams: Promise.resolve({
        amountFen: "1860",
        created: "1",
        mode: "month",
        type: "expense",
      }),
    });
    await RecordsPage({
      searchParams: Promise.resolve({
        mode: "month",
        month: "2026-04",
        type: "expense",
        year: "2026",
      }),
    });
    await ImportRecordsPage({
      searchParams: Promise.resolve({ draft: "draft-1", completed: "1" }),
    });

    expect(recordAppEventMock).toHaveBeenNthCalledWith(1, {
      eventType: AppEventType.PAGE_VIEW,
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
      path: "/home",
      summary: "访问 首页",
    });
    expect(recordAppEventMock).toHaveBeenNthCalledWith(2, {
      eventType: AppEventType.PAGE_VIEW,
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
      path: "/add",
      summary: "访问 记一笔",
    });
    expect(recordAppEventMock).toHaveBeenNthCalledWith(3, {
      eventType: AppEventType.PAGE_VIEW,
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
      path: "/records",
      summary: "访问 记录",
    });
    expect(recordAppEventMock).toHaveBeenNthCalledWith(4, {
      eventType: AppEventType.PAGE_VIEW,
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
      path: "/records/import",
      summary: "访问 导入记录",
    });

    for (const call of recordAppEventMock.mock.calls) {
      const payload = call[0] as { path?: string };

      expect(payload.path).not.toContain("?");
    }
    expect(queryHomeReportMock).toHaveBeenCalledWith(
      expect.objectContaining({
        currentMemberId: sessionUser.memberId,
        householdId: sessionUser.householdId,
        range: {
          mode: "month",
          month: "2026-04",
          year: "2026",
        },
      }),
    );
  });

  it("starts the home report query before best-effort page event recording finishes", async () => {
    let resolveEvent: (() => void) | undefined;

    recordAppEventMock.mockReturnValue(
      new Promise<void>((resolve) => {
        resolveEvent = resolve;
      }),
    );

    const { default: HomePage } = await import("@/app/(app)/home/page");
    const pagePromise = HomePage({ searchParams: Promise.resolve({}) });

    try {
      await vi.waitFor(() => expect(queryHomeReportMock).toHaveBeenCalledOnce());
    } finally {
      resolveEvent?.();
      await pagePromise;
    }
  });

  it("records a records page view for the default month range without redirecting", async () => {
    const { default: RecordsPage } = await import("@/app/(app)/records/page");

    await RecordsPage({
      searchParams: Promise.resolve({}),
    });

    expect(redirectMock).not.toHaveBeenCalled();
    expect(recordAppEventMock).toHaveBeenCalledWith({
      eventType: AppEventType.PAGE_VIEW,
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
      path: "/records",
      summary: "访问 记录",
    });
  });

  it("records a records page view when the report range is already present", async () => {
    const { default: RecordsPage } = await import("@/app/(app)/records/page");

    await RecordsPage({
      searchParams: Promise.resolve({ mode: "month", month: "2026-04", year: "2026" }),
    });

    expect(recordAppEventMock).toHaveBeenCalledWith({
      eventType: AppEventType.PAGE_VIEW,
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
      path: "/records",
      summary: "访问 记录",
    });
  });
});

describe("ops instrumentation for import actions", () => {
  beforeEach(() => {
    resetSharedMocks();
    requireAppSessionMock.mockResolvedValue(sessionUser);
  });

  it("records an import draft upload event with only the source metadata", async () => {
    createSuiShouJiImportDraftMock.mockResolvedValue({ id: "draft-1" });
    const formData = new FormData();

    formData.set("source", "sui_shou_ji");
    formData.set("context", JSON.stringify(entryContext));
    formData.set("file", new File([new Uint8Array([1, 2, 3])], "private-file.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );

    expect(recordAppEventMock).toHaveBeenCalledWith({
      eventType: AppEventType.IMPORT_DRAFT_UPLOADED,
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
      metadata: { source: "sui_shou_ji" },
      summary: "上传导入草稿",
    });
    expect(Object.keys(recordAppEventMock.mock.calls[0][0].metadata)).toEqual(["source"]);
  });

  it("records an import confirmed event with only count and trusted source metadata", async () => {
    confirmImportDraftMock.mockResolvedValue({
      completedNow: true,
      createdCount: 2,
      source: "wechat_pay",
    });
    const formData = new FormData();

    formData.set("draftId", "draft-1");

    const { confirmImportDraftAction } = await import("@/app/(app)/records/import/actions");

    await expect(confirmImportDraftAction(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1&completed=1",
    );

    expect(importDraftFindFirstOrThrowMock).not.toHaveBeenCalled();
    expect(recordAppEventMock).toHaveBeenCalledWith({
      eventType: AppEventType.IMPORT_CONFIRMED,
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
      metadata: { count: 2, source: "wechat_pay" },
      summary: "确认导入 2 笔",
    });
    expect(Object.keys(recordAppEventMock.mock.calls[0][0].metadata)).toEqual(["count", "source"]);
  });

  it("does not record an import confirmed event for an already completed draft", async () => {
    confirmImportDraftMock.mockResolvedValue({
      completedNow: false,
      createdCount: 2,
      source: "wechat_pay",
    });
    const formData = new FormData();

    formData.set("draftId", "draft-1");

    const { confirmImportDraftAction } = await import("@/app/(app)/records/import/actions");

    await expect(confirmImportDraftAction(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1&completed=1",
    );

    expect(recordAppEventMock).not.toHaveBeenCalled();
  });

  it("does not record import events when validation redirects before requiring a session", async () => {
    const formData = new FormData();

    formData.set("source", "sui_shou_ji");
    formData.set("file", new File([new Uint8Array([1])], "wrong.csv"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unsupported-file",
    );

    expect(requireAppSessionMock).not.toHaveBeenCalled();
    expect(recordAppEventMock).not.toHaveBeenCalled();
  });
});

describe("ops instrumentation for credentials login", () => {
  beforeEach(() => {
    resetSharedMocks();
    verifyLoginCredentialsMock.mockResolvedValue({ status: "invalid" });
  });

  it("records login success with household and member identifiers only", async () => {
    verifyLoginCredentialsMock.mockResolvedValue({
      status: "authenticated",
      user: {
        displayName: "Person",
        email: "person@example.com",
        householdMember: [{
          householdId: sessionUser.householdId,
          id: sessionUser.memberId,
        }],
        id: "user-1",
        passwordHash: "hash",
        status: "ACTIVE",
      },
    });

    const authorize = await getAuthorize();
    const result = await authorize({
      email: "person@example.com",
      password: "correct-password",
    });

    expect(result).toMatchObject({
      appSessionId: "app-session-1",
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
    });
    expect(recordAppEventMock).toHaveBeenCalledWith({
      eventType: AppEventType.LOGIN_SUCCESS,
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
      path: "/login",
      summary: "登录成功",
    });
    expectNoSensitiveLoginData(recordAppEventMock.mock.calls[0][0]);
    expect(authTransactionMock).toHaveBeenCalledOnce();
    expect(authUserFindUniqueMock).toHaveBeenCalledWith({
      where: { id: sessionUser.id }, select: { status: true, email: true, passwordHash: true },
    });
    expect(JSON.stringify(result)).not.toContain("passwordHash");
  });

  it("records login failures without email, password, or failure reason metadata", async () => {
    const authorize = await getAuthorize();
    await expect(
      authorize({
        email: "person@example.com",
        password: "wrong-password",
      }),
    ).resolves.toBeNull();

    expect(recordAppEventMock).toHaveBeenCalledWith({
      eventType: AppEventType.LOGIN_FAILED,
      summary: "登录失败",
    });
    expectNoSensitiveLoginData(recordAppEventMock.mock.calls[0][0]);

    await expect(
      authorize({
        email: "missing@example.com",
        password: "wrong-password",
      }),
    ).resolves.toBeNull();

    expect(recordAppEventMock).toHaveBeenCalledWith({
      eventType: AppEventType.LOGIN_FAILED,
      summary: "登录失败",
    });
    expectNoSensitiveLoginData(recordAppEventMock.mock.calls[0][0]);
  });

  it("rejects invalid emails without admission work or database event writes", async () => {
    const authorize = await getAuthorize();

    await expect(
      authorize({
        email: "not-an-email",
        password: "whatever",
      }),
    ).resolves.toBeNull();

    expect(verifyLoginCredentialsMock).not.toHaveBeenCalled();
    expect(recordAppEventMock).not.toHaveBeenCalled();
  });

  it("rejects locked or busy accounts without disclosing their state or writing events", async () => {
    verifyLoginCredentialsMock.mockResolvedValue({ status: "rejected" });

    const authorize = await getAuthorize();

    await expect(
      authorize({
        email: "person@example.com",
        password: "wrong-password",
      }),
    ).resolves.toBeNull();

    expect(recordAppEventMock).not.toHaveBeenCalled();
  });

  it("returns the shared rate-limit code without writing an event for each rejection", async () => {
    verifyLoginCredentialsMock.mockResolvedValue({ status: "rate_limited" });
    const authorize = await getAuthorize();

    await expect(authorize({ email: "person@example.com", password: "wrong" }))
      .rejects.toMatchObject({ type: "CredentialsSignin", code: "rate_limited" });
    expect(recordAppEventMock).not.toHaveBeenCalled();
  });
});

describe("app session callbacks", () => {
  beforeEach(() => {
    resetSharedMocks();
    appSessionUpsertMock.mockResolvedValue({ id: "app-session-1" });
    appSessionUpdateManyMock.mockResolvedValue({ count: 1 });
  });

  it("creates a server-side app session during authorization and copies its safe id into the first JWT", async () => {
    verifyLoginCredentialsMock.mockResolvedValue({ status: "authenticated", user: {
      displayName: "Person", email: "person@example.com", passwordHash: "hash", id: sessionUser.id, status: "ACTIVE",
      householdMember: [{ id: sessionUser.memberId, householdId: sessionUser.householdId }],
    } });
    const authorize = await getAuthorize();
    const authorized = await authorize({ email: "person@example.com", password: "correct-password" }, new Request("http://127.0.0.1/api/auth/callback/credentials", {
      headers: { "user-agent": "Mozilla/5.0 Chrome/124.0.0.0" },
    }));
    expect(appSessionUpsertMock).toHaveBeenCalledOnce();
    const callbacks = await getAuthCallbacks();
    const token = {
      exp: 1_797_000_000,
      jti: "jwt-session-key",
    };

    const result = await callbacks.jwt({
      token,
      user: authorized,
    });

    expect(result).toMatchObject({
      appSessionId: "app-session-1",
      jti: "jwt-session-key",
      householdId: sessionUser.householdId,
      memberId: sessionUser.memberId,
      sub: sessionUser.id,
    });
    expect(appSessionUpsertMock).toHaveBeenCalledWith({
      create: expect.objectContaining({
        sessionKey: expect.any(String),
        userAgent: "Mozilla/5.0 Chrome/124.0.0.0",
        userId: sessionUser.id,
      }),
      select: { id: true },
      update: {},
      where: {
        sessionKey: appSessionUpsertMock.mock.calls[0][0].create.sessionKey,
      },
    });
    expect(appSessionUpsertMock).toHaveBeenCalledOnce();
    expect(JSON.stringify(authorized)).not.toContain("passwordHash");
    expect(JSON.stringify(result)).not.toContain("passwordHash");
  });

  it("marks the session invalid when the server-side app session is revoked or missing", async () => {
    appSessionFindFirstMock.mockResolvedValue(null);
    const callbacks = await getAuthCallbacks();

    const session = await callbacks.session({
      session: { user: {} },
      token: {
        appSessionId: "app-session-1",
        email: "person@example.com",
        householdId: sessionUser.householdId,
        memberId: sessionUser.memberId,
        name: "Person",
        sub: sessionUser.id,
      },
    });

    expect(session).toMatchObject({ authError: "SESSION_INVALID" });
    expect(session.user).toBeUndefined();
  });

  it("loads trusted user and household identifiers from the active app session", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-05-16T10:00:00.000Z"));
    appSessionFindFirstMock.mockResolvedValue({
      id: "app-session-1",
      userId: sessionUser.id,
      memberId: sessionUser.memberId,
      member: {
        id: sessionUser.memberId, userId: sessionUser.id, householdId: sessionUser.householdId,
        role: "OWNER", leftAt: null, household: { closedAt: null },
      },
      lastSeenAt: new Date("2026-05-16T09:50:00.000Z"),
      user: {
        displayName: "Person",
        email: "person@example.com",
        id: sessionUser.id,
        status: "ACTIVE",
      },
    });
    const callbacks = await getAuthCallbacks();

    const session = await callbacks.session({
      session: { user: {} },
      token: {
        appSessionId: "app-session-1",
        email: "stale@example.com",
        householdId: "stale-household",
        memberId: "stale-member",
        name: "Stale",
        sub: sessionUser.id,
      },
    });

    expect(session.user).toMatchObject({
      email: "person@example.com",
      householdId: sessionUser.householdId,
      id: sessionUser.id,
      memberId: sessionUser.memberId,
      name: "Person",
    });
    expect(appSessionUpdateManyMock).toHaveBeenCalledWith({
      data: {
        lastSeenAt: new Date("2026-05-16T10:00:00.000Z"),
      },
      where: {
        id: "app-session-1",
        revokedAt: null,
      },
    });
    vi.useRealTimers();
  });
});
