import { ImportDraftRowStatus, ImportDraftStatus, ImportRowDecision, TransactionType } from "@prisma/client";
import { Children, createElement, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/account/actions", () => ({ finishReauthenticationAction: vi.fn() }));

const {
  categoryFindManyMock,
  confirmImportDraftMock,
  createAlipayImportDraftMock,
  createCmbImportDraftMock,
  createSuiShouJiImportDraftMock,
  createWechatPayImportDraftMock,
  getImportDraftSummaryMock,
  getImportDuplicateCandidateMock,
  getServerLocaleMock,
  householdFindUniqueOrThrowMock,
  householdMemberFindManyMock,
  importDraftFindFirstOrThrowMock,
  listRecordsMock,
  reportRangeControlsMock,
  redirectMock,
  recordAppEventMock,
  requireAppSessionMock,
  saveImportDraftMappingsMock,
  saveImportDraftMemberMappingsMock,
  savePaymentImportDraftOwnerMemberMock,
  saveWechatPayDraftOwnerMemberMock,
  setImportDraftRowDecisionsMock,
  transactionFindFirstMock,
} = vi.hoisted(() => ({
  categoryFindManyMock: vi.fn(),
  confirmImportDraftMock: vi.fn(),
  createAlipayImportDraftMock: vi.fn(),
  createCmbImportDraftMock: vi.fn(),
  createSuiShouJiImportDraftMock: vi.fn(),
  createWechatPayImportDraftMock: vi.fn(),
  getImportDraftSummaryMock: vi.fn(),
  getImportDuplicateCandidateMock: vi.fn(),
  getServerLocaleMock: vi.fn(),
  householdFindUniqueOrThrowMock: vi.fn(),
  householdMemberFindManyMock: vi.fn(),
  importDraftFindFirstOrThrowMock: vi.fn(),
  listRecordsMock: vi.fn(),
  reportRangeControlsMock: vi.fn(() =>
    createElement("div", { "data-testid": "report-range-controls" }),
  ),
  redirectMock: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  recordAppEventMock: vi.fn(),
  requireAppSessionMock: vi.fn(),
  saveImportDraftMappingsMock: vi.fn(),
  saveImportDraftMemberMappingsMock: vi.fn(),
  savePaymentImportDraftOwnerMemberMock: vi.fn(),
  saveWechatPayDraftOwnerMemberMock: vi.fn(),
  setImportDraftRowDecisionsMock: vi.fn(),
  transactionFindFirstMock: vi.fn(),
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

vi.mock("next/dist/client/components/redirect-error", () => ({
  isRedirectError: (error: unknown) =>
    error instanceof Error && error.message.startsWith("REDIRECT:"),
}));

vi.mock("@/lib/i18n-server", () => ({
  getServerLocale: getServerLocaleMock,
}));

vi.mock("@/lib/auth/session", () => ({
  requireAppSession: requireAppSessionMock,
}));

vi.mock("@/lib/auth/household-context", () => ({
  resolveHouseholdContext: vi.fn(async (_client, session) => ({
    ...session, userId: session.id, role: "OWNER", ledgerId: "ledger-1", ledgerName: "Default",
  })),
}));

vi.mock("@/lib/ledgers/server", () => ({
  resolveLedgerPageContext: async (session: typeof sessionUser, params?: Record<string, string | string[] | undefined>) => {
    const ledgerId = typeof params?.entryLedger === "string" ? params.entryLedger : "ledger-1";
    const scope = typeof params?.ledger === "string" && params.ledger !== "all"
      ? { kind: "ledger", ledgerId: params.ledger } : { kind: "household" };
    return { scope, entryLedgerId: ledgerId,
      ledgers: [{ id: ledgerId, name: "Default", isDefault: true, archivedAt: null }],
      context: { householdId: session.householdId, memberId: session.memberId, ledgerId },
      ledgerName: ledgerId === "ledger-1" ? "Default" : "Selected ledger" };
  },
}));

vi.mock("@/lib/db", () => ({
  db: {
    category: { findMany: categoryFindManyMock },
    household: { findUniqueOrThrow: householdFindUniqueOrThrowMock },
    householdMember: { findMany: householdMemberFindManyMock },
    importDraft: { findFirstOrThrow: importDraftFindFirstOrThrowMock },
    transaction: { findFirst: transactionFindFirstMock },
  },
}));

vi.mock("@/lib/records/list-records", () => ({
  listRecords: listRecordsMock,
  RECORDS_PAGE_SIZE: 100,
}));

vi.mock("@/lib/ops/record-event", () => ({
  recordAppEvent: recordAppEventMock,
}));

vi.mock("@/lib/imports/drafts", () => ({
  confirmImportDraft: confirmImportDraftMock,
  createAlipayImportDraft: createAlipayImportDraftMock,
  createCmbImportDraft: createCmbImportDraftMock,
  createSuiShouJiImportDraft: createSuiShouJiImportDraftMock,
  createWechatPayImportDraft: createWechatPayImportDraftMock,
  getImportDraftSummary: getImportDraftSummaryMock,
  getImportDuplicateCandidate: getImportDuplicateCandidateMock,
  saveImportDraftMappings: saveImportDraftMappingsMock,
  saveImportDraftMemberMappings: saveImportDraftMemberMappingsMock,
  savePaymentImportDraftOwnerMember: savePaymentImportDraftOwnerMemberMock,
  saveWechatPayDraftOwnerMember: saveWechatPayDraftOwnerMemberMock,
  setImportDraftRowDecisions: setImportDraftRowDecisionsMock,
}));

vi.mock("@/components/records-filter-bar", () => ({
  RecordsFilterBar: () => createElement("div", { "data-testid": "records-filter-bar" }),
}));

vi.mock("@/components/report-range-controls", () => ({
  ReportRangeControls: reportRangeControlsMock,
}));

vi.mock("@/components/transaction-editor-drawer", () => ({
  TransactionEditorDrawer: () => createElement("div", { "data-testid": "record-drawer" }),
}));

vi.mock("@/components/ledger-switcher", () => ({ LedgerEntrySelector: () => null }));

const sessionUser = {
  householdId: "household-1",
  id: "user-1",
  memberId: "member-1",
};

const uploadContext = { householdId: sessionUser.householdId, memberId: sessionUser.memberId, ledgerId: "ledger-1" };
function uploadFormData() {
  const form = new FormData();
  form.set("context", JSON.stringify(uploadContext));
  return form;
}

const activeCategories = [
  { id: "category-expense", name: "Dining", type: "EXPENSE" },
  { id: "category-income", name: "Salary", type: "INCOME" },
];

function primeSharedMocks() {
  requireAppSessionMock.mockResolvedValue(sessionUser);
  getServerLocaleMock.mockResolvedValue("zh-CN");
  categoryFindManyMock.mockResolvedValue(activeCategories);
  householdMemberFindManyMock.mockResolvedValue([
    { id: "member-1", memberName: "老公" },
    { id: "member-2", memberName: "老婆" },
  ]);
}

function primeRecordsMocks() {
  householdFindUniqueOrThrowMock.mockResolvedValue({ timezone: "Asia/Shanghai" });
  householdMemberFindManyMock.mockResolvedValue([
    { id: "member-1", memberName: "老公" },
    { id: "member-2", memberName: "老婆" },
  ]);
  listRecordsMock.mockResolvedValue([]);
  transactionFindFirstMock.mockResolvedValue(null);
}

function buildPendingDraftSummary(overrides: Record<string, unknown> = {}) {
  return {
    blockedReason: null,
    counts: {
      importable: 1,
      invalid: 0,
      needsMapping: 1,
      possibleDuplicate: 1,
      ready: 0,
      sourceDuplicate: 2,
      total: 2,
      userSkipped: 0,
    },
    createdAt: new Date("2026-05-06T01:00:00.000Z"),
    fileName: "sui-shou-ji.xlsx",
    hasUnresolvedMemberMappings: false,
    id: "draft-1",
    ledgerId: "ledger-original",
    ledgerName: "Default",
    ignoredMappings: [],
    memberMappings: [],
    missingMappings: [
      {
        count: 1,
        mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐",
        primaryCategory: "餐饮",
        secondaryCategory: "三餐",
        transactionType: TransactionType.EXPENSE,
      },
    ],
    rows: [
      {
        actorFallbackApplied: false,
        actorExternalName: null,
        actorMemberId: "member-1",
        amountFen: 17600,
        categoryId: "category-expense",
        createdByMemberId: "member-1",
        creatorExternalName: null,
        creatorFallbackApplied: false,
        duplicateCandidates: [
          {
            amountFen: 17600,
            categoryId: "category-expense",
            id: "record-1",
            occurredAt: "2026-05-06T02:30:00.000Z",
            source: null,
            type: TransactionType.EXPENSE,
          },
          {
            amountFen: 17600,
            categoryId: "category-expense",
            id: "record-2",
            occurredAt: "2026-05-06T03:30:00.000Z",
            source: "wechat_pay",
            type: TransactionType.EXPENSE,
          },
          {
            amountFen: 17600,
            categoryId: "category-expense",
            id: "record-3",
            occurredAt: "2026-05-06T04:30:00.000Z",
            source: "other_source",
            type: TransactionType.EXPENSE,
          },
        ],
        id: "row-duplicate",
        mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐",
        note: "午饭",
        occurredAt: new Date("2026-05-06T05:23:02.000Z"),
        occurredDate: "2026-05-06",
        primaryCategory: "餐饮",
        rawCreatedBy: "老公",
        rawMember: "老公",
        rowNumber: 2,
        secondaryCategory: "三餐",
        skipReason: null,
        sourceFingerprint: "fingerprint-1",
        status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
        transactionType: TransactionType.EXPENSE,
        userDecision: ImportRowDecision.KEEP,
      },
    ],
    source: "sui_shou_ji",
    status: ImportDraftStatus.PENDING,
    ...overrides,
  };
}

function findElementsByType(node: ReactNode, type: "form") {
  const matches: ReactElement<React.ComponentProps<"form">>[] = [];

  function visit(value: ReactNode) {
    Children.forEach(value, (child) => {
      if (!isValidElement(child)) {
        return;
      }

      const element = child as ReactElement<{ children?: ReactNode }>;

      if (element.type === type || (typeof element.type === "function" && element.type.name === "EncryptedForm")) {
        matches.push(element as ReactElement<React.ComponentProps<"form">>);
      }

      visit(element.props.children);
    });
  }

  visit(node);

  return matches;
}

describe("Records import entry", () => {
  beforeEach(() => {
    vi.resetModules();
    redirectMock.mockClear();
    recordAppEventMock.mockReset();
    recordAppEventMock.mockResolvedValue(undefined);
    categoryFindManyMock.mockReset();
    householdFindUniqueOrThrowMock.mockReset();
    householdMemberFindManyMock.mockReset();
    listRecordsMock.mockReset();
    reportRangeControlsMock.mockClear();
    requireAppSessionMock.mockReset();
    transactionFindFirstMock.mockReset();
    primeSharedMocks();
    primeRecordsMocks();
  });

  it("renders an import entry that links to the records import page", async () => {
    const { default: RecordsPage } = await import("@/app/(app)/records/page");
    const markup = renderToStaticMarkup(
      materializePageView(await RecordsPage({
        searchParams: Promise.resolve({ mode: "month", month: "2026-04", year: "2026" }),
      })),
    );

    expect(markup).toContain("导入");
    expect(markup).toContain("href=\"/records/import?ledger=all&amp;entryLedger=ledger-1\"");
  });
});

describe("records import actions", () => {
  beforeEach(() => {
    vi.resetModules();
    redirectMock.mockClear();
    recordAppEventMock.mockReset();
    recordAppEventMock.mockResolvedValue(undefined);
    confirmImportDraftMock.mockReset();
    confirmImportDraftMock.mockResolvedValue({
      completedNow: true,
      createdCount: 1,
      source: "sui_shou_ji",
    });
    createAlipayImportDraftMock.mockReset();
    createCmbImportDraftMock.mockReset();
    createSuiShouJiImportDraftMock.mockReset();
    createWechatPayImportDraftMock.mockReset();
    importDraftFindFirstOrThrowMock.mockReset();
    importDraftFindFirstOrThrowMock.mockResolvedValue({ source: "sui_shou_ji" });
    requireAppSessionMock.mockReset();
    saveImportDraftMappingsMock.mockReset();
    saveImportDraftMemberMappingsMock.mockReset();
    savePaymentImportDraftOwnerMemberMock.mockReset();
    saveWechatPayDraftOwnerMemberMock.mockReset();
    setImportDraftRowDecisionsMock.mockReset();
    getImportDuplicateCandidateMock.mockReset();
    primeSharedMocks();
  });

  it("requires an explicit ledger context before accepting a new upload", async () => {
    const formData = new FormData();
    formData.set("source", "sui_shou_ji");
    formData.set("file", new File([new Uint8Array([1, 2, 3])], "export.xlsx"));
    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow("REDIRECT:/records/import?error=missing-context");
    expect(createSuiShouJiImportDraftMock).not.toHaveBeenCalled();
  });

  it("uploads a Sui Shou Ji .xlsx file when the selected source is Sui Shou Ji", async () => {
    createSuiShouJiImportDraftMock.mockResolvedValue({ id: "draft-1" });
    const formData = uploadFormData();
    formData.set("source", "sui_shou_ji");
    formData.set("file", new File([new Uint8Array([1, 2, 3])], "export.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );
    expect(createSuiShouJiImportDraftMock).toHaveBeenCalledWith({
      context: uploadContext,
      buffer: expect.any(Buffer),
      fileName: "export.xlsx",
      sessionUser,
    });
    expect(createWechatPayImportDraftMock).not.toHaveBeenCalled();
  });

  it("keeps the legacy Sui Shou Ji upload action compatible before source is submitted", async () => {
    createSuiShouJiImportDraftMock.mockResolvedValue({ id: "draft-1" });
    const formData = uploadFormData();
    formData.set("file", new File([new Uint8Array([1, 2, 3])], "export.xlsx"));

    const { uploadSuiShouJiImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadSuiShouJiImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );
    expect(createSuiShouJiImportDraftMock).toHaveBeenCalledWith({
      context: uploadContext,
      buffer: expect.any(Buffer),
      fileName: "export.xlsx",
      sessionUser,
    });
    expect(createWechatPayImportDraftMock).not.toHaveBeenCalled();
  });

  it("uploads a WeChat Pay .xlsx file when the selected source is WeChat Pay", async () => {
    createWechatPayImportDraftMock.mockResolvedValue({ id: "wechat-draft" });
    const formData = uploadFormData();
    formData.set("source", "wechat_pay");
    formData.set("file", new File([new Uint8Array([1, 2, 3])], "wechat.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=wechat-draft",
    );
    expect(createWechatPayImportDraftMock).toHaveBeenCalledWith({
      context: uploadContext,
      buffer: expect.any(Buffer),
      fileName: "wechat.xlsx",
      sessionUser,
    });
    expect(createSuiShouJiImportDraftMock).not.toHaveBeenCalled();
  });

  it("uploads an Alipay .csv file when the selected source is Alipay", async () => {
    createAlipayImportDraftMock.mockResolvedValue({ id: "alipay-draft" });
    const formData = uploadFormData();
    formData.set("source", "alipay");
    formData.set("file", new File([new Uint8Array([1, 2, 3])], "alipay.csv"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=alipay-draft",
    );
    expect(createAlipayImportDraftMock).toHaveBeenCalledWith({
      context: uploadContext,
      buffer: expect.any(Buffer),
      fileName: "alipay.csv",
      sessionUser,
    });
    expect(createSuiShouJiImportDraftMock).not.toHaveBeenCalled();
    expect(createWechatPayImportDraftMock).not.toHaveBeenCalled();
  });

  it("uploads a CMB .pdf file when the selected source is CMB", async () => {
    createCmbImportDraftMock.mockResolvedValue({ id: "cmb-draft" });
    const formData = uploadFormData();
    formData.set("source", "cmb");
    formData.set("file", new File([new Uint8Array([1, 2, 3])], "statement.pdf"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=cmb-draft",
    );
    expect(createCmbImportDraftMock).toHaveBeenCalledWith({
      context: uploadContext,
      buffer: expect.any(Buffer),
      fileName: "statement.pdf",
      sessionUser,
    });
  });

  it("uploads a password-protected CMB .zip file and keeps the password out of the event", async () => {
    createCmbImportDraftMock.mockResolvedValue({ id: "cmb-zip-draft" });
    const formData = uploadFormData();
    formData.set("source", "cmb");
    formData.set("file", new File([new Uint8Array([1, 2, 3])], "statement.zip"));
    formData.set("zipPassword", "secret-password");

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=cmb-zip-draft",
    );
    expect(createCmbImportDraftMock).toHaveBeenCalledWith({
      context: uploadContext,
      buffer: expect.any(Buffer),
      fileName: "statement.zip",
      password: "secret-password",
      sessionUser,
    });
    expect(recordAppEventMock).toHaveBeenCalledWith(
      expect.objectContaining({ metadata: { source: "cmb" } }),
    );
    expect(JSON.stringify(recordAppEventMock.mock.calls)).not.toContain("secret-password");
  });

  it("redirects when import source is missing", async () => {
    const formData = uploadFormData();
    formData.set("file", new File([new Uint8Array([1])], "export.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=missing-source",
    );
    expect(createSuiShouJiImportDraftMock).not.toHaveBeenCalled();
    expect(createWechatPayImportDraftMock).not.toHaveBeenCalled();
  });

  it("redirects unsupported files without creating a draft", async () => {
    const formData = uploadFormData();
    formData.set("source", "sui_shou_ji");
    formData.set("file", new File([new Uint8Array([1])], "export.csv"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unsupported-file",
    );
    expect(createSuiShouJiImportDraftMock).not.toHaveBeenCalled();
  });

  it("rejects Alipay uploads that are not .csv files", async () => {
    const formData = uploadFormData();
    formData.set("source", "alipay");
    formData.set("file", new File([new Uint8Array([1])], "alipay.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unsupported-alipay-file",
    );
    expect(createAlipayImportDraftMock).not.toHaveBeenCalled();
  });

  it("rejects CMB uploads that are not .pdf or .zip files", async () => {
    const formData = uploadFormData();
    formData.set("source", "cmb");
    formData.set("file", new File([new Uint8Array([1])], "statement.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unsupported-cmb-file",
    );
    expect(createCmbImportDraftMock).not.toHaveBeenCalled();
  });

  it("keeps .xlsx validation for Sui Shou Ji and WeChat Pay", async () => {
    const formData = uploadFormData();
    formData.set("source", "wechat_pay");
    formData.set("file", new File([new Uint8Array([1])], "wechat.csv"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unsupported-file",
    );
    expect(createWechatPayImportDraftMock).not.toHaveBeenCalled();
  });

  it("redirects oversized files without reading or creating a draft", async () => {
    const formData = uploadFormData();
    formData.set("source", "sui_shou_ji");
    formData.set("file", new File([new Uint8Array(20 * 1024 * 1024 + 1)], "export.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=file-too-large",
    );
    expect(requireAppSessionMock).not.toHaveBeenCalled();
    expect(createSuiShouJiImportDraftMock).not.toHaveBeenCalled();
  });

  it("maps unrecognized workbook errors to the unrecognized-file redirect", async () => {
    createSuiShouJiImportDraftMock.mockRejectedValue(new Error("无法识别随手记导出格式"));
    const formData = uploadFormData();
    formData.set("source", "sui_shou_ji");
    formData.set("file", new File([new Uint8Array([1])], "export.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unrecognized-file",
    );
  });

  it.each(["xlsx-resource-limit", "xlsx-timeout", "xlsx-busy", "unreadable-xlsx-file"])(
    "shows a safe retry message for %s without recording a successful upload",
    async (code) => {
      createWechatPayImportDraftMock.mockRejectedValue(new Error(code));
      const formData = uploadFormData();
      formData.set("source", "wechat_pay");
      formData.set("file", new File([new Uint8Array([1])], "wechat.xlsx"));
      const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");
      await expect(uploadImportDraft(formData)).rejects.toThrow(`REDIRECT:/records/import?error=${code}`);
      expect(recordAppEventMock).not.toHaveBeenCalled();
    },
  );

  it("maps WeChat Pay unrecognized workbook errors to the WeChat error redirect", async () => {
    createWechatPayImportDraftMock.mockRejectedValue(new Error("无法识别微信支付账单格式"));
    const formData = uploadFormData();
    formData.set("source", "wechat_pay");
    formData.set("file", new File([new Uint8Array([1])], "wechat.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unrecognized-wechat-pay-file",
    );
  });

  it("maps Alipay unrecognized CSV errors to the Alipay error redirect", async () => {
    createAlipayImportDraftMock.mockRejectedValue(new Error("无法识别支付宝账单格式"));
    const formData = uploadFormData();
    formData.set("source", "alipay");
    formData.set("file", new File([new Uint8Array([1])], "alipay.csv"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unrecognized-alipay-file",
    );
  });

  it("maps CMB parser errors to the CMB error redirect", async () => {
    createCmbImportDraftMock.mockRejectedValue(new Error("无法识别招商银行流水格式"));
    const formData = uploadFormData();
    formData.set("source", "cmb");
    formData.set("file", new File([new Uint8Array([1])], "statement.pdf"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unrecognized-cmb-file",
    );
  });

  it("redirects a CMB ZIP upload without reading the file or creating a draft when the password is missing", async () => {
    const missingPasswordFormData = uploadFormData();
    missingPasswordFormData.set("source", "cmb");
    missingPasswordFormData.set("file", new File([new Uint8Array([1])], "statement.zip"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(missingPasswordFormData)).rejects.toThrow(
      "REDIRECT:/records/import?error=missing-cmb-zip-password",
    );
    expect(requireAppSessionMock).not.toHaveBeenCalled();
    expect(createCmbImportDraftMock).not.toHaveBeenCalled();
  });

  it("maps an invalid CMB ZIP sentinel to a safe redirect", async () => {
    createCmbImportDraftMock.mockRejectedValueOnce(new Error("无法读取招商银行 ZIP 账单"));
    const unreadableFormData = uploadFormData();
    unreadableFormData.set("source", "cmb");
    unreadableFormData.set("file", new File([new Uint8Array([1])], "statement.zip"));
    unreadableFormData.set("zipPassword", "secret-password");

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(unreadableFormData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unreadable-cmb-zip-file",
    );
  });

  it("maps parser size errors to the file-too-large redirect", async () => {
    createSuiShouJiImportDraftMock.mockRejectedValue(new Error("Import file is too large"));
    const formData = uploadFormData();
    formData.set("source", "sui_shou_ji");
    formData.set("file", new File([new Uint8Array([1])], "export.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=file-too-large",
    );
  });

  it("saves payment owner member selection and redirects back to the draft", async () => {
    const formData = uploadFormData();
    formData.set("draftId", "draft-1");
    formData.set("ownerMemberId", "member-2");

    const { savePaymentOwnerMember } = await import("@/app/(app)/records/import/actions");

    await expect(savePaymentOwnerMember(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );
    expect(savePaymentImportDraftOwnerMemberMock).toHaveBeenCalledWith(
      "draft-1",
      "member-2",
      sessionUser,
    );
  });

  it("saves category mappings from mapping entries and redirects back to the draft", async () => {
    const formData = uploadFormData();
    formData.set("draftId", "draft-1");
    formData.set("mapping:sui_shou_ji|EXPENSE|餐饮|三餐", "category-expense");
    formData.set("mapping:sui_shou_ji|INCOME|职业收入|工资", "category-income");

    const { saveImportMappings } = await import("@/app/(app)/records/import/actions");

    await expect(saveImportMappings(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );
    expect(saveImportDraftMappingsMock).toHaveBeenCalledWith(
      "draft-1",
      [
        {
          categoryId: "category-expense",
          mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐",
        },
        {
          categoryId: "category-income",
          mappingKey: "sui_shou_ji|INCOME|职业收入|工资",
        },
      ],
      sessionUser,
    );
  });

  it("converts the category ignore option to an explicit null and leaves empty choices unmapped", async () => {
    const formData = uploadFormData();
    formData.set("draftId", "draft-1");
    formData.set("mapping:sui_shou_ji|EXPENSE|餐饮|三餐", "__ignore__");
    formData.set("mapping:sui_shou_ji|INCOME|职业收入|工资", "category-income");
    formData.set("mapping:sui_shou_ji|EXPENSE|交通|公交", "");

    const { saveImportMappings } = await import("@/app/(app)/records/import/actions");

    await expect(saveImportMappings(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );
    expect(saveImportDraftMappingsMock).toHaveBeenCalledWith(
      "draft-1",
      [
        { categoryId: null, mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐" },
        { categoryId: "category-income", mappingKey: "sui_shou_ji|INCOME|职业收入|工资" },
      ],
      sessionUser,
    );
  });

  it("saves only the explicit mapping changes with the authenticated household", async () => {
    const { getImportMappingChanges, getImportMappingGroups } = await import("@/lib/imports/mapping-form");
    const ignoredGroup = buildPendingDraftSummary().missingMappings[0];
    const missingGroup = {
      ...ignoredGroup,
      mappingKey: "sui_shou_ji|INCOME|职业收入|工资",
      primaryCategory: "职业收入",
      secondaryCategory: "工资",
      transactionType: TransactionType.INCOME,
    };
    const changes = getImportMappingChanges(
      getImportMappingGroups([missingGroup], [ignoredGroup]),
      { [ignoredGroup.mappingKey]: "__ignore__", [missingGroup.mappingKey]: "category-income" },
    );
    const { saveImportMappingChanges } = await import("@/app/(app)/records/import/actions");

    expect(await saveImportMappingChanges("draft-1", changes)).toEqual({ success: true });
    expect(saveImportDraftMappingsMock).toHaveBeenCalledWith(
      "draft-1", [{ mappingKey: missingGroup.mappingKey, categoryId: "category-income" }], sessionUser,
    );
    expect(getImportDraftSummaryMock).not.toHaveBeenCalled();
  });

  it("saves a structured mixture of ignored and real categories without supplementing other groups", async () => {
    const changes = [
      { mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐", categoryId: null },
      { mappingKey: "sui_shou_ji|INCOME|职业收入|工资", categoryId: "category-income" },
    ];
    const { saveImportMappingChanges } = await import("@/app/(app)/records/import/actions");

    expect(await saveImportMappingChanges("draft-1", changes)).toEqual({ success: true });
    expect(saveImportDraftMappingsMock).toHaveBeenCalledWith("draft-1", changes, sessionUser);
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("does not write mappings when the change set is empty", async () => {
    const { saveImportMappingChanges } = await import("@/app/(app)/records/import/actions");

    expect(await saveImportMappingChanges("draft-1", [])).toEqual({ success: true });
    expect(requireAppSessionMock).toHaveBeenCalledTimes(1);
    expect(saveImportDraftMappingsMock).not.toHaveBeenCalled();
  });

  it("returns a fixed safe mapping error and permits the same changes to be retried", async () => {
    const changes = [{ mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐", categoryId: null }];
    saveImportDraftMappingsMock.mockRejectedValueOnce(new Error("Private database connection details"));
    const { saveImportMappingChanges } = await import("@/app/(app)/records/import/actions");

    expect(await saveImportMappingChanges("draft-1", changes)).toEqual({
      success: false, error: "IMPORT_MAPPING_SAVE_FAILED",
    });
    expect(await saveImportMappingChanges("draft-1", changes)).toEqual({ success: true });
    expect(saveImportDraftMappingsMock).toHaveBeenNthCalledWith(1, "draft-1", changes, sessionUser);
    expect(saveImportDraftMappingsMock).toHaveBeenNthCalledWith(2, "draft-1", changes, sessionUser);
  });

  it("rejects unauthenticated structured mapping saves before invoking the service", async () => {
    requireAppSessionMock.mockRejectedValue(new Error("Unauthorized"));
    const { saveImportMappingChanges } = await import("@/app/(app)/records/import/actions");

    expect(await saveImportMappingChanges("draft-1", [
      { mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐", categoryId: null },
    ])).toEqual({ success: false, error: "IMPORT_MAPPING_SAVE_FAILED" });
    expect(saveImportDraftMappingsMock).not.toHaveBeenCalled();
  });

  it("rejects an empty structured category choice without turning it into ignore", async () => {
    const { saveImportMappingChanges } = await import("@/app/(app)/records/import/actions");

    expect(await saveImportMappingChanges("draft-1", [
      { mappingKey: "sui_shou_ji|EXPENSE|餐饮|三餐", categoryId: "" },
    ])).toEqual({ success: false, error: "IMPORT_MAPPING_SAVE_FAILED" });
    expect(saveImportDraftMappingsMock).not.toHaveBeenCalled();
  });

  it("saves import member mappings from member mapping entries and redirects back to the draft", async () => {
    const formData = uploadFormData();
    formData.set("draftId", "draft-1");
    formData.set("memberMapping:随手记老婆", "member-2");

    const { saveImportMemberMappings } = await import("@/app/(app)/records/import/actions");

    await expect(saveImportMemberMappings(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );
    expect(saveImportDraftMemberMappingsMock).toHaveBeenCalledWith(
      "draft-1",
      [{ externalName: "随手记老婆", memberId: "member-2" }],
      sessionUser,
    );
  });

  it("saves duplicate row decisions from decision entries and redirects back to the draft", async () => {
    const formData = uploadFormData();
    formData.set("draftId", "draft-1");
    formData.set("decision:row-1", "KEEP");
    formData.set("decision:row-2", "SKIP");

    const { saveImportDecisions } = await import("@/app/(app)/records/import/actions");

    await expect(saveImportDecisions(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );
    expect(setImportDraftRowDecisionsMock).toHaveBeenCalledWith(
      "draft-1",
      [
        { rowId: "row-1", decision: ImportRowDecision.KEEP },
        { rowId: "row-2", decision: ImportRowDecision.SKIP },
      ],
      sessionUser,
    );
  });

  it("reports review save failure without redirecting or treating the choices as saved", async () => {
    setImportDraftRowDecisionsMock.mockRejectedValue(new Error("Import draft row not found"));
    const { saveImportReviewDecisions } = await import("@/app/(app)/records/import/actions");

    await expect(
      saveImportReviewDecisions("draft-1", [{ rowId: "row-1", decision: ImportRowDecision.SKIP }]),
    ).resolves.toEqual({ success: false });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("reports a saved review batch without discarding its navigation state through a redirect", async () => {
    setImportDraftRowDecisionsMock.mockResolvedValue(undefined);
    const { saveImportReviewDecisions } = await import("@/app/(app)/records/import/actions");

    await expect(
      saveImportReviewDecisions("draft-1", [{ rowId: "row-1", decision: ImportRowDecision.SKIP }]),
    ).resolves.toEqual({ success: true });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("returns serializable original record details only after candidate authorization", async () => {
    getImportDuplicateCandidateMock.mockResolvedValue({
      id: "record-1",
      amountFen: 17600,
      occurredAt: new Date("2024-05-06T02:30:00.000Z"),
      type: TransactionType.EXPENSE,
      source: null,
      categoryName: "Dining",
      actorMemberName: "老婆",
      createdByMemberName: "老公",
      note: "Original lunch",
    });
    const { getImportCandidateDetail } = await import("@/app/(app)/records/import/actions");

    await expect(getImportCandidateDetail("draft-1", "row-1", "record-1")).resolves.toEqual({
      success: true,
      record: {
        id: "record-1",
        amountFen: 17600,
        occurredAt: "2024-05-06T02:30:00.000Z",
        type: TransactionType.EXPENSE,
        source: null,
        categoryName: "Dining",
        actorMemberName: "老婆",
        createdByMemberName: "老公",
        note: "Original lunch",
      },
    });
    expect(getImportDuplicateCandidateMock).toHaveBeenCalledWith(
      "draft-1", "row-1", "record-1", sessionUser,
    );
  });

  it("does not return original record details when the candidate is unavailable", async () => {
    getImportDuplicateCandidateMock.mockResolvedValue(null);
    const { getImportCandidateDetail } = await import("@/app/(app)/records/import/actions");

    await expect(getImportCandidateDetail("draft-1", "row-1", "record-1")).resolves.toEqual({
      success: false,
    });
  });

  it("confirms the draft and redirects to the completed query", async () => {
    const formData = uploadFormData();
    formData.set("draftId", "draft-1");

    const { confirmImportDraftAction } = await import("@/app/(app)/records/import/actions");

    await expect(confirmImportDraftAction(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1&completed=1",
    );
    expect(confirmImportDraftMock).toHaveBeenCalledWith("draft-1", sessionUser);
  });

  it("preserves the draft and returns a retryable busy result without recording success", async () => {
    const { ResourceBusyError } = await import("@/lib/resources/admission");
    confirmImportDraftMock.mockRejectedValue(new ResourceBusyError());
    const { confirmImportReviewDraft, confirmImportDraftAction } = await import("@/app/(app)/records/import/actions");
    expect(await confirmImportReviewDraft("draft-1")).toEqual({ success: false, error: "BUSY" });
    const formData = uploadFormData();
    formData.set("draftId", "draft-1");
    await expect(confirmImportDraftAction(formData)).rejects.toThrow("REDIRECT:/records/import?draft=draft-1&error=xlsx-busy");
    expect(recordAppEventMock).not.toHaveBeenCalled();
  });

  it("returns a changed draft for review without recording a successful import", async () => {
    confirmImportDraftMock.mockResolvedValue({
      completedNow: false,
      createdCount: 0,
      requiresReview: true,
      source: "wechat_pay",
    });
    const formData = uploadFormData();
    formData.set("draftId", "draft-1");

    const { confirmImportDraftAction } = await import("@/app/(app)/records/import/actions");

    await expect(confirmImportDraftAction(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1&notice=IMPORT_DRAFT_CHANGED",
    );
    expect(recordAppEventMock).not.toHaveBeenCalled();
  });
});

describe("records import page", () => {
  it("opens completed imports in their original ledger and keeps the header return in the viewing scope", async () => {
    getImportDraftSummaryMock.mockResolvedValue(buildPendingDraftSummary({
      ledgerId: "ledger-imported", ledgerName: "Imported ledger", status: ImportDraftStatus.COMPLETED,
      missingMappings: [], rows: [],
    }));
    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(materializePageView(await ImportPage({ searchParams: Promise.resolve({
      draft: "draft-1", ledger: "ledger-viewed", entryLedger: "ledger-viewed",
    }) })));

    expect(markup).toContain('href="/records?ledger=ledger-imported"');
    expect(markup).toContain('href="/records?ledger=ledger-viewed"');
    // Completed history remains readable even if the original target was archived.
    expect(markup).not.toContain('entryLedger=ledger-imported');
  });

  it("fixes the selected upload target into the form before upload", async () => {
    primeSharedMocks();
    const { default: ImportRecordsPage } = await import("@/app/(app)/records/import/page");
    const tree = materializePageView(await ImportRecordsPage({ searchParams: Promise.resolve({ entryLedger: "ledger-selected" }) }));
    const markup = renderToStaticMarkup(tree);
    expect(markup).toContain("Selected ledger");
    expect(markup).toContain("name=\"context\"");
    expect(markup).toContain("ledger-selected");
    expect(markup).toContain("household-1");
  });

  beforeEach(() => {
    vi.resetModules();
    categoryFindManyMock.mockReset();
    getImportDraftSummaryMock.mockReset();
    getServerLocaleMock.mockReset();
    householdMemberFindManyMock.mockReset();
    recordAppEventMock.mockReset();
    recordAppEventMock.mockResolvedValue(undefined);
    requireAppSessionMock.mockReset();
    primeSharedMocks();
  });

  it.each(["INACTIVE_CREATOR", "ARCHIVED_LEDGER"])(
    "shows the original target and a read-only explanation for %s drafts", async (blockedReason) => {
      getImportDraftSummaryMock.mockResolvedValue(buildPendingDraftSummary({
        blockedReason, ledgerName: "Original ledger",
      }));
      const { default: ImportPage } = await import("@/app/(app)/records/import/page");
      const markup = renderToStaticMarkup(materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      })));

      expect(markup).toContain("目标账本");
      expect(markup).toContain("Original ledger");
      expect(markup).toContain(blockedReason === "INACTIVE_CREATOR" ? "家庭身份已失效" : "目标账本已归档");
      expect(markup).not.toContain('name="mapping:');
      expect(markup).not.toContain('name="ownerMemberId"');
      expect(markup).not.toContain("确认导入");
    },
  );

  it.each(["sui_shou_ji", "wechat_pay", "alipay", "cmb"])(
    "offers localized ignore choices for %s with only matching active categories",
    async (source) => {
      getImportDraftSummaryMock.mockResolvedValue(buildPendingDraftSummary({
        source,
        missingMappings: [{
          ...buildPendingDraftSummary().missingMappings[0],
          mappingKey: `${source}|EXPENSE|餐饮|三餐`,
        }],
      }));
      const { default: ImportPage } = await import("@/app/(app)/records/import/page");
      const zhMarkup = renderToStaticMarkup(materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      })));

      expect(zhMarkup).toContain('<option value="__ignore__">忽略</option>');
      expect(zhMarkup).toContain("为家庭记住规则");
      expect(zhMarkup).toContain('<option value="category-expense">餐饮</option>');
      expect(zhMarkup).not.toContain('<option value="category-income">');
      expect(categoryFindManyMock).toHaveBeenCalledWith(expect.objectContaining({ where: { isActive: true } }));

      getServerLocaleMock.mockResolvedValue("en-US");
      const enMarkup = renderToStaticMarkup(materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      })));
      expect(enMarkup).toContain('<option value="__ignore__">Ignore</option>');
      expect(enMarkup).toContain("remember the rule for your household");
    },
  );

  it("keeps ignored groups editable and renders their localized skip reason", async () => {
    const baseSummary = buildPendingDraftSummary();
    getImportDraftSummaryMock.mockResolvedValue(buildPendingDraftSummary({
      missingMappings: [],
      ignoredMappings: baseSummary.missingMappings,
      rows: [{
        ...baseSummary.rows[0],
        categoryId: null,
        duplicateCandidates: [],
        skipReason: "CATEGORY_MAPPING_IGNORED",
        status: ImportDraftRowStatus.USER_SKIPPED,
        userDecision: ImportRowDecision.SKIP,
      }],
    }));
    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const zhMarkup = renderToStaticMarkup(materializePageView(await ImportPage({
      searchParams: Promise.resolve({ draft: "draft-1" }),
    })));

    expect(zhMarkup).toContain('<option value="__ignore__" selected="">忽略</option>');
    expect(zhMarkup).toContain("分类映射已忽略");
    expect(zhMarkup).toContain('<option value="category-expense">餐饮</option>');

    getServerLocaleMock.mockResolvedValue("en-US");
    const enMarkup = renderToStaticMarkup(materializePageView(await ImportPage({
      searchParams: Promise.resolve({ draft: "draft-1" }),
    })));
    expect(enMarkup).toContain("Category mapping ignored");
  });

  it("presents a mixed missing and ignored group once with an empty initial choice", async () => {
    const group = buildPendingDraftSummary().missingMappings[0];
    getImportDraftSummaryMock.mockResolvedValue(buildPendingDraftSummary({
      ignoredMappings: [{ ...group, count: 2 }],
    }));
    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(materializePageView(await ImportPage({
      searchParams: Promise.resolve({ draft: "draft-1" }),
    })));

    expect(markup.match(/name="mapping:sui_shou_ji\|EXPENSE\|餐饮\|三餐"/g)).toHaveLength(1);
    expect(markup).toContain('<option value="" selected="">分类</option>');
    expect(markup).not.toContain('<option value="__ignore__" selected="">');
    expect(markup).toContain("3 行");
  });

  it("renders source selection on the upload form", async () => {
    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({}),
      })),
    );

    expect(markup).toContain("name=\"source\"");
    expect(markup).toContain('required="" type="radio" name="source" value="sui_shou_ji"');
    expect(markup).toContain('required="" type="radio" name="source" value="wechat_pay"');
    expect(markup).toContain('required="" type="radio" name="source" value="alipay"');
    expect(markup).toContain('required="" type="radio" name="source" value="cmb"');
    expect(markup).toContain("随手记");
    expect(markup).toContain("微信支付");
    expect(markup).toContain("支付宝");
    expect(markup).toContain("招商银行");
    expect(markup).toContain('accept=".xlsx,.csv,.pdf,.zip"');
    expect(markup).toContain('name="zipPassword"');
    expect(markup).toContain("招商银行 ZIP 解压密码");
  });

  it("renders WeChat Pay owner member selector from the first updateable row", async () => {
    householdMemberFindManyMock.mockResolvedValue([
      { id: "member-1", memberName: "老公" },
      { id: "member-2", memberName: "老婆" },
    ]);
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        missingMappings: [],
        rows: [
          {
            ...buildPendingDraftSummary().rows[0],
            actorMemberId: "member-1",
            createdByMemberId: "member-1",
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|示例商户",
            primaryCategory: "扫二维码付款",
            secondaryCategory: "示例商户",
            status: ImportDraftRowStatus.SOURCE_DUPLICATE,
            userDecision: ImportRowDecision.SKIP,
          },
          {
            ...buildPendingDraftSummary().rows[0],
            actorMemberId: "member-1",
            createdByMemberId: "member-1",
            id: "row-invalid",
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|示例商户",
            primaryCategory: "扫二维码付款",
            secondaryCategory: "示例商户",
            status: ImportDraftRowStatus.INVALID,
            userDecision: ImportRowDecision.SKIP,
          },
          {
            ...buildPendingDraftSummary().rows[0],
            actorMemberId: "member-2",
            createdByMemberId: "member-2",
            id: "row-updateable",
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|示例商户",
            primaryCategory: "扫二维码付款",
            secondaryCategory: "示例商户",
            status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
          },
        ],
        source: "wechat_pay",
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      })),
    );

    expect(markup).toContain("账单归属成员");
    expect(markup).toContain('type="hidden" name="draftId" value="draft-1"');
    expect(markup).toContain("name=\"ownerMemberId\"");
    expect(markup).toContain("value=\"member-2\" selected=\"\"");
    expect(markup).toContain("保存成员");
    expect(householdMemberFindManyMock).toHaveBeenCalledWith({
      where: { householdId: sessionUser.householdId, leftAt: null, user: { status: "ACTIVE" } },
      orderBy: { joinedAt: "asc" },
      select: { id: true, memberName: true },
    });
  });

  it("renders payment owner member selector for pending Alipay drafts", async () => {
    householdMemberFindManyMock.mockResolvedValue([
      { id: "member-1", memberName: "老公" },
      { id: "member-2", memberName: "老婆" },
    ]);
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        missingMappings: [],
        rows: [
          {
            ...buildPendingDraftSummary().rows[0],
            actorMemberId: "member-2",
            createdByMemberId: "member-2",
            mappingKey: "alipay|EXPENSE|餐饮美食|",
            primaryCategory: "餐饮美食",
            secondaryCategory: "示例商户",
          },
        ],
        source: "alipay",
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      })),
    );

    expect(markup).toContain("账单归属成员");
    expect(markup).toContain("name=\"ownerMemberId\"");
    expect(markup).toContain("value=\"member-2\" selected=\"\"");
    expect(markup).toContain("保存成员");
  });

  it("renders member mapping form and disables confirm while member mappings are unresolved", async () => {
    householdMemberFindManyMock.mockResolvedValue([
      { id: "member-1", memberName: "老公" },
      { id: "member-2", memberName: "老婆" },
    ]);
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        counts: {
          importable: 1,
          invalid: 0,
          needsMapping: 0,
          possibleDuplicate: 0,
          ready: 1,
          sourceDuplicate: 0,
          total: 1,
          userSkipped: 0,
        },
        hasUnresolvedMemberMappings: true,
        memberMappings: [
          {
            count: 1,
            externalName: "随手记老婆",
            fallbackApplied: true,
            memberId: "member-1",
          },
        ],
        missingMappings: [],
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      })),
    );

    expect(markup).toContain("成员映射");
    expect(markup).toContain("外部账号");
    expect(markup).toContain("随手记老婆");
    expect(markup).toContain("name=\"memberMapping:随手记老婆\"");
    expect(markup).toContain("value=\"member-1\" selected=\"\"");
    expect(markup).toContain("还有成员未映射，暂不能确认导入。");
    expect(markup).toContain("disabled=\"\"");
  });

  it("renders member mapping instead of payment owner selector when a payment draft has external member mappings", async () => {
    householdMemberFindManyMock.mockResolvedValue([
      { id: "member-1", memberName: "老公" },
      { id: "member-2", memberName: "老婆" },
    ]);
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        hasUnresolvedMemberMappings: true,
        memberMappings: [
          {
            count: 1,
            externalName: "支付宝老婆",
            fallbackApplied: true,
            memberId: "member-1",
          },
        ],
        missingMappings: [],
        source: "alipay",
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      })),
    );

    expect(markup).toContain("成员映射");
    expect(markup).toContain("支付宝老婆");
    expect(markup).not.toContain("name=\"ownerMemberId\"");
  });

  it("does not render the payment owner selector when no rows can use it", async () => {
    householdMemberFindManyMock.mockResolvedValue([
      { id: "member-1", memberName: "老公" },
      { id: "member-2", memberName: "老婆" },
    ]);
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        counts: {
          importable: 0,
          invalid: 1,
          needsMapping: 0,
          possibleDuplicate: 0,
          ready: 0,
          sourceDuplicate: 1,
          total: 2,
          userSkipped: 0,
        },
        missingMappings: [],
        rows: [
          {
            ...buildPendingDraftSummary().rows[0],
            actorMemberId: "member-2",
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|示例商户",
            status: ImportDraftRowStatus.SOURCE_DUPLICATE,
            userDecision: ImportRowDecision.SKIP,
          },
          {
            ...buildPendingDraftSummary().rows[0],
            actorMemberId: "member-2",
            id: "row-invalid",
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|示例商户",
            status: ImportDraftRowStatus.INVALID,
            userDecision: ImportRowDecision.SKIP,
          },
        ],
        source: "wechat_pay",
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      })),
    );

    expect(markup).not.toContain("账单归属成员");
    expect(markup).not.toContain("name=\"ownerMemberId\"");
  });

  it("does not render WeChat Pay owner member selector for Sui Shou Ji drafts", async () => {
    getImportDraftSummaryMock.mockResolvedValue(buildPendingDraftSummary());

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      })),
    );

    expect(markup).not.toContain("账单归属成员");
    expect(markup).not.toContain("name=\"ownerMemberId\"");
    expect(markup).toContain("成员: 老公");
  });

  it("does not render WeChat Pay owner member selector for completed WeChat drafts", async () => {
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        missingMappings: [],
        rows: [],
        source: "wechat_pay",
        status: ImportDraftStatus.COMPLETED,
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ completed: "1", draft: "draft-1" }),
      })),
    );

    expect(markup).toContain("导入已完成");
    expect(markup).not.toContain("账单归属成员");
    expect(markup).not.toContain("name=\"ownerMemberId\"");
    expect(householdMemberFindManyMock).not.toHaveBeenCalled();
  });

  it("renders complete duplicate details once and disables confirm while mappings are missing", async () => {
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        rows: [
          {
            ...buildPendingDraftSummary().rows[0],
            userDecision: ImportRowDecision.SKIP,
          },
        ],
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      })),
    );

    expect(markup).toContain("name=\"mapping:sui_shou_ji|EXPENSE|餐饮|三餐\"");
    expect(markup).toContain("餐饮 / 三餐");
    expect(markup).toContain("餐饮");
    expect(markup).toContain("午饭");
    expect(markup).toContain("导入复核");
    expect(markup).toContain("明细 #2");
    expect(markup.match(/data-row-id="row-duplicate"/g)).toHaveLength(1);
    expect(markup).toContain("name=\"decision:row-duplicate\"");
    expect(markup).toContain("同源重复");
    expect(markup).toContain(">2</p>");
    expect(markup).toContain("value=\"KEEP\"");
    expect(markup).toContain("checked=\"\" value=\"SKIP\"");
    expect(markup).toContain("176.00");
    expect(markup).toContain("手工");
    expect(markup).toContain("微信支付");
    expect(markup).not.toContain("wechat_pay");
    expect(markup).toContain("other_source");
    expect(markup).toContain("disabled=\"\"");
  });

  it("renders import row decisions for non-duplicate user-changeable row statuses", async () => {
    const baseRow = buildPendingDraftSummary().rows[0];

    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        counts: {
          importable: 1,
          invalid: 1,
          needsMapping: 1,
          possibleDuplicate: 1,
          ready: 1,
          sourceDuplicate: 1,
          total: 6,
          userSkipped: 1,
        },
        missingMappings: [],
        rows: [
          {
            ...baseRow,
            duplicateCandidates: [],
            id: "row-ready",
            note: "ready note",
            rawCreatedBy: "老公",
            rawMember: "老公",
            status: ImportDraftRowStatus.READY,
          },
          {
            ...baseRow,
            categoryId: null,
            duplicateCandidates: [],
            id: "row-needs-mapping",
            note: "needs mapping note",
            status: ImportDraftRowStatus.NEEDS_MAPPING,
          },
          {
            ...baseRow,
            duplicateCandidates: baseRow.duplicateCandidates,
            id: "row-possible",
            note: "possible duplicate note",
            status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
            userDecision: ImportRowDecision.SKIP,
          },
          {
            ...baseRow,
            duplicateCandidates: [],
            id: "row-skipped",
            note: "skipped note",
            status: ImportDraftRowStatus.USER_SKIPPED,
            userDecision: ImportRowDecision.SKIP,
          },
          {
            ...baseRow,
            id: "row-source-duplicate",
            status: ImportDraftRowStatus.SOURCE_DUPLICATE,
            userDecision: ImportRowDecision.SKIP,
          },
          {
            ...baseRow,
            id: "row-invalid",
            status: ImportDraftRowStatus.INVALID,
            userDecision: ImportRowDecision.SKIP,
          },
        ],
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      })),
    );

    expect(markup).toContain("导入复核");
    expect(markup).toContain("ready note");
    expect(markup).toContain("needs mapping note");
    expect(markup).toContain("possible duplicate note");
    expect(markup).toContain("明细 #2");
    expect(markup).toContain("skipped note");
    expect(markup).toContain("name=\"decision:row-ready\"");
    expect(markup).toContain("name=\"decision:row-needs-mapping\"");
    expect(markup).toContain("name=\"decision:row-possible\"");
    expect(markup).toContain("name=\"decision:row-skipped\"");
    expect(markup).not.toContain("name=\"decision:row-source-duplicate\"");
    expect(markup).not.toContain("name=\"decision:row-invalid\"");
    expect(markup).toContain("导入");
    expect(markup).toContain("不导入");
  });

  it("renders payment refund outcomes as localized read-only rows", async () => {
    const baseRow = buildPendingDraftSummary().rows[0];

    householdMemberFindManyMock.mockResolvedValue([]);

    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        counts: {
          importable: 0,
          invalid: 0,
          needsMapping: 0,
          possibleDuplicate: 0,
          ready: 0,
          sourceDuplicate: 1,
          total: 2,
          userSkipped: 1,
        },
        missingMappings: [],
        rows: [
          {
            ...baseRow,
            amountFen: 180,
            duplicateCandidates: [],
            id: "row-full-refund",
            occurredAt: new Date("2026-08-25T04:03:50.000Z"),
            primaryCategory: "文化休闲",
            rowNumber: 8,
            secondaryCategory: "示例商户",
            skipReason: "ALIPAY_FULLY_REFUNDED",
            status: ImportDraftRowStatus.USER_SKIPPED,
            userDecision: ImportRowDecision.SKIP,
          },
          {
            ...baseRow,
            amountFen: 65,
            duplicateCandidates: [],
            id: "row-manual-adjustment",
            occurredAt: new Date("2026-08-25T04:03:50.000Z"),
            primaryCategory: "文化休闲",
            rowNumber: 9,
            secondaryCategory: "示例商户",
            skipReason: "ALIPAY_REFUND_REQUIRES_MANUAL_ADJUSTMENT",
            status: ImportDraftRowStatus.SOURCE_DUPLICATE,
            userDecision: ImportRowDecision.SKIP,
          },
        ],
        source: "alipay",
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const zhMarkup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      })),
    );

    expect(zhMarkup).toContain("导入复核");
    expect(zhMarkup).toContain("已完全退款，自动跳过");
    expect(zhMarkup).toContain("退款无法自动抵扣，请手工调整原支出");
    expect(zhMarkup).toContain("8月25日 12:03");
    expect(zhMarkup).toContain("1.80");
    expect(zhMarkup).toContain("0.65");
    expect(zhMarkup).toContain("文化休闲 / 示例商户");
    expect(zhMarkup).toMatch(/同源重复<\/p><p[^>]*>1<\/p>/);
    expect(zhMarkup).toMatch(/已跳过<\/p><p[^>]*>1<\/p>/);
    expect(zhMarkup).not.toContain('name="decision:row-full-refund"');
    expect(zhMarkup).not.toContain('name="decision:row-manual-adjustment"');
    expect(zhMarkup).not.toContain('name="ownerMemberId"');

    getServerLocaleMock.mockResolvedValue("en-US");
    const enMarkup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      })),
    );

    expect(enMarkup).toContain("Import review");
    expect(enMarkup).toContain("Fully refunded; skipped automatically");
    expect(enMarkup).toContain(
      "The refund could not be applied automatically; adjust the original record manually",
    );

    getServerLocaleMock.mockResolvedValue("zh-CN");
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        counts: {
          importable: 0,
          invalid: 0,
          needsMapping: 0,
          possibleDuplicate: 0,
          ready: 0,
          sourceDuplicate: 1,
          total: 2,
          userSkipped: 1,
        },
        missingMappings: [],
        rows: [
          {
            ...baseRow,
            duplicateCandidates: [],
            id: "row-wechat-full-refund",
            skipReason: "WECHAT_FULLY_REFUNDED",
            status: ImportDraftRowStatus.USER_SKIPPED,
            userDecision: ImportRowDecision.SKIP,
          },
          {
            ...baseRow,
            duplicateCandidates: [],
            id: "row-wechat-manual-adjustment",
            skipReason: "WECHAT_REFUND_REQUIRES_MANUAL_ADJUSTMENT",
            status: ImportDraftRowStatus.SOURCE_DUPLICATE,
            userDecision: ImportRowDecision.SKIP,
          },
        ],
        source: "wechat_pay",
      }),
    );
    const changedMarkup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({
          draft: "draft-1",
          notice: "IMPORT_DRAFT_CHANGED",
        }),
      })),
    );

    expect(changedMarkup).toContain("草稿状态已变化，请复核");
    expect(changedMarkup).toContain("已完全退款，自动跳过");
    expect(changedMarkup).toContain("退款无法自动抵扣，请手工调整原支出");
    expect(changedMarkup).not.toContain('name="decision:row-wechat-full-refund"');
    expect(changedMarkup).not.toContain('name="decision:row-wechat-manual-adjustment"');

    getServerLocaleMock.mockResolvedValue("en-US");
    const changedEnglishMarkup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({
          draft: "draft-1",
          notice: "IMPORT_DRAFT_CHANGED",
        }),
      })),
    );

    expect(changedEnglishMarkup).toContain(
      "The draft changed. Review it before confirming again.",
    );
  });

  it("opens a later review page so records beyond the old 100-row limit remain reachable", async () => {
    const baseRow = buildPendingDraftSummary().rows[0];
    const rows = Array.from({ length: 101 }, (_, index) => ({
      ...baseRow,
      duplicateCandidates: [],
      id: `row-review-${index + 1}`,
      note: `review note ${index + 1}`,
      rowNumber: index + 1,
      status: ImportDraftRowStatus.READY,
      userDecision: ImportRowDecision.KEEP,
    }));

    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        counts: {
          importable: 101,
          invalid: 0,
          needsMapping: 0,
          possibleDuplicate: 0,
          ready: 101,
          sourceDuplicate: 0,
          total: 101,
          userSkipped: 0,
        },
        missingMappings: [],
        rows,
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1", page: "3" }),
      })),
    );

    expect(markup).toContain("review note 101");
    expect(markup).not.toContain("review note 100");
    expect(markup).toContain("上一页");
    expect(markup).not.toContain("还有 1 条明细未显示，将按当前状态处理。");
  });

  it("renders the oversized file upload error", async () => {
    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ error: "file-too-large" }),
      })),
    );

    expect(markup).toContain("文件过大");
  });

  it("shows only the completed state and records return link for completed drafts", async () => {
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        counts: {
          importable: 1,
          invalid: 0,
          needsMapping: 0,
          possibleDuplicate: 0,
          ready: 1,
          sourceDuplicate: 0,
          total: 1,
          userSkipped: 0,
        },
        missingMappings: [],
        rows: [],
        status: ImportDraftStatus.COMPLETED,
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ completed: "1", draft: "draft-1" }),
      })),
    );

    expect(markup).toContain("导入已完成");
    expect(markup).toContain("完成摘要");
    expect(markup).toContain("可导入");
    expect(markup).toContain("已跳过");
    expect(markup).toContain("同源重复");
    expect(markup).toContain("无效行");
    expect(markup).toContain("href=\"/records?ledger=ledger-original\"");
    expect(markup).not.toContain("name=\"mapping:");
    expect(markup).not.toContain("确认导入");
  });

  it("does not trust the completed query for a pending draft", async () => {
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        counts: {
          importable: 1,
          invalid: 0,
          needsMapping: 0,
          possibleDuplicate: 0,
          ready: 1,
          sourceDuplicate: 0,
          total: 1,
          userSkipped: 0,
        },
        missingMappings: [],
        rows: [],
        status: ImportDraftStatus.PENDING,
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ completed: "1", draft: "draft-1" }),
      })),
    );

    expect(markup).toContain("确认导入");
    expect(markup).not.toContain("导入已完成");
  });

  it("does not render decisions for source duplicate rows", async () => {
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        counts: {
          importable: 0,
          invalid: 0,
          needsMapping: 0,
          possibleDuplicate: 0,
          ready: 0,
          sourceDuplicate: 1,
          total: 1,
          userSkipped: 0,
        },
        missingMappings: [],
        rows: [
          {
            ...buildPendingDraftSummary().rows[0],
            id: "row-source-duplicate",
            status: ImportDraftRowStatus.SOURCE_DUPLICATE,
            userDecision: ImportRowDecision.SKIP,
          },
        ],
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      })),
    );

    expect(markup).toContain("同源重复");
    expect(markup).not.toContain("name=\"decision:row-source-duplicate\"");
    expect(markup).not.toContain("疑似重复确认");
  });

  it("opens duplicate rows beyond the old 50-row limit and offers the remaining candidates", async () => {
    const duplicateRows = Array.from({ length: 51 }, (_, index) => ({
      ...buildPendingDraftSummary().rows[0],
      duplicateCandidates: Array.from({ length: 4 }, (_candidate, candidateIndex) => ({
        amountFen: 17600,
        categoryId: "category-expense",
        id: `candidate-${index}-${candidateIndex}`,
        occurredAt: `2026-05-06T0${candidateIndex}:30:00.000Z`,
        source: candidateIndex === 3 ? "hidden_source" : null,
        type: TransactionType.EXPENSE,
      })),
      id: `row-duplicate-${index + 1}`,
      rowNumber: index + 1,
      status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
    }));

    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        counts: {
          importable: 51,
          invalid: 0,
          needsMapping: 0,
          possibleDuplicate: 51,
          ready: 0,
          sourceDuplicate: 0,
          total: 51,
          userSkipped: 0,
        },
        missingMappings: [],
        rows: duplicateRows,
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1", page: "2" }),
      })),
    );

    expect(markup).not.toContain("明细 #50");
    expect(markup).toContain("明细 #51");
    expect(markup).toContain("hidden_source");
    expect(markup).toContain("展开其余 1 个候选");
    expect(markup).toContain("查看原记录");
    expect(markup).toContain("上一页");
    expect(markup).not.toContain("还有 1 行未显示");
  });

  it("filters by processing status before choosing the requested review page", async () => {
    const baseRow = buildPendingDraftSummary().rows[0];
    const rows = Array.from({ length: 120 }, (_, index) => ({
      ...baseRow,
      duplicateCandidates: [],
      id: `row-mixed-${index + 1}`,
      note: `mixed note ${index + 1}`,
      rowNumber: index + 1,
      status: index % 2 === 0 ? ImportDraftRowStatus.READY : ImportDraftRowStatus.USER_SKIPPED,
      userDecision: index % 2 === 0 ? ImportRowDecision.KEEP : ImportRowDecision.SKIP,
    }));
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({ missingMappings: [], rows }),
    );
    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1", status: "USER_SKIPPED", page: "2" }),
      })),
    );

    expect(markup).toContain("mixed note 102");
    expect(markup).toContain("mixed note 120");
    expect(markup).not.toContain("mixed note 101");
    expect(markup).not.toContain("mixed note 100");
    expect(markup.match(/data-testid="import-review-row"/g)).toHaveLength(10);
    expect(markup).toContain("处理状态");
  });

  it("keeps invalid and source duplicate rows reachable as read-only review outcomes", async () => {
    const baseRow = buildPendingDraftSummary().rows[0];
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        missingMappings: [],
        rows: [
          { ...baseRow, id: "readonly-invalid", status: ImportDraftRowStatus.INVALID,
            duplicateCandidates: [], note: "Invalid amount row", skipReason: "Invalid amount" },
          { ...baseRow, id: "readonly-source", status: ImportDraftRowStatus.SOURCE_DUPLICATE,
            duplicateCandidates: [], note: "Previously imported row", skipReason: "Source duplicate" },
        ],
      }),
    );
    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({ searchParams: Promise.resolve({ draft: "draft-1" }) })),
    );

    expect(markup).toContain("Invalid amount row");
    expect(markup).toContain("金额无效");
    expect(markup).toContain("Previously imported row");
    expect(markup).not.toContain('name="decision:readonly-invalid"');
    expect(markup).not.toContain('name="decision:readonly-source"');
    expect(markup.match(/data-testid="import-review-row"/g)).toHaveLength(2);
  });

  it("keeps an empty status filter usable without silently showing unrelated rows", async () => {
    const baseRow = buildPendingDraftSummary().rows[0];
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        missingMappings: [],
        rows: [{ ...baseRow, duplicateCandidates: [], status: ImportDraftRowStatus.READY }],
      }),
    );
    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1", status: "INVALID", page: "2" }),
      })),
    );

    expect(markup).toContain("处理状态");
    expect(markup).not.toContain('data-testid="import-review-row"');
    expect(markup).not.toContain('name="decision:row-duplicate"');
  });

  it("wires the upload form to the upload import draft action", async () => {
    const uploadImportDraftAction = vi.fn();

    vi.doMock("@/app/(app)/records/import/actions", () => ({
      confirmImportDraftAction: vi.fn(),
      confirmImportReviewDraft: vi.fn(),
      getImportCandidateDetail: vi.fn(),
      saveImportDecisions: vi.fn(),
      saveImportReviewDecisions: vi.fn(),
      saveImportMemberMappings: vi.fn(),
      saveImportMappings: vi.fn(),
      saveImportMappingChanges: vi.fn(),
      savePaymentOwnerMember: vi.fn(),
      saveWechatPayOwnerMember: vi.fn(),
      uploadImportDraft: uploadImportDraftAction,
    }));

    try {
      const { default: ImportPage } = await import("@/app/(app)/records/import/page");
      const element = materializePageView(await ImportPage({
        searchParams: Promise.resolve({}),
      }));
      const forms = findElementsByType(element, "form");

      expect(forms.some((form) => form.props.action === uploadImportDraftAction)).toBe(true);
    } finally {
      vi.doUnmock("@/app/(app)/records/import/actions");
    }
  });

  it("wires the payment owner form to the save owner member action", async () => {
    const savePaymentOwnerMemberAction = vi.fn();

    householdMemberFindManyMock.mockResolvedValue([
      { id: "member-1", memberName: "老公" },
      { id: "member-2", memberName: "老婆" },
    ]);
    getImportDraftSummaryMock.mockResolvedValue(
      buildPendingDraftSummary({
        missingMappings: [],
        rows: [
          {
            ...buildPendingDraftSummary().rows[0],
            actorMemberId: "member-2",
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|示例商户",
            primaryCategory: "扫二维码付款",
            secondaryCategory: "示例商户",
          },
        ],
        source: "wechat_pay",
      }),
    );
    vi.doMock("@/app/(app)/records/import/actions", () => ({
      confirmImportDraftAction: vi.fn(),
      confirmImportReviewDraft: vi.fn(),
      getImportCandidateDetail: vi.fn(),
      saveImportDecisions: vi.fn(),
      saveImportReviewDecisions: vi.fn(),
      saveImportMemberMappings: vi.fn(),
      saveImportMappings: vi.fn(),
      saveImportMappingChanges: vi.fn(),
      savePaymentOwnerMember: savePaymentOwnerMemberAction,
      saveWechatPayOwnerMember: vi.fn(),
      uploadImportDraft: vi.fn(),
    }));

    try {
      const { default: ImportPage } = await import("@/app/(app)/records/import/page");
      const element = materializePageView(await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      }));
      const forms = findElementsByType(element, "form");

      expect(forms.some((form) => form.props.action === savePaymentOwnerMemberAction)).toBe(true);
    } finally {
      vi.doUnmock("@/app/(app)/records/import/actions");
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
