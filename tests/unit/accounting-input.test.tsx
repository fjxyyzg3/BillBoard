import { NaturalLanguageProvider } from "@/components/natural-language-provider";
import { LedgerProvider } from "@/components/ledger-provider";
import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { Children, isValidElement, type ComponentProps, type ReactElement } from "react";
import { AccountingInput } from "@/components/accounting-input";
import { getMemberDisplayName, getMessages } from "@/lib/i18n";

import AddPage from "@/app/(app)/add/page";
import { AddView } from "@/app/(app)/add/view";

vi.mock("server-only", () => ({}));
vi.mock("@/app/account/actions", () => ({ finishReauthenticationAction: vi.fn() }));
vi.mock("@/lib/encryption/request", () => ({ getHouseholdEncryptionStatus: async () => ({ mode: "UNENCRYPTED", revision: 0, generation: null, keyVersion: 0, isOwner: false, operation: null }) }));
vi.mock("@prisma/client", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@prisma/client")>()),
  AppEventType: { PAGE_VIEW: "PAGE_VIEW" },
}));
vi.mock("@/lib/auth/session", () => ({
  requireAppSession: async () => ({ householdId: "household", memberId: "member" }),
}));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({
  usePathname: () => "/add",
  useSearchParams: () => new URLSearchParams(),
  useRouter: () => ({ push: vi.fn(), replace: vi.fn(), refresh: vi.fn() }),
}));
vi.mock("@/lib/auth/household-context", () => ({
  resolveHouseholdContext: async (_client: unknown, session: { householdId: string; memberId: string }) => ({ ...session, userId: "user", role: "OWNER", ledgerId: "ledger", ledgerName: "Default" }),
}));
vi.mock("@/lib/i18n-server", () => ({ getServerLocale: async () => "zh-CN" }));
vi.mock("@/lib/ops/record-event", () => ({ recordAppEvent: async () => undefined }));
vi.mock("@/lib/db", () => ({
  db: {
    category: {
      findMany: async () => [{ id: "dining", name: "Dining", type: "EXPENSE" }],
    },
    householdMember: {
      findMany: async () => [{ id: "member", memberName: "Member" }],
    },
    ledger: {
      findMany: async () => [{ id: "ledger", name: "Default", isDefault: true, archivedAt: null, acceptsLegacyDrafts: true }],
    },
    transaction: { groupBy: async () => [] },
  },
}));
vi.mock("@/app/(app)/add/actions", () => ({ submitTransaction: vi.fn() }));
vi.mock("@/app/(app)/add/natural-language-actions", () => ({
  queryNaturalLanguageEntry: vi.fn(),
  submitNaturalLanguageEntry: vi.fn(),
}));

const ledgerCatalog = {
  identity: { householdId: "household", memberId: "member" },
  role: "OWNER" as const,
  ledgers: [{ id: "ledger", name: "Default", isDefault: true, archivedAt: null }],
  legacyDefaultLedgerId: "ledger",
};

describe("accounting input", () => {
  it("passes losslessly serializable labels across the actual server-to-client entry boundary", async () => {
    const page = await AddPage({});
    expect(page).not.toBeNull();
    const view = AddView(page!.props);
    const input = Children.toArray(view.props.children).find((child) => isValidElement(child) && child.type === AccountingInput) as ReactElement<ComponentProps<typeof AccountingInput>>;
    expect(input).toBeDefined();
    const labels = input.props.labels;
    expect(JSON.parse(JSON.stringify(labels))).toEqual(labels);
    expect(structuredClone(labels)).toEqual(labels);
  });

  it.each(["zh-CN", "en-US"] as const)("keeps historical member labels serializable in %s", (locale) => {
    const common = getMessages(locale).common;
    expect(JSON.parse(JSON.stringify(common))).toEqual(common);
    expect(structuredClone(common)).toEqual(common);
    expect(getMemberDisplayName("Alex", true, locale)).toBe(locale === "zh-CN" ? "Alex（已退出）" : "Alex (left)");
    expect(getMemberDisplayName("Alex", false, locale)).toBe("Alex");
  });

  it("offers natural language entry while keeping manual entry selected by default", async () => {
    const markup = renderToStaticMarkup(<LedgerProvider catalog={ledgerCatalog}>
      <NaturalLanguageProvider currentMemberId="member">{await AddPage({})}</NaturalLanguageProvider>
    </LedgerProvider>);

    expect(markup).toContain("自然语言");
    expect(markup).toContain("手工填写");
    expect(markup).toContain('aria-pressed="true"');
    expect(markup).toContain("保存记录");
    expect(markup).toContain("金额");
  });
});
