import { expect, test, type Response } from "./fixtures";

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

function expectSecurityHeaders(headers: Record<string, string>, referrer = "same-origin") {
  expect(headers["x-content-type-options"]).toBe("nosniff");
  expect(headers["referrer-policy"]).toBe(referrer);
  expect(headers["x-frame-options"]).toBe("DENY");
  expect(headers["strict-transport-security"]).toBe("max-age=31536000");
  expect(headers["content-security-policy"]).toContain("frame-ancestors 'none'");
}

test("serves the login document and its actual scripts and styles with MIME protection", async ({ page }) => {
  const assets: Response[] = [];
  page.on("response", (response) => {
    if (new URL(response.url()).pathname.startsWith("/_next/")
      && ["script", "stylesheet"].includes(response.request().resourceType())) assets.push(response);
  });
  const document = await page.goto("/login");
  expect(document).not.toBeNull();
  expect(document!.status()).toBe(200);
  const documentHeaders = await document!.allHeaders();
  expectSecurityHeaders(documentHeaders);
  expect(documentHeaders["content-type"]).toMatch(/^text\/html(?:;|$)/i);
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeEnabled();

  expect(assets.filter((response) => response.request().resourceType() === "script").length).toBeGreaterThan(0);
  expect(assets.filter((response) => response.request().resourceType() === "stylesheet").length).toBeGreaterThan(0);
  for (const asset of [...assets]) {
    expect(asset.status(), asset.url()).toBe(200);
    const headers = await asset.allHeaders();
    expectSecurityHeaders(headers);
    expect(headers["content-type"], asset.url()).toMatch(asset.request().resourceType() === "script"
      ? /^(?:text|application)\/(?:javascript|ecmascript)(?:;|$)/i : /^text\/css(?:;|$)/i);
  }
});

test("keeps same-origin referrers and omits them on cross-origin link navigation", async ({ page }) => {
  await page.goto("/login?reason=security-header-check");
  const source = page.url();
  const sessionRequest = page.waitForRequest((request) => new URL(request.url()).pathname === "/api/auth/session"
    && new URL(request.url()).searchParams.has("header-probe"));
  const sessionStatus = await page.evaluate(async () => (await fetch("/api/auth/session?header-probe=1", { cache: "no-store" })).status);
  expect(sessionStatus).toBe(200);
  expect((await (await sessionRequest).allHeaders()).referer).toBe(source);

  const externalUrl = "https://referrer-fixture.example.com/probe";
  let intercepted = false;
  let externalReferrer: string | undefined;
  await page.route(externalUrl, async (route) => {
    intercepted = true;
    externalReferrer = (await route.request().allHeaders()).referer;
    await route.fulfill({ status: 200, contentType: "text/html", body: "<!doctype html><title>Referrer fixture</title>" });
  });
  await page.evaluate((url) => {
    const link = document.createElement("a");
    link.href = url;
    document.body.append(link);
    link.click();
  }, externalUrl);
  await expect(page).toHaveURL(externalUrl);
  expect(intercepted).toBe(true);
  expect(externalReferrer).toBeUndefined();
});

test("uses fresh document nonces, blocks injected scripts and cross-origin connections, and permits the voice worklet", async ({ page }) => {
  const first = await page.goto("/login");
  const firstPolicy = first!.headers()["content-security-policy"];
  const firstNonce = firstPolicy.match(/'nonce-([^']+)'/)?.[1];
  expect(firstNonce).toBeTruthy();
  expect(first!.headers()["cache-control"]).toContain("no-store");
  const scripts = await page.evaluate(({ html, expectedNonce }) => Array.from(
    new DOMParser().parseFromString(html, "text/html").querySelectorAll("script"),
    (script) => ({ source: script.getAttribute("src"), type: script.type, nonceMatches: script.nonce === expectedNonce }),
  ), { html: await first!.text(), expectedNonce: firstNonce });
  expect(scripts.length).toBeGreaterThan(0);
  expect(scripts.filter((script) => !script.nonceMatches)).toEqual([]);

  await page.addInitScript(() => {
    document.addEventListener("securitypolicyviolation", (event) => {
      document.documentElement.dataset.blockedDirective = event.effectiveDirective;
    });
  });
  // Inject into the HTTP document before parsing, outside the trusted runtime script chain.
  await page.route("**/login", async (route) => {
    const response = await route.fetch();
    const body = (await response.text()).replace("</body>",
      "<script>document.documentElement.dataset.injectedScript = 'executed'</script></body>");
    await route.fulfill({ response, body });
  });
  await page.reload();
  await expect(page.locator("html")).toHaveAttribute("data-blocked-directive", "script-src-elem");
  await expect(page.locator("html")).not.toHaveAttribute("data-injected-script");
  await page.unroute("**/login");

  const externalUrl = "https://connection-fixture.example.com/probe";
  let reachedNetwork = false;
  await page.route(externalUrl, async (route) => {
    reachedNetwork = true;
    await route.fulfill({ status: 200, body: "unexpected" });
  });
  expect(await page.evaluate(async (url) => {
    try { await fetch(url); return "allowed"; } catch { return "blocked"; }
  }, externalUrl)).toBe("blocked");
  expect(reachedNetwork).toBe(false);

  expect(await page.evaluate(async () => {
    const context = new AudioContext();
    try {
      await context.audioWorklet.addModule("/voice-recorder-worklet.js");
      const node = new AudioWorkletNode(context, "billboard-voice-recorder");
      node.disconnect();
      return true;
    } finally { await context.close(); }
  })).toBe(true);

  const second = await page.reload();
  expect(second!.headers()["content-security-policy"]).not.toBe(firstPolicy);
  await expect(page.getByRole("button", { name: "登录", exact: true })).toBeEnabled();
  const missing = await page.goto("/missing-security-fixture");
  expect(missing!.status()).toBe(404);
  expectSecurityHeaders(missing!.headers());
  const missingNonce = missing!.headers()["content-security-policy"].match(/'nonce-([^']+)'/)?.[1];
  const errorScriptNonces = await page.evaluate((html) => Array.from(
    new DOMParser().parseFromString(html, "text/html").querySelectorAll("script"), (script) => script.nonce,
  ), await missing!.text());
  expect(errorScriptNonces.length).toBeGreaterThan(0);
  expect(errorScriptNonces.every((nonce) => nonce === missingNonce)).toBe(true);
});

test("preserves login submissions and stricter policies on account pages and private API responses", async ({ page, baseURL }) => {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码", { exact: true }).fill(requireEnv("SEED_USER_A_PASSWORD"));
  const submitted = page.waitForRequest((request) => request.method() === "POST"
    && new URL(request.url()).pathname === "/api/auth/callback/credentials");
  await page.getByRole("button", { name: "登录", exact: true }).click();
  expect((await (await submitted).allHeaders()).origin).toBe(baseURL);
  await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
  await expect(page.getByRole("heading", { name: "首页", exact: true })).toBeVisible();

  for (const path of ["/api/voice/audio", "/api/downloads/unsupported"]) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(404);
    expectSecurityHeaders(response.headers(), "no-referrer");
    expect(response.headers()["cache-control"], path).toContain("no-store");
  }
  for (const path of [
    "/api/records/export", "/api/household/view", "/api/household/encryption", "/api/downloads",
    "/api/android/update", `/api/android/update/${"0".repeat(64)}`,
    "/api/windows/update", `/api/windows/update/${"0".repeat(64)}`,
  ]) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expectSecurityHeaders(response.headers(), "no-referrer");
  }
  for (const path of ["/account", "/account-link", "/forgot-password"]) {
    const response = await page.request.get(path, { maxRedirects: 0 });
    expect(response.status(), path).toBe(200);
    expectSecurityHeaders(response.headers(), "no-referrer");
    if (path === "/account-link") {
      const nonce = response.headers()["content-security-policy"].match(/'nonce-([^']+)'/)?.[1];
      const bootstrapNonce = await page.evaluate((html) => Array.from(
        new DOMParser().parseFromString(html, "text/html").querySelectorAll("script"),
      ).find((script) => script.textContent.includes("__bbIdentityLinkFragment"))?.nonce, await response.text());
      expect(nonce).toBeTruthy();
      expect(bootstrapNonce).toBe(nonce);
    }
  }
});
