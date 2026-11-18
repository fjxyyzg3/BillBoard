import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

vi.mock("@/app/account/actions", () => ({ finishReauthenticationAction: vi.fn() }));

const {
  cookiesDeleteMock,
  cookiesGetMock,
  cookiesMock,
  cookiesSetMock,
  createOpsAdminSessionTokenMock,
  appSessionUpdateManyMock,
  accountTokenUpdateManyMock,
  listInvitationsMock,
  listApplicationsMock,
  createInvitationMock,
  revokeInvitationMock,
  dbTransactionMock,
  getOpsAdminConfigMock,
  getServerLocaleMock,
  loginThrottleDeleteMock,
  notFoundMock,
  opsAuditLogCreateMock,
  queryOpsDashboardMock,
  redirectMock,
  userFindUniqueMock,
  userUpdateMock,
  verifyOpsAdminPasswordMock,
  verifyOpsAdminSessionTokenMock,
} = vi.hoisted(() => ({
  cookiesDeleteMock: vi.fn(),
  cookiesGetMock: vi.fn(),
  cookiesMock: vi.fn(),
  cookiesSetMock: vi.fn(),
  createOpsAdminSessionTokenMock: vi.fn(),
  appSessionUpdateManyMock: vi.fn(),
  accountTokenUpdateManyMock: vi.fn(),
  listInvitationsMock: vi.fn(),
  listApplicationsMock: vi.fn(),
  createInvitationMock: vi.fn(),
  revokeInvitationMock: vi.fn(),
  dbTransactionMock: vi.fn(async (callback: (tx: unknown) => Promise<unknown>) =>
    callback({
      appSession: {
        updateMany: appSessionUpdateManyMock,
      },
      accountToken: { updateMany: accountTokenUpdateManyMock },
      opsAuditLog: {
        create: opsAuditLogCreateMock,
      },
      user: {
        update: userUpdateMock,
      },
    }),
  ),
  getOpsAdminConfigMock: vi.fn(),
  getServerLocaleMock: vi.fn(),
  loginThrottleDeleteMock: vi.fn(),
  notFoundMock: vi.fn(() => {
    throw new Error("NOT_FOUND");
  }),
  opsAuditLogCreateMock: vi.fn(),
  queryOpsDashboardMock: vi.fn(),
  redirectMock: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  userFindUniqueMock: vi.fn(),
  userUpdateMock: vi.fn(),
  verifyOpsAdminPasswordMock: vi.fn(),
  verifyOpsAdminSessionTokenMock: vi.fn(),
}));

vi.mock("next/headers", () => ({
  cookies: cookiesMock,
}));

vi.mock("next/navigation", () => ({
  notFound: notFoundMock,
  redirect: redirectMock,
  useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }),
}));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/identity/invitations", () => ({ listPlatformInvitations: listInvitationsMock, createPlatformInvitation: createInvitationMock, revokePlatformInvitation: revokeInvitationMock }));
vi.mock("@/lib/identity/access-applications", () => ({ listAccessApplicationsForOps: listApplicationsMock, decideAccessApplication: vi.fn(), retryAccessApplicationMail: vi.fn() }));

vi.mock("@/lib/i18n-server", () => ({
  getServerLocale: getServerLocaleMock,
}));

vi.mock("@/lib/ops/config", () => ({
  getOpsAdminConfig: getOpsAdminConfigMock,
}));

vi.mock("@/lib/ops/auth", () => ({
  createOpsAdminSessionToken: createOpsAdminSessionTokenMock,
  opsAdminSessionCookieName: "billboard-ops-session",
  verifyOpsAdminPassword: verifyOpsAdminPasswordMock,
  verifyOpsAdminSessionToken: verifyOpsAdminSessionTokenMock,
}));

vi.mock("@/lib/ops/dashboard", () => ({
  queryOpsDashboard: queryOpsDashboardMock,
}));

vi.mock("@/lib/db", () => ({
  db: {
    appSession: {
      updateMany: appSessionUpdateManyMock,
    },
    $transaction: dbTransactionMock,
    loginThrottle: {
      delete: loginThrottleDeleteMock,
    },
    opsAuditLog: {
      create: opsAuditLogCreateMock,
    },
    user: {
      findUnique: userFindUniqueMock,
      update: userUpdateMock,
    },
  },
}));

const originalEnv = { ...process.env };
const cookieStore = {
  delete: cookiesDeleteMock,
  get: cookiesGetMock,
  set: cookiesSetMock,
};

function restoreEnv() {
  for (const key of Object.keys(process.env)) {
    if (!(key in originalEnv)) {
      delete process.env[key];
    }
  }

  Object.assign(process.env, originalEnv);
}

function buildDashboard() {
  return {
    blockedLogins: [
      {
        attemptCount: 5,
        emailLabel: "p***n@example.com",
        id: "login-throttle-1",
        lockedUntil: new Date("2026-05-09T03:00:00.000Z"),
        updatedAt: new Date("2026-05-09T02:55:00.000Z"),
      },
    ],
    database: { ok: true },
    auditLogs: [
      {
        action: "RESET_USER_PASSWORD",
        createdAt: new Date("2026-05-09T02:30:00.000Z"),
        id: "ops-audit-1",
        operator: "ops-admin",
        targetSessionId: null,
        targetUserEmail: "husband@example.com",
        targetUserMemberName: "Ops Husband",
      },
    ],
    households: [
      {
        householdId: "household-1",
        householdName: "Ops Household",
        members: [
          {
            displayName: "Ops Husband",
            email: "husband@example.com",
            memberId: "member-1",
            memberName: "Ops Husband",
            role: "OWNER",
            sessions: [
              {
                deviceLabel: "Chrome on Windows",
                expiresAt: new Date("2026-06-08T02:00:00.000Z"),
                id: "app-session-1",
                lastSeenAt: new Date("2026-05-09T02:20:00.000Z"),
                loginAt: new Date("2026-05-09T02:00:00.000Z"),
              },
            ],
            status: "ACTIVE",
            userId: "user-1",
          },
        ],
      },
    ],
    recentEvents: [
      {
        createdAt: new Date("2026-05-09T02:00:00.000Z"),
        eventType: "PAGE_VIEW",
        memberName: "老公",
        path: "/home",
        summary: "opened home",
      },
      {
        createdAt: new Date("2026-05-09T01:00:00.000Z"),
        eventType: "TRANSACTION_CREATED",
        memberName: "老婆",
        path: null,
        summary: "created transaction",
      },
    ],
    status: {
      bindAddress: "127.0.0.1:32768",
      environment: "test",
      retentionDays: 90,
      version: "1.3.0",
    },
    today: {
      importConfirmed: 1,
      loginSuccess: 2,
      pageViews: 5,
      transactionCreated: 3,
      transactionDeleted: 1,
      transactionUpdated: 4,
    },
    trend: [
      { dayKey: "2026-05-03", keyActions: 0, loginSuccess: 0, pageViews: 1 },
      { dayKey: "2026-05-04", keyActions: 1, loginSuccess: 0, pageViews: 2 },
      { dayKey: "2026-05-05", keyActions: 2, loginSuccess: 1, pageViews: 3 },
      { dayKey: "2026-05-06", keyActions: 3, loginSuccess: 1, pageViews: 4 },
      { dayKey: "2026-05-07", keyActions: 4, loginSuccess: 1, pageViews: 5 },
      { dayKey: "2026-05-08", keyActions: 5, loginSuccess: 2, pageViews: 6 },
      { dayKey: "2026-05-09", keyActions: 6, loginSuccess: 2, pageViews: 7 },
    ],
  };
}

function primeDefaults() {
  process.env.AUTH_SECRET = "test-auth-secret";
  vi.stubEnv("NODE_ENV", "test");
  cookiesMock.mockResolvedValue(cookieStore);
  cookiesGetMock.mockReturnValue(undefined);
  createOpsAdminSessionTokenMock.mockReturnValue("signed-session-token");
  getOpsAdminConfigMock.mockReturnValue({
    enabled: true,
    hasPasswordHash: true,
    instance: true,
  });
  getServerLocaleMock.mockResolvedValue("zh-CN");
  loginThrottleDeleteMock.mockResolvedValue({});
  queryOpsDashboardMock.mockResolvedValue(buildDashboard());
  listInvitationsMock.mockResolvedValue([]);
  listApplicationsMock.mockResolvedValue([]);
  createInvitationMock.mockResolvedValue({ id: "invitation" });
  accountTokenUpdateManyMock.mockResolvedValue({ count: 1 });
  verifyOpsAdminPasswordMock.mockResolvedValue(false);
  verifyOpsAdminSessionTokenMock.mockReturnValue(false);
}

beforeEach(() => {
  vi.resetModules();
  cookiesDeleteMock.mockReset();
  cookiesGetMock.mockReset();
  cookiesMock.mockReset();
  cookiesSetMock.mockReset();
  createOpsAdminSessionTokenMock.mockReset();
  appSessionUpdateManyMock.mockReset();
  accountTokenUpdateManyMock.mockReset();
  listInvitationsMock.mockReset();
  listApplicationsMock.mockReset();
  createInvitationMock.mockReset();
  revokeInvitationMock.mockReset();
  dbTransactionMock.mockClear();
  getOpsAdminConfigMock.mockReset();
  getServerLocaleMock.mockReset();
  loginThrottleDeleteMock.mockReset();
  notFoundMock.mockClear();
  opsAuditLogCreateMock.mockReset();
  queryOpsDashboardMock.mockReset();
  redirectMock.mockClear();
  userFindUniqueMock.mockReset();
  userUpdateMock.mockReset();
  verifyOpsAdminPasswordMock.mockReset();
  verifyOpsAdminSessionTokenMock.mockReset();
  primeDefaults();
});

afterEach(() => {
  vi.unstubAllEnvs();
  restoreEnv();
});

describe("ops admin page", () => {
  it("returns not found on a non-ops instance without rendering the login form or querying the dashboard", async () => {
    getOpsAdminConfigMock.mockReturnValue({
      enabled: true,
      hasPasswordHash: true,
      instance: false,
    });

    const { default: OpsPage } = await import("@/app/ops/page");

    await expect(OpsPage()).rejects.toThrow("NOT_FOUND");

    expect(notFoundMock).toHaveBeenCalledTimes(1);
    expect(cookiesMock).not.toHaveBeenCalled();
    expect(queryOpsDashboardMock).not.toHaveBeenCalled();
    expect(listInvitationsMock).not.toHaveBeenCalled();
  });

  it("renders the password form before login without querying the dashboard", async () => {
    const { default: OpsPage } = await import("@/app/ops/page");

    const markup = renderToStaticMarkup(await OpsPage());

    expect(markup).toContain("后台口令");
    expect(markup).toContain("进入后台");
    expect(queryOpsDashboardMock).not.toHaveBeenCalled();
  });

  it("renders the dashboard when the session token is valid", async () => {
    cookiesGetMock.mockReturnValue({
      name: "billboard-ops-session",
      value: "valid-session-token",
    });
    verifyOpsAdminSessionTokenMock.mockReturnValue(true);

    const { default: OpsPage } = await import("@/app/ops/page");

    const markup = renderToStaticMarkup(await OpsPage());

    expect(markup).toContain("后台运维");
    expect(markup).toContain("127.0.0.1:32768");
    expect(markup).toContain("今日访问");
    expect(markup).toContain("登录拦截");
    expect(markup).toContain("p***n@example.com");
    expect(markup).toContain("放行");
    expect(markup).toContain("用户与设备");
    expect(markup).toContain("Ops Household");
    expect(markup).toContain("Chrome on Windows");
    expect(markup).toContain("重置密码");
    expect(markup).toContain("踢下线");
    expect(markup).toContain("最近安全操作");
    expect(markup).toContain("平台注册邀请");
    expect(markup).toContain("使用申请");
    expect(markup).toContain("还没有已确认的使用申请");
    expect(markup).toContain("独立家庭");
    expect(listInvitationsMock).toHaveBeenCalledTimes(1);
    expect(queryOpsDashboardMock).toHaveBeenCalledWith({
      version: expect.any(String),
    });
    expect(verifyOpsAdminSessionTokenMock).toHaveBeenCalledWith(
      "valid-session-token",
      "test-auth-secret",
    );
  });

  it("renders the disabled configuration error without querying the dashboard", async () => {
    getOpsAdminConfigMock.mockReturnValue({
      enabled: false,
      hasPasswordHash: true,
      instance: true,
    });

    const { default: OpsPage } = await import("@/app/ops/page");

    const markup = renderToStaticMarkup(await OpsPage());

    expect(markup).toContain("后台未启用");
    expect(queryOpsDashboardMock).not.toHaveBeenCalled();
  });

  it.each([
    ["3", 3], ["1001", 1], ["-1", 1], ["1.5", 1], [["2", "3"], 1],
  ] as const)("normalizes the application page %s before querying", async (requestedPage, expectedPage) => {
    verifyOpsAdminSessionTokenMock.mockReturnValue(true);
    const { default: OpsPage } = await import("@/app/ops/page");
    await OpsPage({ searchParams: Promise.resolve({ applicationsPage: typeof requestedPage === "string" ? requestedPage : [...requestedPage] }) });
    expect(listApplicationsMock).toHaveBeenCalledWith(expectedPage);
  });

  it("renders the missing password configuration error without querying the dashboard", async () => {
    getOpsAdminConfigMock.mockReturnValue({
      enabled: true,
      hasPasswordHash: false,
      instance: true,
    });

    const { default: OpsPage } = await import("@/app/ops/page");

    const markup = renderToStaticMarkup(await OpsPage());

    expect(markup).toContain("后台口令未配置");
    expect(queryOpsDashboardMock).not.toHaveBeenCalled();
  });
});

describe("ops admin actions", () => {
  it("fails closed on a non-ops instance without verifying the password or setting a cookie", async () => {
    getOpsAdminConfigMock.mockReturnValue({
      enabled: true,
      hasPasswordHash: true,
      instance: false,
    });
    verifyOpsAdminPasswordMock.mockResolvedValue(true);
    const formData = new FormData();
    formData.set("locale", "zh-CN");
    formData.set("password", "correct-password");

    const { loginOpsAdmin } = await import("@/app/ops/actions");

    await expect(loginOpsAdmin({ status: "idle" }, formData)).resolves.toEqual({
      message: "后台口令不正确",
      status: "error",
    });
    expect(verifyOpsAdminPasswordMock).not.toHaveBeenCalled();
    expect(createOpsAdminSessionTokenMock).not.toHaveBeenCalled();
    expect(cookiesSetMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("sets the ops session cookie and redirects after a successful login", async () => {
    verifyOpsAdminPasswordMock.mockResolvedValue(true);
    const formData = new FormData();
    formData.set("locale", "zh-CN");
    formData.set("password", "correct-password");

    const { loginOpsAdmin } = await import("@/app/ops/actions");

    await expect(loginOpsAdmin({ status: "idle" }, formData)).rejects.toThrow(
      "REDIRECT:/ops",
    );
    expect(verifyOpsAdminPasswordMock).toHaveBeenCalledWith("correct-password");
    expect(createOpsAdminSessionTokenMock).toHaveBeenCalledWith("test-auth-secret");
    expect(cookiesSetMock).toHaveBeenCalledWith(
      "billboard-ops-session",
      "signed-session-token",
      {
        httpOnly: true,
        maxAge: 8 * 60 * 60,
        path: "/ops",
        sameSite: "lax",
        secure: false,
      },
    );
  });

  it("returns the localized invalid password error without setting a cookie", async () => {
    verifyOpsAdminPasswordMock.mockResolvedValue(false);
    const formData = new FormData();
    formData.set("locale", "zh-CN");
    formData.set("password", "wrong-password");

    const { loginOpsAdmin } = await import("@/app/ops/actions");

    await expect(loginOpsAdmin({ status: "idle" }, formData)).resolves.toEqual({
      message: "后台口令不正确",
      status: "error",
    });
    expect(cookiesSetMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("fails closed in production when AUTH_SECRET is missing", async () => {
    vi.stubEnv("NODE_ENV", "production");
    delete process.env.AUTH_SECRET;
    verifyOpsAdminPasswordMock.mockResolvedValue(true);
    const formData = new FormData();
    formData.set("locale", "zh-CN");
    formData.set("password", "correct-password");

    const { loginOpsAdmin } = await import("@/app/ops/actions");

    await expect(loginOpsAdmin({ status: "idle" }, formData)).resolves.toEqual({
      message: "后台口令不正确",
      status: "error",
    });
    expect(createOpsAdminSessionTokenMock).not.toHaveBeenCalled();
    expect(cookiesSetMock).not.toHaveBeenCalled();
    expect(redirectMock).not.toHaveBeenCalled();
  });

  it("deletes the ops session cookie and redirects on logout", async () => {
    const { logoutOpsAdmin } = await import("@/app/ops/actions");

    await expect(logoutOpsAdmin()).rejects.toThrow("REDIRECT:/ops");

    expect(cookiesDeleteMock).toHaveBeenCalledWith({
      name: "billboard-ops-session",
      path: "/ops",
    });
  });

  it("releases a locked login only when the ops session token is valid", async () => {
    cookiesGetMock.mockReturnValue({
      name: "billboard-ops-session",
      value: "valid-session-token",
    });
    verifyOpsAdminSessionTokenMock.mockReturnValue(true);
    const formData = new FormData();
    formData.set("loginThrottleId", "login-throttle-1");

    const { releaseLoginThrottle } = await import("@/app/ops/actions");

    await expect(releaseLoginThrottle(formData)).rejects.toThrow("REDIRECT:/ops");

    expect(verifyOpsAdminSessionTokenMock).toHaveBeenCalledWith(
      "valid-session-token",
      "test-auth-secret",
    );
    expect(loginThrottleDeleteMock).toHaveBeenCalledWith({
      where: { id: "login-throttle-1" },
    });
  });

  it("does not release a locked login when the ops session token is invalid", async () => {
    cookiesGetMock.mockReturnValue({
      name: "billboard-ops-session",
      value: "invalid-session-token",
    });
    verifyOpsAdminSessionTokenMock.mockReturnValue(false);
    const formData = new FormData();
    formData.set("loginThrottleId", "login-throttle-1");

    const { releaseLoginThrottle } = await import("@/app/ops/actions");

    await expect(releaseLoginThrottle(formData)).rejects.toThrow("REDIRECT:/ops");

    expect(loginThrottleDeleteMock).not.toHaveBeenCalled();
  });

  it("does not run ops actions when the ops admin is disabled even with a valid session cookie", async () => {
    getOpsAdminConfigMock.mockReturnValue({
      enabled: false,
      hasPasswordHash: true,
      instance: true,
    });
    cookiesGetMock.mockReturnValue({
      name: "billboard-ops-session",
      value: "valid-session-token",
    });
    verifyOpsAdminSessionTokenMock.mockReturnValue(true);
    const formData = new FormData();
    formData.set("loginThrottleId", "login-throttle-1");

    const { releaseLoginThrottle } = await import("@/app/ops/actions");

    await expect(releaseLoginThrottle(formData)).rejects.toThrow("REDIRECT:/ops");

    expect(loginThrottleDeleteMock).not.toHaveBeenCalled();
  });

  it("resets a household user password and revokes all of that user's app sessions", async () => {
    cookiesGetMock.mockReturnValue({
      name: "billboard-ops-session",
      value: "valid-session-token",
    });
    verifyOpsAdminSessionTokenMock.mockReturnValue(true);
    userFindUniqueMock.mockResolvedValue({
      householdMember: [{
        memberName: "Ops Husband",
      }],
      displayName: "Ops Husband",
      id: "user-1",
    });
    userUpdateMock.mockResolvedValue({});
    appSessionUpdateManyMock.mockResolvedValue({ count: 2 });
    opsAuditLogCreateMock.mockResolvedValue({});
    const formData = new FormData();
    formData.set("userId", "user-1");
    formData.set("newPassword", "new-password");
    formData.set("confirmPassword", "new-password");
    formData.set("confirmReset", "on");

    const actions = (await import("@/app/ops/actions")) as typeof import("@/app/ops/actions") & {
      resetUserPassword?: (formData: FormData) => Promise<never>;
    };

    expect(actions.resetUserPassword).toBeTypeOf("function");
    await expect(actions.resetUserPassword?.(formData)).rejects.toThrow("REDIRECT:/ops");

    expect(userUpdateMock).toHaveBeenCalledWith({
      data: { passwordHash: expect.stringMatching(/^\$argon2/) },
      where: { id: "user-1" },
    });
    expect(appSessionUpdateManyMock).toHaveBeenCalledWith({
      data: { revokedAt: expect.any(Date) },
      where: { revokedAt: null, userId: "user-1" },
    });
    expect(accountTokenUpdateManyMock).toHaveBeenCalledWith({
      where: { userId: { in: ["user-1"] }, consumedAt: null, revokedAt: null },
      data: { revokedAt: expect.any(Date) },
    });
    expect(opsAuditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "RESET_USER_PASSWORD",
        operator: "ops-admin",
        targetUserId: "user-1",
      }),
    });
    expect(opsAuditLogCreateMock).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: "REVOKE_USER_SESSIONS_AFTER_PASSWORD_RESET",
        operator: "ops-admin",
        targetUserId: "user-1",
      }),
    });
  });

  it("never invokes platform invitation services without the protected ops session", async () => {
    const { createPlatformInvitationAction, revokePlatformInvitationAction, getPlatformInvitationsForOps } = await import("@/app/ops/actions");
    const form = new FormData();
    form.set("email", "friend@example.test");
    form.set("invitationId", "invitation");
    await expect(createPlatformInvitationAction(form)).rejects.toThrow("REDIRECT:/ops");
    await expect(revokePlatformInvitationAction(form)).rejects.toThrow("REDIRECT:/ops");
    await expect(getPlatformInvitationsForOps()).rejects.toThrow("REDIRECT:/ops");
    expect(createInvitationMock).not.toHaveBeenCalled();
    expect(revokeInvitationMock).not.toHaveBeenCalled();
    expect(listInvitationsMock).not.toHaveBeenCalled();
  });

  it("creates platform invitations only through ops and returns no raw capability", async () => {
    cookiesGetMock.mockReturnValue({ value: "valid-session-token" });
    verifyOpsAdminSessionTokenMock.mockReturnValue(true);
    createInvitationMock.mockResolvedValue({ id: "invitation", token: "must-not-reach-browser" });
    const { createPlatformInvitationAction } = await import("@/app/ops/actions");
    const form = new FormData();
    form.set("email", "friend@example.test");
    form.set("locale", "en-US");
    expect(await createPlatformInvitationAction(form)).toEqual({ ok: true, data: { message: "sent" } });
    expect(createInvitationMock).toHaveBeenCalledWith({ email: "friend@example.test", locale: "en-US" });
  });
});
