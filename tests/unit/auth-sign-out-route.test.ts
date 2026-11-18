import { NextRequest } from "next/server";
import { inspect } from "node:util";
import { encode } from "next-auth/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";
import type { JWT } from "next-auth/jwt";
import type { NextAuthConfig } from "next-auth";

const harness = vi.hoisted(() => {
  process.env.AUTH_SECRET = "synthetic-auth-sign-out-route-secret";
  process.env.AUTH_URL = "http://127.0.0.1:2500";
  return { loadSession: vi.fn(), recoverSession: vi.fn(), revokeSession: vi.fn(), clearCookie: vi.fn(), log: vi.fn(), currentCookie: "" };
});
vi.mock("next-auth", async () => {
  const { Auth } = await import("@auth/core");
  const { CredentialsSignin } = await import("@auth/core/errors");
  return {
    CredentialsSignin,
    default: (config: NextAuthConfig) => {
      // Keep real Auth.js JWT/CSRF/event handling; replace only the Next request-context adapter.
      const handler = (request: Request) => Auth(request, { ...config, basePath: "/api/auth", logger: { error: harness.log } });
      return { handlers: { GET: handler, POST: handler },
        auth: async () => (await handler(new Request("http://127.0.0.1:2500/api/auth/session", { headers: { cookie: harness.currentCookie } }))).json(),
        signOut: harness.clearCookie,
      };
    },
  };
});
vi.mock("@/lib/auth/app-sessions", () => ({
  ensureAppSessionForToken: harness.recoverSession, loadValidAccountSessionUser: harness.loadSession,
}));
vi.mock("@/lib/identity/account", () => ({ revokeCurrentAccountSession: harness.revokeSession }));
vi.mock("@/lib/auth/login-admission", () => ({ verifyLoginCredentials: vi.fn() }));
vi.mock("@/lib/ops/record-event", () => ({ recordAppEvent: vi.fn() }));

import { GET, POST } from "@/app/api/auth/[...nextauth]/route";
import { signOutCurrentAccount } from "@/lib/auth/sign-out";

const origin = "http://127.0.0.1:2500";
const account = {
  id: "original-account", appSessionId: "original-session", email: "sign-out@example.test", name: "Original",
  memberId: "original-member", householdId: "original-household", role: "OWNER" as const,
};
const activeSessions = new Set<string>();
let auditCount = 0;

async function sessionCookie(extra: Partial<JWT> = {}) {
  const token = await encode({
    token: { sub: account.id, email: account.email, name: account.name, appSessionId: account.appSessionId,
      memberId: account.memberId, householdId: account.householdId, ...extra },
    secret: process.env.AUTH_SECRET!, salt: "authjs.session-token", maxAge: 3_600,
  });
  return `authjs.session-token=${token}`;
}

async function withCsrf(cookie: string) {
  const response = await GET(new NextRequest(`${origin}/api/auth/csrf`, { headers: { cookie } }));
  const { csrfToken } = await response.json() as { csrfToken: string };
  const cookies = response.headers.getSetCookie().map((value) => value.split(";", 1)[0]);
  return { cookie: [cookie, ...cookies].join("; "), csrfToken };
}

async function signOut(cookie: string, csrfToken: string) {
  return POST(new NextRequest(`${origin}/api/auth/signout`, {
    method: "POST", headers: { cookie, "content-type": "application/x-www-form-urlencoded", "X-Auth-Return-Redirect": "1" },
    body: new URLSearchParams({ csrfToken, callbackUrl: `${origin}/login` }),
  }));
}

async function readSession(cookie: string) {
  return (await GET(new NextRequest(`${origin}/api/auth/session`, { headers: { cookie } }))).json();
}

beforeEach(() => {
  vi.clearAllMocks();
  activeSessions.clear();
  activeSessions.add(account.appSessionId);
  activeSessions.add("other-device-session");
  auditCount = 0;
  harness.currentCookie = "";
  harness.loadSession.mockImplementation(async (id: string) => activeSessions.has(id) ? { ...account, appSessionId: id } : null);
  harness.recoverSession.mockResolvedValue(account.appSessionId);
  harness.revokeSession.mockImplementation(async (session: typeof account) => {
    if (activeSessions.delete(session.appSessionId)) auditCount++;
  });
});

describe("built-in Auth.js sign-out server revocation", () => {
  it("rejects the old cookie after a CSRF-validated direct sign-out and retains another device", async () => {
    const originalCookie = await sessionCookie();
    expect((await readSession(originalCookie)).user).toMatchObject({ id: account.id });
    const csrf = await withCsrf(originalCookie);
    const response = await signOut(csrf.cookie, csrf.csrfToken);
    expect(response.status).toBe(200);
    expect(response.headers.getSetCookie().some((value) => value.startsWith("authjs.session-token=") && value.includes("Max-Age=0"))).toBe(true);
    expect((await readSession(originalCookie)).user).toBeUndefined();
    expect((await readSession(await sessionCookie({ appSessionId: "other-device-session" }))).user).toMatchObject({ id: account.id });
    expect(auditCount).toBe(1);
    await signOut(csrf.cookie, csrf.csrfToken);
    expect(auditCount).toBe(1);
  });

  it("retains an effective cookie for retry when revocation fails despite Auth.js swallowing event failures", async () => {
    const originalCookie = await sessionCookie();
    const csrf = await withCsrf(originalCookie);
    harness.revokeSession.mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_DATABASE_DETAIL"));
    const response = await signOut(csrf.cookie, csrf.csrfToken);
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await readSession(originalCookie)).user).toMatchObject({ id: account.id });
    expect(auditCount).toBe(0);
    expect(inspect(harness.log.mock.calls, { depth: 8 })).not.toContain("SYNTHETIC_PRIVATE_DATABASE_DETAIL");
    expect((await signOut(csrf.cookie, csrf.csrfToken)).status).toBe(200);
    expect((await readSession(originalCookie)).user).toBeUndefined();
  });

  it("retains the cookie when Auth.js hides a session-storage read failure as an unauthenticated session", async () => {
    harness.currentCookie = await sessionCookie();
    harness.loadSession.mockRejectedValueOnce(new Error("SYNTHETIC_PRIVATE_DATABASE_DETAIL"));
    await expect(signOutCurrentAccount({ redirect: false })).rejects.toThrow();
    expect(harness.clearCookie).not.toHaveBeenCalled();
    expect(activeSessions.has(account.appSessionId)).toBe(true);
    expect(inspect(harness.log.mock.calls, { depth: 8 })).not.toContain("SYNTHETIC_PRIVATE_DATABASE_DETAIL");
    await signOutCurrentAccount({ redirect: false });
    expect(harness.clearCookie).toHaveBeenCalledOnce();
    expect(activeSessions.has(account.appSessionId)).toBe(false);
  });

  it("discards the Auth.js cookie-clearing response when a GET session read is unavailable", async () => {
    const originalCookie = await sessionCookie();
    harness.loadSession.mockRejectedValueOnce(new Error("Synthetic storage outage"));
    const response = await GET(new NextRequest(`${origin}/api/auth/session`, { headers: { cookie: originalCookie } }));
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect((await readSession(originalCookie)).user).toMatchObject({ id: account.id });
  });

  it("retains the cookie when the direct sign-out event cannot load its original server session", async () => {
    const originalCookie = await sessionCookie();
    const csrf = await withCsrf(originalCookie);
    harness.loadSession.mockRejectedValueOnce(new Error("Synthetic storage outage"));
    const response = await signOut(csrf.cookie, csrf.csrfToken);
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(activeSessions.has(account.appSessionId)).toBe(true);
    expect(auditCount).toBe(0);
  });

  it("keeps failure tracking isolated from a concurrent successful sign-out request", async () => {
    const csrf = await withCsrf(await sessionCookie());
    const other = await withCsrf(await sessionCookie({ appSessionId: "other-device-session" }));
    let begin!: () => void;
    let release!: () => void;
    const begun = new Promise<void>((resolve) => { begin = resolve; });
    const paused = new Promise<void>((resolve) => { release = resolve; });
    harness.revokeSession.mockImplementationOnce(async () => { begin(); await paused; throw new Error("Synthetic storage outage"); });
    const failing = signOut(csrf.cookie, csrf.csrfToken);
    try {
      await begun;
      expect((await signOut(other.cookie, other.csrfToken)).status).toBe(200);
    } finally { release(); }
    const response = await failing;
    expect(response.status).toBe(503);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(activeSessions.has(account.appSessionId)).toBe(true);
    expect(activeSessions.has("other-device-session")).toBe(false);
    expect(auditCount).toBe(1);
  });

  it("leaves the session valid for GET confirmation and a rejected CSRF POST", async () => {
    const originalCookie = await sessionCookie();
    await GET(new NextRequest(`${origin}/api/auth/signout`, { headers: { cookie: originalCookie } }));
    const csrf = await withCsrf(originalCookie);
    await signOut(csrf.cookie, "incorrect-csrf-token");
    expect(harness.revokeSession).not.toHaveBeenCalled();
    expect((await readSession(originalCookie)).user).toMatchObject({ id: account.id });
    expect(auditCount).toBe(0);
  });

  it("recovers a legacy token only to its original session before revocation", async () => {
    const originalCookie = await sessionCookie({ appSessionId: undefined });
    const csrf = await withCsrf(originalCookie);
    const response = await signOut(csrf.cookie, csrf.csrfToken);
    expect(response.status).toBe(200);
    expect(harness.recoverSession).toHaveBeenCalledWith(expect.objectContaining({ sub: account.id, memberId: account.memberId, householdId: account.householdId }), null);
    expect(activeSessions.has(account.appSessionId)).toBe(false);
    expect(activeSessions.has("other-device-session")).toBe(true);
  });

  it("does not revoke a session belonging to a different signed account", async () => {
    const csrf = await withCsrf(await sessionCookie({ sub: "different-account" }));
    expect((await signOut(csrf.cookie, csrf.csrfToken)).status).toBe(200);
    expect(activeSessions.has(account.appSessionId)).toBe(true);
    expect(auditCount).toBe(0);
  });
});
