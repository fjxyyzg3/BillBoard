import { createElement } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { catalog, status } = vi.hoisted(() => ({ catalog: vi.fn(), status: vi.fn() }));
const { loadPage } = vi.hoisted(() => ({ loadPage: vi.fn(() => { throw new Error("A keyless page attempted a financial read"); }) }));
const identity = { id: "account-1", householdId: "household-1", memberId: "member-1", appSessionId: "session-1" };
vi.mock("@/auth", () => ({ auth: async () => ({ user: identity }) }));
vi.mock("@/lib/auth/session", () => ({ requireAppSession: async () => identity }));
vi.mock("@/lib/encryption/request", () => ({ getHouseholdEncryptionStatus: status }));
vi.mock("@/lib/ops/config", () => ({ isOpsAdminInstance: () => false }));
vi.mock("@/lib/ledgers/server", () => ({ loadLedgerCatalog: catalog }));
vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(path); } }));
vi.mock("@/lib/db", () => ({ db: { user: { findUnique: async () => ({}) } } }));
vi.mock("@/lib/auth/sign-out", () => ({ signOutCurrentAccount: vi.fn() }));
vi.mock("@/lib/i18n-server", () => ({ getServerLocale: async () => "zh-CN" }));
vi.mock("@/components/app-shell", () => ({ AppShell: () => null }));
vi.mock("@/components/encryption-gate", () => ({ EncryptionGate: () => null }));
vi.mock("@/app/(app)/home/loader", () => ({ loadHomePage: loadPage }));
vi.mock("@/app/(app)/add/loader", () => ({ loadAddPage: loadPage }));
vi.mock("@/app/(app)/records/loader", () => ({ loadRecordsPage: loadPage }));
vi.mock("@/app/(app)/records/import/loader", () => ({ loadImportPage: loadPage }));
vi.mock("@/app/(app)/records/import/mappings/loader", () => ({ loadMappingsPage: loadPage }));
vi.mock("@/app/(app)/ledgers/loader", () => ({ loadLedgersPage: loadPage }));

describe("encrypted application entry", () => {
  beforeEach(() => { vi.clearAllMocks(); });

  it("does not read a ledger catalog during the initial keyless render", async () => {
    status.mockResolvedValue({ mode: "ENCRYPTED", revision: 7, generation: "generation-1", keyVersion: 1, isOwner: true, operation: null });
    const { default: Layout } = await import("@/app/(app)/layout");
    const result = await Layout({ children: createElement("span", null, "unrendered-page") });
    expect(catalog).not.toHaveBeenCalled();
    expect(result.props.children).toBeUndefined();
    expect(JSON.stringify(result.props)).not.toContain("unrendered-page");
  });

  it("independently guards parallel page children before any financial loader runs", async () => {
    status.mockResolvedValue({ mode: "ENCRYPTED", revision: 7, generation: "generation-1", keyVersion: 1, isOwner: true, operation: null });
    const pages = [await import("@/app/(app)/home/page"), await import("@/app/(app)/add/page"), await import("@/app/(app)/records/page"), await import("@/app/(app)/records/import/page"), await import("@/app/(app)/records/import/mappings/page"), await import("@/app/(app)/ledgers/page")];
    for (const pageModule of pages) expect(await pageModule.default({})).toBeNull();
    expect(loadPage).not.toHaveBeenCalled();
  });
});
