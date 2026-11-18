import { ImportDraftStatus } from "@prisma/client";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { ManagedImportCategoryMapping, ManagedImportCategoryMappingChange } from "@/lib/imports/category-mapping-management";

vi.mock("@/app/account/actions", () => ({ finishReauthenticationAction: vi.fn() }));

const { requireAppSessionMock, getImportDraftSummaryMock, getServerLocaleMock,
  getMappingManagementMock, saveManagedMappingsMock, recordAppEventMock,
  categoryFindManyMock, householdMemberFindManyMock, ledgerFindManyMock, ConflictError } = vi.hoisted(() => ({
  requireAppSessionMock: vi.fn(),
  getImportDraftSummaryMock: vi.fn(),
  getServerLocaleMock: vi.fn(),
  getMappingManagementMock: vi.fn(),
  saveManagedMappingsMock: vi.fn(),
  recordAppEventMock: vi.fn(),
  categoryFindManyMock: vi.fn(),
  householdMemberFindManyMock: vi.fn(),
  ledgerFindManyMock: vi.fn(),
  ConflictError: class ImportCategoryMappingConflictError extends Error {},
}));

vi.mock("next/link", () => ({
  default: ({ children, href, ...props }: React.ComponentProps<"a">) =>
    createElement("a", { href, ...props }, children),
}));
vi.mock("next/navigation", () => ({
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
  usePathname: () => "/records/import",
  useSearchParams: () => new URLSearchParams(),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/auth/session", () => ({ requireAppSession: requireAppSessionMock }));
vi.mock("@/lib/auth/household-context", () => ({
  resolveHouseholdContext: vi.fn(async (_client, session) => ({
    ...session, userId: session.id, role: "OWNER", ledgerId: "ledger-1", ledgerName: "Default",
  })),
}));
vi.mock("@/lib/i18n-server", () => ({ getServerLocale: getServerLocaleMock }));
vi.mock("@/lib/imports/drafts", () => ({ getImportDraftSummary: getImportDraftSummaryMock }));
vi.mock("@/lib/imports/category-mapping-management", () => ({
  getImportCategoryMappingManagement: getMappingManagementMock,
  saveManagedImportCategoryMappings: saveManagedMappingsMock,
  ImportCategoryMappingConflictError: ConflictError,
}));
vi.mock("@/lib/ops/record-event", () => ({ recordAppEvent: recordAppEventMock }));
vi.mock("@/lib/db", () => ({
  db: {
    category: { findMany: categoryFindManyMock },
    householdMember: { findMany: householdMemberFindManyMock },
    ledger: { findMany: ledgerFindManyMock },
  },
}));
vi.mock("@/app/(app)/records/import/actions", () => ({
  confirmImportReviewDraft: vi.fn(),
  getImportCandidateDetail: vi.fn(),
  saveImportMappingChanges: vi.fn(),
  saveImportMemberMappings: vi.fn(),
  saveImportReviewDecisions: vi.fn(),
  savePaymentOwnerMember: vi.fn(),
  uploadImportDraft: vi.fn(),
}));

const sessionUser = { householdId: "household-1", id: "user-1", memberId: "member-1" };
const ledgerCatalog = {
  identity: { householdId: sessionUser.householdId, memberId: sessionUser.memberId },
  role: "OWNER" as const,
  ledgers: [{ id: "ledger-1", name: "Default", isDefault: true, archivedAt: null }],
  legacyDefaultLedgerId: "ledger-1",
};
const activeCategories = [
  { id: "dining", name: "Dining", type: "EXPENSE" },
  { id: "transport", name: "Transport", type: "EXPENSE" },
  { id: "salary", name: "Salary", type: "INCOME" },
];
const mappings: ManagedImportCategoryMapping[] = [
  { id: "sui-rule", source: "sui_shou_ji", transactionType: "EXPENSE",
    primaryCategory: "餐饮", secondaryCategory: "三餐", categoryId: "dining",
    categoryName: "Dining", categoryIsActive: true, updatedAt: "2026-10-09T01:00:00.001Z" },
  { id: "wechat-rule", source: "wechat_pay", transactionType: "EXPENSE",
    primaryCategory: "商户消费", secondaryCategory: "", categoryId: null,
    categoryName: null, categoryIsActive: null, updatedAt: "2026-10-09T01:00:00.002Z" },
  { id: "alipay-rule", source: "alipay", transactionType: "INCOME",
    primaryCategory: "", secondaryCategory: "工资到账", categoryId: "salary",
    categoryName: "Salary", categoryIsActive: true, updatedAt: "2026-10-09T01:00:00.003Z" },
  { id: "cmb-rule", source: "cmb", transactionType: "EXPENSE",
    primaryCategory: "快捷支付", secondaryCategory: "示例商户", categoryId: "inactive",
    categoryName: "Old category", categoryIsActive: false, updatedAt: "2026-10-09T01:00:00.004Z" },
];

function draftSummary(status: ImportDraftStatus) {
  return {
    id: "draft-1",
    source: "sui_shou_ji",
    ledgerId: "ledger-1",
    ledgerName: "Default",
    blockedReason: null,
    status,
    fileName: "saved.xlsx",
    createdAt: new Date("2026-10-09T01:00:00.000Z"),
    counts: { importable: 0, invalid: 0, needsMapping: 0, possibleDuplicate: 0,
      ready: 0, sourceDuplicate: 0, total: 0, userSkipped: 0 },
    rows: [],
    ignoredMappings: [],
    memberMappings: [],
    missingMappings: [],
    hasUnresolvedMemberMappings: false,
  };
}

beforeEach(() => {
  vi.resetAllMocks();
  requireAppSessionMock.mockResolvedValue(sessionUser);
  getServerLocaleMock.mockResolvedValue("zh-CN");
  getMappingManagementMock.mockResolvedValue({ mappings, categories: activeCategories });
  saveManagedMappingsMock.mockResolvedValue([]);
  recordAppEventMock.mockResolvedValue(undefined);
  categoryFindManyMock.mockResolvedValue([]);
  householdMemberFindManyMock.mockResolvedValue([]);
  ledgerFindManyMock.mockResolvedValue(ledgerCatalog.ledgers.map((ledger) => ({ ...ledger, acceptsLegacyDrafts: true })));
});

describe("category mapping management entry", () => {
  it.each([null, ImportDraftStatus.PENDING, ImportDraftStatus.COMPLETED])(
    "opens management without requiring upload in the %s state",
    async (status) => {
      getImportDraftSummaryMock.mockResolvedValue(status ? draftSummary(status) : null);
      const { default: ImportPage } = await import("@/app/(app)/records/import/page");
      const { LedgerProvider } = await import("@/components/ledger-provider");
      const page = materializePageView(await ImportPage({ searchParams: Promise.resolve(status ? { draft: "draft-1" } : {}) }));
      const providerProps = { catalog: ledgerCatalog } as React.ComponentProps<typeof LedgerProvider>;
      const markup = renderToStaticMarkup(createElement(LedgerProvider, providerProps, page));

      expect(markup).toContain('href="/records/import/mappings"');
      expect(markup).toContain("管理分类映射");
    },
  );
});

describe("category mapping management page", () => {
  it("offers source, transaction type and keyword filters in both languages", async () => {
    const { default: MappingPage } = await import("@/app/(app)/records/import/mappings/page");

    for (const [locale, labels] of [
      ["zh-CN", ["全部来源", "收支类型", "关键词", "清除筛选", "显示 4 / 4 条映射"]],
      ["en-US", ["All sources", "Transaction type", "Keyword", "Clear filters", "Showing 4 of 4 mappings"]],
    ] as const) {
      getServerLocaleMock.mockResolvedValue(locale);
      const markup = renderToStaticMarkup(materializePageView(await MappingPage()));
      for (const label of labels) {
        expect(markup).toContain(label);
      }
    }
  });

  it("renders all sources, original categories, ignore and inactive current targets", async () => {
    const { default: MappingPage } = await import("@/app/(app)/records/import/mappings/page");
    const markup = renderToStaticMarkup(materializePageView(await MappingPage()));

    for (const label of ["管理分类映射", "随手记", "微信支付", "支付宝", "招商银行",
      "原始主分类", "原始子分类", "当前映射", "三餐", "工资到账", "未提供", "忽略", "Old category · 已停用"]) {
      expect(markup).toContain(label);
    }
    expect(markup).toContain('href="/records/import"');
    expect(markup).toContain('id="managed-import-mappings"');
    expect(markup).toContain('<option disabled="" value="inactive" selected="">Old category · 已停用</option>');
    expect(markup).toContain("仅用于后续新建草稿");
    expect(markup).not.toContain('type="file"');
  });

  it("offers only type-matching active categories on each rule", async () => {
    const { default: MappingPage } = await import("@/app/(app)/records/import/mappings/page");
    const markup = renderToStaticMarkup(materializePageView(await MappingPage()));
    const expenseSelect = markup.match(/<select[^>]*name="managed-mapping:sui-rule"[^>]*>(.*?)<\/select>/)?.[1];
    const incomeSelect = markup.match(/<select[^>]*name="managed-mapping:alipay-rule"[^>]*>(.*?)<\/select>/)?.[1];

    expect(expenseSelect).toContain('value="dining"');
    expect(expenseSelect).toContain('value="transport"');
    expect(expenseSelect).not.toContain('value="salary"');
    expect(incomeSelect).toContain('value="salary"');
    expect(incomeSelect).not.toContain('value="dining"');
    expect(incomeSelect).not.toContain('value="inactive"');
  });

  it("shows an upload-independent empty state and return link", async () => {
    getMappingManagementMock.mockResolvedValue({ mappings: [], categories: activeCategories });
    const { default: MappingPage } = await import("@/app/(app)/records/import/mappings/page");
    const markup = renderToStaticMarkup(materializePageView(await MappingPage()));

    expect(markup).toContain("尚无保存的分类映射");
    expect(markup).toContain('href="/records/import"');
    expect(markup).not.toContain("managed-import-mappings");
    expect(markup).not.toContain("保存修改");
  });

  it("renders the English management and category names", async () => {
    getServerLocaleMock.mockResolvedValue("en-US");
    const { default: MappingPage } = await import("@/app/(app)/records/import/mappings/page");
    const markup = renderToStaticMarkup(materializePageView(await MappingPage()));

    for (const label of ["Manage category mappings", "Back to import records", "Dining", "Salary",
      "Ignore", "Inactive", "Not provided", "Save changes", "newly created drafts only"]) {
      expect(markup).toContain(label);
    }
  });

  it("rejects an invalid app session before loading household rules", async () => {
    requireAppSessionMock.mockRejectedValue(new Error("Unauthorized"));
    const { default: MappingPage } = await import("@/app/(app)/records/import/mappings/page");

    await expect(MappingPage()).rejects.toThrow("Unauthorized");
    expect(getMappingManagementMock).not.toHaveBeenCalled();
  });

  it("passes only the trusted session to the management read boundary", async () => {
    const { default: MappingPage } = await import("@/app/(app)/records/import/mappings/page");
    materializePageView(await MappingPage());

    expect(getMappingManagementMock).toHaveBeenCalledWith(sessionUser);
  });
});

describe("managed mapping save action", () => {
  const change: ManagedImportCategoryMappingChange = {
    id: "sui-rule", categoryId: null, expectedUpdatedAt: "2026-10-09T01:00:00.001Z",
  };

  it("returns the committed target and exact server version without re-reading", async () => {
    const committed = { id: "sui-rule", categoryId: null, updatedAt: "2026-10-09T01:00:00.002Z" };
    saveManagedMappingsMock.mockResolvedValue([committed]);
    getMappingManagementMock.mockRejectedValue(new Error("post-commit read unavailable"));
    const { saveManagedImportMappings } = await import("@/app/(app)/records/import/mappings/actions");

    await expect(saveManagedImportMappings([change])).resolves.toEqual({ status: "saved", mappings: [committed] });
    expect(saveManagedMappingsMock).toHaveBeenCalledWith([change], sessionUser);
    expect(getMappingManagementMock).not.toHaveBeenCalled();
  });

  it("reports a conflict with a fixed result and no private error detail", async () => {
    saveManagedMappingsMock.mockRejectedValue(new ConflictError("private mapping data"));
    const { saveManagedImportMappings } = await import("@/app/(app)/records/import/mappings/actions");

    await expect(saveManagedImportMappings([change])).resolves.toEqual({ status: "conflict" });
  });

  it("reports a determinate service failure using a fixed retryable result", async () => {
    saveManagedMappingsMock.mockRejectedValue(new Error("private database detail"));
    const { saveManagedImportMappings } = await import("@/app/(app)/records/import/mappings/actions");

    await expect(saveManagedImportMappings([change])).resolves.toEqual({ status: "failed" });
  });

  it("does not write rules when app authentication fails", async () => {
    requireAppSessionMock.mockRejectedValue(new Error("private auth detail"));
    const { saveManagedImportMappings } = await import("@/app/(app)/records/import/mappings/actions");

    await expect(saveManagedImportMappings([change])).resolves.toEqual({ status: "failed" });
    expect(saveManagedMappingsMock).not.toHaveBeenCalled();
  });

  it.each([null, {}, "bad", [null], [{ ...change, id: "" }], [{ ...change, categoryId: "" }],
    [{ ...change, categoryId: undefined }], [{ ...change, categoryId: 3 }],
    [{ ...change, expectedUpdatedAt: "" }], [{ ...change, expectedUpdatedAt: 3 }]])(
    "rejects malformed input without revealing details: %j", async (input) => {
      const { saveManagedImportMappings } = await import("@/app/(app)/records/import/mappings/actions");

      await expect(saveManagedImportMappings(input as ManagedImportCategoryMappingChange[])).resolves.toEqual({ status: "failed" });
      expect(saveManagedMappingsMock).not.toHaveBeenCalled();
    },
  );

  it("allows the service to validate the trusted member on an empty batch", async () => {
    const { saveManagedImportMappings } = await import("@/app/(app)/records/import/mappings/actions");

    await expect(saveManagedImportMappings([])).resolves.toEqual({ status: "saved", mappings: [] });
    expect(saveManagedMappingsMock).toHaveBeenCalledWith([], sessionUser);
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
