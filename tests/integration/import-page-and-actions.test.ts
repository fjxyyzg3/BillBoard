import { ImportDraftRowStatus, ImportDraftStatus, ImportRowDecision, TransactionType } from "@prisma/client";
import { Children, createElement, isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const {
  categoryFindManyMock,
  confirmImportDraftMock,
  createSuiShouJiImportDraftMock,
  createWechatPayImportDraftMock,
  getImportDraftSummaryMock,
  getServerLocaleMock,
  householdFindUniqueOrThrowMock,
  householdMemberFindManyMock,
  listRecordsMock,
  redirectMock,
  requireAppSessionMock,
  saveImportDraftMappingsMock,
  saveWechatPayDraftOwnerMemberMock,
  setImportDraftRowDecisionMock,
  transactionFindFirstMock,
} = vi.hoisted(() => ({
  categoryFindManyMock: vi.fn(),
  confirmImportDraftMock: vi.fn(),
  createSuiShouJiImportDraftMock: vi.fn(),
  createWechatPayImportDraftMock: vi.fn(),
  getImportDraftSummaryMock: vi.fn(),
  getServerLocaleMock: vi.fn(),
  householdFindUniqueOrThrowMock: vi.fn(),
  householdMemberFindManyMock: vi.fn(),
  listRecordsMock: vi.fn(),
  redirectMock: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  requireAppSessionMock: vi.fn(),
  saveImportDraftMappingsMock: vi.fn(),
  saveWechatPayDraftOwnerMemberMock: vi.fn(),
  setImportDraftRowDecisionMock: vi.fn(),
  transactionFindFirstMock: vi.fn(),
}));

vi.mock("next/link", () => ({
  default: ({ children, href, scroll: _scroll, ...props }: React.ComponentProps<"a"> & {
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

vi.mock("@/lib/imports/drafts", () => ({
  confirmImportDraft: confirmImportDraftMock,
  createSuiShouJiImportDraft: createSuiShouJiImportDraftMock,
  createWechatPayImportDraft: createWechatPayImportDraftMock,
  getImportDraftSummary: getImportDraftSummaryMock,
  saveImportDraftMappings: saveImportDraftMappingsMock,
  saveWechatPayDraftOwnerMember: saveWechatPayDraftOwnerMemberMock,
  setImportDraftRowDecision: setImportDraftRowDecisionMock,
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
  TransactionEditorDrawer: () => createElement("div", { "data-testid": "record-drawer" }),
}));

const sessionUser = {
  householdId: "household-1",
  id: "user-1",
  memberId: "member-1",
};

const activeCategories = [
  { id: "category-expense", name: "Dining", type: "EXPENSE" },
  { id: "category-income", name: "Salary", type: "INCOME" },
];

function primeSharedMocks() {
  requireAppSessionMock.mockResolvedValue(sessionUser);
  getServerLocaleMock.mockResolvedValue("zh-CN");
  categoryFindManyMock.mockResolvedValue(activeCategories);
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
    id: "draft-1",
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
        actorMemberId: "member-1",
        amountFen: 17600,
        categoryId: "category-expense",
        createdByMemberId: "member-1",
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

function findElementsByType(node: ReactNode, type: string) {
  const matches: ReactElement[] = [];

  function visit(value: ReactNode) {
    Children.forEach(value, (child) => {
      if (!isValidElement(child)) {
        return;
      }

      const element = child as ReactElement<{ children?: ReactNode }>;

      if (element.type === type) {
        matches.push(element);
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
    categoryFindManyMock.mockReset();
    householdFindUniqueOrThrowMock.mockReset();
    householdMemberFindManyMock.mockReset();
    listRecordsMock.mockReset();
    requireAppSessionMock.mockReset();
    transactionFindFirstMock.mockReset();
    primeSharedMocks();
    primeRecordsMocks();
  });

  it("renders an import entry that links to the records import page", async () => {
    const { default: RecordsPage } = await import("@/app/(app)/records/page");
    const markup = renderToStaticMarkup(
      await RecordsPage({
        searchParams: Promise.resolve({ range: "last-30-days" }),
      }),
    );

    expect(markup).toContain("导入");
    expect(markup).toContain("href=\"/records/import\"");
  });
});

describe("records import actions", () => {
  beforeEach(() => {
    vi.resetModules();
    redirectMock.mockClear();
    confirmImportDraftMock.mockReset();
    createSuiShouJiImportDraftMock.mockReset();
    createWechatPayImportDraftMock.mockReset();
    requireAppSessionMock.mockReset();
    saveImportDraftMappingsMock.mockReset();
    saveWechatPayDraftOwnerMemberMock.mockReset();
    setImportDraftRowDecisionMock.mockReset();
    primeSharedMocks();
  });

  it("uploads a Sui Shou Ji .xlsx file when the selected source is Sui Shou Ji", async () => {
    createSuiShouJiImportDraftMock.mockResolvedValue({ id: "draft-1" });
    const formData = new FormData();
    formData.set("source", "sui_shou_ji");
    formData.set("file", new File([new Uint8Array([1, 2, 3])], "export.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );
    expect(createSuiShouJiImportDraftMock).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      fileName: "export.xlsx",
      sessionUser,
    });
    expect(createWechatPayImportDraftMock).not.toHaveBeenCalled();
  });

  it("keeps the legacy Sui Shou Ji upload action compatible before source is submitted", async () => {
    createSuiShouJiImportDraftMock.mockResolvedValue({ id: "draft-1" });
    const formData = new FormData();
    formData.set("file", new File([new Uint8Array([1, 2, 3])], "export.xlsx"));

    const { uploadSuiShouJiImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadSuiShouJiImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );
    expect(createSuiShouJiImportDraftMock).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      fileName: "export.xlsx",
      sessionUser,
    });
    expect(createWechatPayImportDraftMock).not.toHaveBeenCalled();
  });

  it("uploads a WeChat Pay .xlsx file when the selected source is WeChat Pay", async () => {
    createWechatPayImportDraftMock.mockResolvedValue({ id: "wechat-draft" });
    const formData = new FormData();
    formData.set("source", "wechat_pay");
    formData.set("file", new File([new Uint8Array([1, 2, 3])], "wechat.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=wechat-draft",
    );
    expect(createWechatPayImportDraftMock).toHaveBeenCalledWith({
      buffer: expect.any(Buffer),
      fileName: "wechat.xlsx",
      sessionUser,
    });
    expect(createSuiShouJiImportDraftMock).not.toHaveBeenCalled();
  });

  it("redirects when import source is missing", async () => {
    const formData = new FormData();
    formData.set("file", new File([new Uint8Array([1])], "export.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=missing-source",
    );
    expect(createSuiShouJiImportDraftMock).not.toHaveBeenCalled();
    expect(createWechatPayImportDraftMock).not.toHaveBeenCalled();
  });

  it("redirects unsupported files without creating a draft", async () => {
    const formData = new FormData();
    formData.set("source", "sui_shou_ji");
    formData.set("file", new File([new Uint8Array([1])], "export.csv"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unsupported-file",
    );
    expect(createSuiShouJiImportDraftMock).not.toHaveBeenCalled();
  });

  it("redirects oversized files without reading or creating a draft", async () => {
    const formData = new FormData();
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
    const formData = new FormData();
    formData.set("source", "sui_shou_ji");
    formData.set("file", new File([new Uint8Array([1])], "export.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unrecognized-file",
    );
  });

  it("maps WeChat Pay unrecognized workbook errors to the WeChat error redirect", async () => {
    createWechatPayImportDraftMock.mockRejectedValue(new Error("无法识别微信支付账单格式"));
    const formData = new FormData();
    formData.set("source", "wechat_pay");
    formData.set("file", new File([new Uint8Array([1])], "wechat.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=unrecognized-wechat-pay-file",
    );
  });

  it("maps parser size errors to the file-too-large redirect", async () => {
    createSuiShouJiImportDraftMock.mockRejectedValue(new Error("Import file is too large"));
    const formData = new FormData();
    formData.set("source", "sui_shou_ji");
    formData.set("file", new File([new Uint8Array([1])], "export.xlsx"));

    const { uploadImportDraft } = await import("@/app/(app)/records/import/actions");

    await expect(uploadImportDraft(formData)).rejects.toThrow(
      "REDIRECT:/records/import?error=file-too-large",
    );
  });

  it("saves WeChat Pay owner member selection and redirects back to the draft", async () => {
    const formData = new FormData();
    formData.set("draftId", "draft-1");
    formData.set("ownerMemberId", "member-2");

    const { saveWechatPayOwnerMember } = await import("@/app/(app)/records/import/actions");

    await expect(saveWechatPayOwnerMember(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );
    expect(saveWechatPayDraftOwnerMemberMock).toHaveBeenCalledWith(
      "draft-1",
      "member-2",
      sessionUser,
    );
  });

  it("saves category mappings from mapping entries and redirects back to the draft", async () => {
    const formData = new FormData();
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

  it("saves duplicate row decisions from decision entries and redirects back to the draft", async () => {
    const formData = new FormData();
    formData.set("draftId", "draft-1");
    formData.set("decision:row-1", "KEEP");
    formData.set("decision:row-2", "SKIP");

    const { saveImportDecisions } = await import("@/app/(app)/records/import/actions");

    await expect(saveImportDecisions(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1",
    );
    expect(setImportDraftRowDecisionMock).toHaveBeenNthCalledWith(
      1,
      "draft-1",
      "row-1",
      ImportRowDecision.KEEP,
      sessionUser,
    );
    expect(setImportDraftRowDecisionMock).toHaveBeenNthCalledWith(
      2,
      "draft-1",
      "row-2",
      ImportRowDecision.SKIP,
      sessionUser,
    );
  });

  it("confirms the draft and redirects to the completed query", async () => {
    const formData = new FormData();
    formData.set("draftId", "draft-1");

    const { confirmImportDraftAction } = await import("@/app/(app)/records/import/actions");

    await expect(confirmImportDraftAction(formData)).rejects.toThrow(
      "REDIRECT:/records/import?draft=draft-1&completed=1",
    );
    expect(confirmImportDraftMock).toHaveBeenCalledWith("draft-1", sessionUser);
  });
});

describe("records import page", () => {
  beforeEach(() => {
    vi.resetModules();
    categoryFindManyMock.mockReset();
    getImportDraftSummaryMock.mockReset();
    getServerLocaleMock.mockReset();
    householdMemberFindManyMock.mockReset();
    requireAppSessionMock.mockReset();
    primeSharedMocks();
  });

  it("renders source selection on the upload form", async () => {
    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      await ImportPage({
        searchParams: Promise.resolve({}),
      }),
    );

    expect(markup).toContain("name=\"source\"");
    expect(markup).toContain('required="" type="radio" name="source" value="sui_shou_ji"');
    expect(markup).toContain('required="" type="radio" name="source" value="wechat_pay"');
    expect(markup).toContain("随手记");
    expect(markup).toContain("微信支付");
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
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
            primaryCategory: "扫二维码付款",
            secondaryCategory: "阿泉食杂店",
            status: ImportDraftRowStatus.SOURCE_DUPLICATE,
            userDecision: ImportRowDecision.SKIP,
          },
          {
            ...buildPendingDraftSummary().rows[0],
            actorMemberId: "member-1",
            createdByMemberId: "member-1",
            id: "row-invalid",
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
            primaryCategory: "扫二维码付款",
            secondaryCategory: "阿泉食杂店",
            status: ImportDraftRowStatus.INVALID,
            userDecision: ImportRowDecision.SKIP,
          },
          {
            ...buildPendingDraftSummary().rows[0],
            actorMemberId: "member-2",
            createdByMemberId: "member-2",
            id: "row-updateable",
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
            primaryCategory: "扫二维码付款",
            secondaryCategory: "阿泉食杂店",
            status: ImportDraftRowStatus.POSSIBLE_DUPLICATE,
          },
        ],
        source: "wechat_pay",
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      }),
    );

    expect(markup).toContain("账单归属成员");
    expect(markup).toContain('type="hidden" name="draftId" value="draft-1"');
    expect(markup).toContain("name=\"ownerMemberId\"");
    expect(markup).toContain("value=\"member-2\" selected=\"\"");
    expect(markup).toContain("保存成员");
    expect(householdMemberFindManyMock).toHaveBeenCalledWith({
      where: { householdId: sessionUser.householdId },
      orderBy: { joinedAt: "asc" },
      select: { id: true, memberName: true },
    });
  });

  it("falls back to the session member when WeChat owner rows are not updateable", async () => {
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
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
            status: ImportDraftRowStatus.SOURCE_DUPLICATE,
            userDecision: ImportRowDecision.SKIP,
          },
          {
            ...buildPendingDraftSummary().rows[0],
            actorMemberId: "member-2",
            id: "row-invalid",
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
            status: ImportDraftRowStatus.INVALID,
            userDecision: ImportRowDecision.SKIP,
          },
        ],
        source: "wechat_pay",
      }),
    );

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      }),
    );

    expect(markup).toContain("账单归属成员");
    expect(markup).toContain("value=\"member-1\" selected=\"\"");
  });

  it("does not render WeChat Pay owner member selector for Sui Shou Ji drafts", async () => {
    getImportDraftSummaryMock.mockResolvedValue(buildPendingDraftSummary());

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      }),
    );

    expect(markup).not.toContain("账单归属成员");
    expect(markup).not.toContain("name=\"ownerMemberId\"");
    expect(householdMemberFindManyMock).not.toHaveBeenCalled();
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
      await ImportPage({
        searchParams: Promise.resolve({ completed: "1", draft: "draft-1" }),
      }),
    );

    expect(markup).toContain("导入已完成");
    expect(markup).not.toContain("账单归属成员");
    expect(markup).not.toContain("name=\"ownerMemberId\"");
    expect(householdMemberFindManyMock).not.toHaveBeenCalled();
  });

  it("renders mapping selects, duplicate decisions, and disables confirm while mappings are missing", async () => {
    getImportDraftSummaryMock.mockResolvedValue(buildPendingDraftSummary());

    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      }),
    );

    expect(markup).toContain("name=\"mapping:sui_shou_ji|EXPENSE|餐饮|三餐\"");
    expect(markup).toContain("餐饮 / 三餐");
    expect(markup).toContain("餐饮");
    expect(markup).toContain("name=\"decision:row-duplicate\"");
    expect(markup).toContain("同源重复");
    expect(markup).toContain(">2</p>");
    expect(markup).toContain("value=\"KEEP\"");
    expect(markup).toContain("value=\"SKIP\"");
    expect(markup).toContain("176.00");
    expect(markup).toContain("手工");
    expect(markup).toContain("微信支付");
    expect(markup).not.toContain("wechat_pay");
    expect(markup).toContain("other_source");
    expect(markup).toContain("disabled=\"\"");
  });

  it("renders the oversized file upload error", async () => {
    const { default: ImportPage } = await import("@/app/(app)/records/import/page");
    const markup = renderToStaticMarkup(
      await ImportPage({
        searchParams: Promise.resolve({ error: "file-too-large" }),
      }),
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
      await ImportPage({
        searchParams: Promise.resolve({ completed: "1", draft: "draft-1" }),
      }),
    );

    expect(markup).toContain("导入已完成");
    expect(markup).toContain("href=\"/records\"");
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
      await ImportPage({
        searchParams: Promise.resolve({ completed: "1", draft: "draft-1" }),
      }),
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
      await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      }),
    );

    expect(markup).toContain("同源重复");
    expect(markup).not.toContain("name=\"decision:row-source-duplicate\"");
    expect(markup).not.toContain("疑似重复确认");
  });

  it("limits duplicate review rows and candidates in the server-rendered preview", async () => {
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
      await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      }),
    );

    expect(markup).toContain("导入行 #50");
    expect(markup).not.toContain("导入行 #51");
    expect(markup).not.toContain("hidden_source");
    expect(markup).toContain("还有 1 行未显示");
    expect(markup).toContain("还有 1 个候选未显示");
  });

  it("wires the upload form to the upload import draft action", async () => {
    const uploadImportDraftAction = vi.fn();

    vi.doMock("@/app/(app)/records/import/actions", () => ({
      confirmImportDraftAction: vi.fn(),
      saveImportDecisions: vi.fn(),
      saveImportMappings: vi.fn(),
      saveWechatPayOwnerMember: vi.fn(),
      uploadImportDraft: uploadImportDraftAction,
    }));

    try {
      const { default: ImportPage } = await import("@/app/(app)/records/import/page");
      const element = await ImportPage({
        searchParams: Promise.resolve({}),
      });
      const forms = findElementsByType(element, "form");

      expect(forms.some((form) => form.props.action === uploadImportDraftAction)).toBe(true);
    } finally {
      vi.doUnmock("@/app/(app)/records/import/actions");
    }
  });

  it("wires the WeChat owner form to the save owner member action", async () => {
    const saveWechatPayOwnerMemberAction = vi.fn();

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
            mappingKey: "wechat_pay|EXPENSE|扫二维码付款|阿泉食杂店",
            primaryCategory: "扫二维码付款",
            secondaryCategory: "阿泉食杂店",
          },
        ],
        source: "wechat_pay",
      }),
    );
    vi.doMock("@/app/(app)/records/import/actions", () => ({
      confirmImportDraftAction: vi.fn(),
      saveImportDecisions: vi.fn(),
      saveImportMappings: vi.fn(),
      saveWechatPayOwnerMember: saveWechatPayOwnerMemberAction,
      uploadImportDraft: vi.fn(),
    }));

    try {
      const { default: ImportPage } = await import("@/app/(app)/records/import/page");
      const element = await ImportPage({
        searchParams: Promise.resolve({ draft: "draft-1" }),
      });
      const forms = findElementsByType(element, "form");

      expect(forms.some((form) => form.props.action === saveWechatPayOwnerMemberAction)).toBe(true);
    } finally {
      vi.doUnmock("@/app/(app)/records/import/actions");
    }
  });
});
