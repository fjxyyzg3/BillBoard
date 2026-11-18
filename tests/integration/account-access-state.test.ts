import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";

const { authMock, resolveContextMock, localeMock } = vi.hoisted(() => ({ authMock: vi.fn(), resolveContextMock: vi.fn(), localeMock: vi.fn() }));
vi.mock("@/auth", () => ({ auth: authMock, signOut: vi.fn() }));
vi.mock("@/lib/auth/household-context", () => ({ resolveHouseholdContext: resolveContextMock }));
vi.mock("@/lib/auth/session", () => ({ requireAccountSession: vi.fn() }));
vi.mock("@/lib/i18n-server", () => ({ getServerLocale: localeMock }));
vi.mock("@/lib/ops/config", () => ({ isOpsAdminInstance: () => false }));
vi.mock("@/components/app-shell", () => ({ AppShell: () => createElement("div", null, "Household navigation") }));
vi.mock("@/lib/db", () => ({ db: {} }));

describe("signed-in accounts without household access", () => {
  beforeEach(() => {
    vi.clearAllMocks();
    authMock.mockResolvedValue({ user: { id: "account-1", appSessionId: "session-1", email: "account@example.com", name: "Account" } });
    localeMock.mockResolvedValue("zh-CN");
  });

  it("shows a restricted state and sign-out without rendering household content or loading a former household", async () => {
    const { default: Layout } = await import("@/app/(app)/layout");
    const markup = renderToStaticMarkup(await Layout({ children: createElement("p", null, "Private household records") }));
    expect(markup).toContain("当前没有可访问的家庭");
    expect(markup).toContain("退出登录");
    expect(markup).not.toContain("Private household records");
    expect(markup).not.toContain("Household navigation");
    expect(resolveContextMock).not.toHaveBeenCalled();
  });

  it("provides the same restricted state in English", async () => {
    localeMock.mockResolvedValue("en-US");
    const { default: Layout } = await import("@/app/(app)/layout");
    const markup = renderToStaticMarkup(await Layout({ children: null }));
    expect(markup).toContain("No household access");
    expect(markup).toContain("Sign out");
  });

  it("keeps a revoked session on the existing login redirect", async () => {
    authMock.mockResolvedValue({ authError: "SESSION_INVALID", user: { id: "account-1", appSessionId: "session-1" } });
    const { default: Layout } = await import("@/app/(app)/layout");
    await expect(Layout({ children: null })).rejects.toThrow("NEXT_REDIRECT");
    expect(localeMock).not.toHaveBeenCalled();
  });
});
