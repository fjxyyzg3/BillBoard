import { NextRequest } from "next/server";
import { afterEach, describe, expect, it, vi } from "vitest";
import { proxy } from "../../src/proxy";

afterEach(() => vi.unstubAllEnvs());

describe("document content security policy", () => {
  it("replaces untrusted nonce headers with a fresh policy for each public document", async () => {
    vi.stubEnv("NODE_ENV", "production");
    const request = () => new NextRequest("https://app.example.com/login", {
      headers: { "x-nonce": "attacker-nonce", "content-security-policy": "script-src * 'unsafe-inline'" },
    });
    const first = await proxy(request());
    const second = await proxy(request());
    expect(first.headers.get("x-middleware-next")).toBe("1");
    const policy = first.headers.get("content-security-policy");
    const nonce = policy?.match(/'nonce-([A-Za-z0-9+/=]+)'/)?.[1];
    expect(nonce).toBeDefined();
    expect(Buffer.from(nonce!, "base64")).toHaveLength(32);
    expect(first.headers.get("x-middleware-request-content-security-policy")).toBe(policy);
    expect(first.headers.get("x-middleware-request-x-nonce")).toBe(nonce);
    expect(second.headers.get("content-security-policy")).not.toBe(policy);
    expect(first.headers.get("cache-control")).toBe("no-store");
    expect(policy).not.toContain("attacker");
    const scriptPolicy = policy?.split(";").find((part) => part.trim().startsWith("script-src "));
    expect(scriptPolicy).toContain("'strict-dynamic'");
    expect(scriptPolicy).not.toContain("'unsafe-inline'");
    expect(scriptPolicy).not.toContain("'unsafe-eval'");
    expect(policy).toContain("connect-src 'self'");
    expect(policy).toContain("frame-ancestors 'none'");
    expect(policy).toContain("media-src 'self' blob:");
  });

  it.each(["/login", "/help", "/account-link", "/forgot-password", "/ops", "/missing-page"])(
    "does not add household authentication to %s",
    async (path) => {
      const response = await proxy(new NextRequest(`http://127.0.0.1:2500${path}`));
      expect(response.headers.get("x-middleware-next")).toBe("1");
      expect(response.headers.get("content-security-policy")).toContain("'nonce-");
    },
  );

  it("permits development debugging and hot reload without weakening production", async () => {
    vi.stubEnv("NODE_ENV", "development");
    const response = await proxy(new NextRequest("http://127.0.0.1:2500/login"));
    const policy = response.headers.get("content-security-policy");
    expect(policy).toContain("'unsafe-eval'");
    expect(policy).toContain("connect-src 'self' ws: wss:");
    expect(policy).not.toContain("upgrade-insecure-requests");
  });
});
