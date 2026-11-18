import { NextRequest } from "next/server";
import { encode, getToken } from "next-auth/jwt";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const secret = "middleware-synthetic-secret-only";
const now = new Date("2026-10-21T08:00:00.000Z");
const original = { sub: "fixture-user", email: "fixture@example.com", name: "Fixture", householdId: "original-household", memberId: "original-member" };

beforeEach(() => {
  vi.resetModules();
  vi.useFakeTimers({ toFake: ["Date"] });
  vi.setSystemTime(now);
  vi.stubEnv("AUTH_SECRET", secret);
  vi.stubEnv("NEXTAUTH_SECRET", undefined);
  vi.stubEnv("AUTH_URL", undefined);
  vi.stubEnv("NEXTAUTH_URL", undefined);
  vi.stubEnv("NODE_ENV", "test");
});
afterEach(() => { vi.useRealTimers(); vi.unstubAllEnvs(); vi.restoreAllMocks(); });

function cookieName(secure: boolean) { return `${secure ? "__Secure-" : ""}authjs.session-token`; }

async function legacyCookie(secure = false, expired = false) {
  const salt = cookieName(secure);
  vi.setSystemTime(new Date(now.getTime() - 120_000));
  try {
    const value = await encode({ token: original, secret, salt, maxAge: expired ? 30 : 3600 });
    return { name: salt, value };
  } finally { vi.setSystemTime(now); }
}

function request(url: string, cookie?: { name: string; value: string }, headers: Record<string, string> = {}) {
  return new NextRequest(url, { headers: { "x-forwarded-proto": new URL(url).protocol.slice(0, -1), ...(cookie ? { cookie: `${cookie.name}=${cookie.value}` } : {}), ...headers } });
}

function withResponseCookies(incoming: NextRequest, response: Response) {
  const values = new Map((incoming.headers.get("cookie") ?? "").split("; ").filter(Boolean).map((value) => { const equals = value.indexOf("="); return [value.slice(0, equals), value.slice(equals + 1)]; }));
  for (const cookie of response.headers.getSetCookie()) {
    const pair = cookie.split(";")[0];
    const equals = pair.indexOf("=");
    values.set(pair.slice(0, equals), pair.slice(equals + 1));
  }
  return request(incoming.url, undefined, { cookie: [...values].map(([name, value]) => `${name}=${value}`).join("; ") });
}

describe("read-only JWT middleware", () => {
  it.each([false, true])("keeps the original legacy iat, jti, expiry and member on a secure=%s request", async (secure) => {
    const cookie = await legacyCookie(secure);
    const incoming = request(`${secure ? "https" : "http"}://app.example.com/home?range=month`, cookie);
    const before = await getToken({ req: incoming, secret, secureCookie: secure });
    const { proxy: middleware } = await import("@/proxy");
    const response = await middleware(incoming);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.getSetCookie()).toEqual([]);
    const after = await getToken({ req: withResponseCookies(incoming, response), secret, secureCookie: secure });
    expect(after).toEqual(before);
    expect(after).toMatchObject({ ...original, iat: Math.floor(now.getTime() / 1000) - 120 });
  });

  it("cannot refresh a legacy token past the sensitive-action audit cutoff", async () => {
    const cookie = await legacyCookie();
    const incoming = request("http://app.example.com/home", cookie);
    const cutoff = Math.floor(now.getTime() / 1000) - 60;
    const { proxy: middleware } = await import("@/proxy");
    const response = await middleware(incoming);
    const next = await getToken({ req: withResponseCookies(incoming, response), secret, secureCookie: false });
    expect(next?.iat).toBeLessThanOrEqual(cutoff);
    expect(next?.appSessionId).toBeUndefined();
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("reads Auth.js chunked cookies without replacing their original session key", async () => {
    const cookie = await legacyCookie();
    const midpoint = Math.floor(cookie.value.length / 2);
    const incoming = request("http://app.example.com/records", undefined, { cookie: `${cookie.name}.1=${cookie.value.slice(midpoint)}; ${cookie.name}.0=${cookie.value.slice(0, midpoint)}` });
    const { proxy: middleware } = await import("@/proxy");
    const response = await middleware(incoming);
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each(["missing", "malformed", "expired"] as const)("redirects a %s browser session with the existing safe callback URL", async (kind) => {
    const cookie = kind === "missing" ? undefined : kind === "malformed" ? { name: cookieName(false), value: "invalid-jwe" } : await legacyCookie(false, true);
    const incoming = request("http://app.example.com/records?range=month", cookie);
    const { proxy: middleware } = await import("@/proxy");
    const response = await middleware(incoming);
    const redirect = new URL(response.headers.get("location")!);
    expect(response.status).toBe(307);
    expect(redirect.pathname).toBe("/login");
    expect(redirect.searchParams.get("callbackUrl")).toBe(incoming.url);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(redirect.href).not.toContain(cookie?.value ?? "authjs.session-token");
  });

  it("keeps Authorization headers outside the browser-cookie entry boundary", async () => {
    const cookie = await legacyCookie();
    const { proxy: middleware } = await import("@/proxy");
    const response = await middleware(request("http://app.example.com/account", undefined, { authorization: `Bearer ${cookie.value}` }));
    expect(response.status).toBe(307);
    expect(response.headers.get("location")).not.toContain(cookie.value);
  });

  it("selects the secure cookie behind a TLS forwarding hop", async () => {
    const cookie = await legacyCookie(true);
    const { proxy: middleware } = await import("@/proxy");
    const response = await middleware(request("http://127.0.0.1:2500/account", cookie, { "x-forwarded-proto": "https" }));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each(["/home", "/account"])("redirects a forwarded guest on %s to the public login origin", async (pathname) => {
    const { proxy: middleware } = await import("@/proxy");
    const response = await middleware(request(`http://127.0.0.1:2500${pathname}?range=month`, undefined, { "x-forwarded-proto": "https", "x-forwarded-host": "app.example.com" }));
    const redirect = new URL(response.headers.get("location")!);
    expect(redirect.origin).toBe("https://app.example.com");
    expect(redirect.pathname).toBe("/login");
    expect(redirect.searchParams.get("callbackUrl")).toBe(`https://app.example.com${pathname}?range=month`);
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it.each(["AUTH_URL", "NEXTAUTH_URL"] as const)("honors the configured public protocol and origin from %s", async (key) => {
    vi.stubEnv(key, "https://app.example.com/api/auth");
    const cookie = await legacyCookie(true);
    const { proxy: middleware } = await import("@/proxy");
    const accepted = await middleware(request("http://127.0.0.1:2500/account", cookie));
    expect(accepted.headers.get("x-middleware-next")).toBe("1");
    expect(accepted.headers.getSetCookie()).toEqual([]);
    const redirect = await middleware(request("http://127.0.0.1:2500/account"));
    expect(new URL(redirect.headers.get("location")!).origin).toBe("https://app.example.com");
  });

  it("uses the existing NEXTAUTH_SECRET fallback", async () => {
    vi.stubEnv("AUTH_SECRET", undefined);
    vi.stubEnv("NEXTAUTH_SECRET", secret);
    const cookie = await legacyCookie();
    const { proxy: middleware } = await import("@/proxy");
    const response = await middleware(request("http://app.example.com/add", cookie));
    expect(response.headers.get("x-middleware-next")).toBe("1");
    expect(response.headers.getSetCookie()).toEqual([]);
  });

  it("fails closed without a production secret and never logs the encrypted cookie", async () => {
    const cookie = await legacyCookie();
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("AUTH_SECRET", undefined);
    const error = vi.spyOn(console, "error").mockImplementation(() => undefined);
    const { proxy: middleware } = await import("@/proxy");
    const response = await middleware(request("http://app.example.com/home", cookie));
    expect(response.status).toBe(307);
    expect(response.headers.getSetCookie()).toEqual([]);
    expect(error).not.toHaveBeenCalled();
  });
});
