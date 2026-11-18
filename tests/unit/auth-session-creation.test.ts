import type { JWT } from "next-auth/jwt";
import { beforeEach, describe, expect, it, vi } from "vitest";

type AuthOptions = {
  providers: Array<{ authorize: (credentials: Record<string, string>, request: Request) => Promise<unknown> }>;
  callbacks: { jwt: (input: { token: JWT; user?: unknown }) => Promise<JWT | null> };
};
const harness = vi.hoisted(() => ({
  options: null as AuthOptions | null,
  verify: vi.fn(), ensureSession: vi.fn(), record: vi.fn(),
}));
vi.mock("next-auth", async () => ({
  CredentialsSignin: (await import("@auth/core/errors")).CredentialsSignin,
  default: (options: AuthOptions) => { harness.options = options; return {}; },
}));
vi.mock("next-auth/providers/credentials", () => ({ default: (options: unknown) => options }));
vi.mock("@/lib/auth/login-admission", () => ({ verifyLoginCredentials: harness.verify }));
vi.mock("@/lib/auth/app-sessions", () => ({ ensureAppSessionForToken: harness.ensureSession, loadValidAccountSessionUser: vi.fn() }));
vi.mock("@/lib/ops/record-event", () => ({ recordAppEvent: harness.record }));

import "@/auth";

const user = {
  id: "verified-account", email: "verified@example.com", displayName: "Verified", passwordHash: "server-only-password-hash",
  status: "ACTIVE", householdMember: [{ id: "original-member", householdId: "original-household" }],
};
const request = new Request("http://127.0.0.1/api/auth/callback/credentials", { headers: { "user-agent": "Synthetic test browser" } });

beforeEach(() => {
  vi.clearAllMocks();
  harness.verify.mockResolvedValue({ status: "authenticated", user });
  harness.ensureSession.mockResolvedValue("new-app-session");
  harness.record.mockResolvedValue(undefined);
});

describe("verified credentials to app session boundary", () => {
  it("creates the server session with the credential snapshot before returning a safe Auth.js user", async () => {
    const authorized = await harness.options!.providers[0]!.authorize({ email: user.email, password: "synthetic-password" }, request);
    expect(harness.ensureSession).toHaveBeenCalledExactlyOnceWith(expect.any(Object), expect.objectContaining({
      id: user.id, email: user.email, passwordHash: user.passwordHash,
      memberId: "original-member", householdId: "original-household", appSessionUserAgent: "Synthetic test browser",
    }));
    expect(authorized).toMatchObject({ id: user.id, appSessionId: "new-app-session" });
    expect(JSON.stringify(authorized)).not.toContain(user.passwordHash);
    expect(JSON.stringify(harness.record.mock.calls)).not.toContain(user.passwordHash);
    const token = await harness.options!.callbacks.jwt({ token: {}, user: authorized });
    expect(token).toMatchObject({ sub: user.id, memberId: "original-member", appSessionId: "new-app-session" });
    expect(JSON.stringify(token)).not.toContain(user.passwordHash);
    expect(harness.ensureSession).toHaveBeenCalledTimes(1);
  });

  it("does not authorize or log success when the locked credential snapshot is no longer current", async () => {
    harness.ensureSession.mockResolvedValueOnce(null);
    const authorized = await harness.options!.providers[0]!.authorize({ email: user.email, password: "synthetic-password" }, request);
    expect(authorized).toBeNull();
    expect(harness.record).not.toHaveBeenCalledWith(expect.objectContaining({ eventType: "LOGIN_SUCCESS" }));
  });

  it("keeps verified account-only login sessions account-only through the JWT handoff", async () => {
    harness.verify.mockResolvedValueOnce({ status: "authenticated", user: { ...user, householdMember: [] } });
    const authorized = await harness.options!.providers[0]!.authorize({ email: user.email, password: "synthetic-password" }, request);
    const token = await harness.options!.callbacks.jwt({ token: {}, user: authorized });
    expect(token).toMatchObject({ sub: user.id, appSessionId: "new-app-session" });
    expect(token?.memberId).toBeUndefined();
    expect(token?.householdId).toBeUndefined();
    expect(JSON.stringify(token)).not.toContain(user.passwordHash);
  });

  it.each(["revoked", "unavailable"] as const)("discards a %s legacy token instead of allowing Auth.js to refresh its signed issued-at", async (reason) => {
    if (reason === "revoked") harness.ensureSession.mockResolvedValueOnce(null);
    else harness.ensureSession.mockRejectedValueOnce(new Error("Synthetic session storage failure"));
    const token = { sub: user.id, email: user.email, name: user.displayName, memberId: "original-member", householdId: "original-household", iat: 1_700_000_000, exp: 1_800_000_000 };
    expect(await harness.options!.callbacks.jwt({ token })).toBeNull();
  });

  it("allows a recovered legacy JWT to refresh only with its bound server session id", async () => {
    const token = { sub: user.id, email: user.email, name: user.displayName, memberId: "original-member", householdId: "original-household", iat: 1_700_000_000, exp: 1_800_000_000 };
    expect(await harness.options!.callbacks.jwt({ token })).toMatchObject({ ...token, appSessionId: "new-app-session" });
  });
});
