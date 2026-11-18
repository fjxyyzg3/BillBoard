import { createElement, type ReactElement, type ReactNode } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { authMock, getServerLocaleMock, ledgerFindManyMock, cookiesMock, redirectMock, resolveHouseholdContextMock } = vi.hoisted(() => ({
  authMock: vi.fn(),
  getServerLocaleMock: vi.fn(),
  resolveHouseholdContextMock: vi.fn(),
  ledgerFindManyMock: vi.fn(),
  cookiesMock: vi.fn(),
  redirectMock: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
}));

vi.mock("@/auth", () => ({
  auth: authMock,
}));
vi.mock("@/lib/encryption/request", async (original) => ({
  ...await original<typeof import("@/lib/encryption/request")>(),
  getHouseholdEncryptionStatus: async () => ({ mode: "UNENCRYPTED", revision: 0, generation: null, keyVersion: 0, isOwner: true, operation: null }),
}));

vi.mock("@/lib/auth/household-context", () => ({
  resolveHouseholdContext: resolveHouseholdContextMock,
}));
vi.mock("@/lib/db", () => ({ db: { ledger: { findMany: ledgerFindManyMock }, user: { findUnique: async () => ({ aiProcessingEnabled: false, voiceProcessingEnabled: false }) } } }));
vi.mock("next/headers", () => ({ cookies: cookiesMock }));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("@/components/app-shell", async () => {
  const React = await import("react");

  return {
    AppShell: ({ children }: { children: ReactNode }) =>
      React.createElement("section", { "data-testid": "app-shell" }, children),
  };
});

vi.mock("@/components/language-toggle", async () => {
  const React = await import("react");

  return {
    LanguageToggle: ({ locale }: { locale: string }) =>
      React.createElement("div", { "data-locale": locale, "data-testid": "language-toggle" }),
  };
});

vi.mock("@/components/login-form", async () => {
  const React = await import("react");

  return {
    LoginForm: () => React.createElement("form", { "data-testid": "login-form" }),
  };
});

vi.mock("@/lib/i18n-server", () => ({
  getServerLocale: getServerLocaleMock,
}));

const originalEnv = { ...process.env };

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }

  Object.assign(process.env, originalEnv);
}

function primeMocks() {
  redirectMock.mockImplementation((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  });
  getServerLocaleMock.mockResolvedValue("zh-CN");
  resolveHouseholdContextMock.mockResolvedValue({ householdId: "household-1", memberId: "member-1", userId: "user-1", role: "OWNER", ledgerId: "ledger-1", ledgerName: "Default" });
  ledgerFindManyMock.mockResolvedValue([{ id: "ledger-1", name: "Default", isDefault: true, archivedAt: null, acceptsLegacyDrafts: true }]);
  cookiesMock.mockResolvedValue({ get: () => undefined });
}

beforeEach(() => {
  restoreEnv();
  vi.resetModules();
  vi.resetAllMocks();
  primeMocks();
});

afterEach(() => {
  restoreEnv();
  vi.resetModules();
  vi.resetAllMocks();
});

describe("ops instance routing isolation", () => {
  it("redirects the root page to ops without reading the household session", async () => {
    process.env.OPS_ADMIN_INSTANCE = "true";
    const { default: RootPage } = await import("@/app/page");

    await expect(RootPage()).rejects.toThrow("REDIRECT:/ops");

    expect(authMock).not.toHaveBeenCalled();
    expect(ledgerFindManyMock).not.toHaveBeenCalled();
    expect(cookiesMock).not.toHaveBeenCalled();
    expect(redirectMock).toHaveBeenCalledWith("/ops");
  });

  it("redirects the app layout to ops without reading the household session", async () => {
    process.env.OPS_ADMIN_INSTANCE = "true";
    const { default: AppLayout } = await import("@/app/(app)/layout");

    await expect(
      AppLayout({ children: createElement("p", null, "Household child") }),
    ).rejects.toThrow("REDIRECT:/ops");

    expect(authMock).not.toHaveBeenCalled();
    expect(ledgerFindManyMock).not.toHaveBeenCalled();
    expect(cookiesMock).not.toHaveBeenCalled();
    expect(redirectMock).toHaveBeenCalledWith("/ops");
  });

  it("redirects the household login page to ops without reading locale", async () => {
    process.env.OPS_ADMIN_INSTANCE = "true";
    const { default: LoginPage } = await import("@/app/(auth)/login/page");

    await expect(LoginPage()).rejects.toThrow("REDIRECT:/ops");

    expect(getServerLocaleMock).not.toHaveBeenCalled();
    expect(redirectMock).toHaveBeenCalledWith("/ops");
  });

  it("redirects the public guide to ops before reading locale or household data", async () => {
    process.env.OPS_ADMIN_INSTANCE = "true";
    const { default: HelpPage } = await import("@/app/help/page");

    await expect(HelpPage()).rejects.toThrow("REDIRECT:/ops");

    expect(getServerLocaleMock).not.toHaveBeenCalled();
    expect(authMock).not.toHaveBeenCalled();
    expect(ledgerFindManyMock).not.toHaveBeenCalled();
    expect(cookiesMock).not.toHaveBeenCalled();
  });

  it("redirects the root page to login on a normal instance without session", async () => {
    delete process.env.OPS_ADMIN_INSTANCE;
    authMock.mockResolvedValue(null);
    const { default: RootPage } = await import("@/app/page");

    await expect(RootPage()).rejects.toThrow("REDIRECT:/login");

    expect(authMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/login");
  });

  it("redirects the root page to home on a normal instance with session", async () => {
    delete process.env.OPS_ADMIN_INSTANCE;
    authMock.mockResolvedValue({
      user: {
        householdId: "household-1",
        id: "user-1",
        memberId: "member-1",
        appSessionId: "app-session-1",
      },
    });
    const { default: RootPage } = await import("@/app/page");

    await expect(RootPage()).rejects.toThrow("REDIRECT:/home");

    expect(authMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/home");
  });

  it("redirects the app layout to login on a normal instance without authorization", async () => {
    delete process.env.OPS_ADMIN_INSTANCE;
    authMock.mockResolvedValue(null);
    const { default: AppLayout } = await import("@/app/(app)/layout");

    await expect(AppLayout({ children: createElement("p", null, "Private") })).rejects.toThrow(
      "REDIRECT:/login",
    );

    expect(authMock).toHaveBeenCalledTimes(1);
    expect(redirectMock).toHaveBeenCalledWith("/login");
  });

  it("renders app children on a normal instance with a complete session", async () => {
    delete process.env.OPS_ADMIN_INSTANCE;
    authMock.mockResolvedValue({
      user: {
        householdId: "household-1",
        id: "user-1",
        memberId: "member-1",
        appSessionId: "app-session-1",
      },
    });
    const { default: AppLayout } = await import("@/app/(app)/layout");

    const result = await AppLayout({ children: createElement("p", null, "Household child") });
    const markup = renderToStaticMarkup(result as ReactElement);

    expect(authMock).toHaveBeenCalledTimes(1);
    expect(markup).toContain('data-testid="app-shell"');
    expect(markup).toContain("Household child");
    expect(ledgerFindManyMock).toHaveBeenCalledWith({
      where: { householdId: "household-1" },
      orderBy: [{ createdAt: "asc" }, { id: "asc" }],
      select: { id: true, name: true, isDefault: true, archivedAt: true, acceptsLegacyDrafts: true },
    });
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("renders the household login page on a normal instance", async () => {
    delete process.env.OPS_ADMIN_INSTANCE;
    const { default: LoginPage } = await import("@/app/(auth)/login/page");

    const markup = renderToStaticMarkup((await LoginPage()) as ReactElement);

    expect(getServerLocaleMock).toHaveBeenCalledTimes(1);
    expect(markup).toContain('data-testid="language-toggle"');
    expect(markup).toContain('data-testid="login-form"');
    expect(redirectMock).not.toHaveBeenCalled();
  });
});
