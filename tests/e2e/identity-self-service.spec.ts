import { createHash, randomBytes, randomUUID } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { hash } from "argon2";
import { PrismaClient } from "@prisma/client";
import type { Page } from "@playwright/test";
import { createHouseholdInvitation, createPlatformInvitation } from "../../src/lib/identity/invitations";
import { getMessages } from "../../src/lib/i18n";
import { getCapturedIdentityMail } from "./mail-fixture";
import { expect, test } from "./fixtures";

const databaseUrl = new URL(process.env.DATABASE_URL ?? "");
if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(databaseUrl.hostname) || !/_(?:dev|test)$/.test(databaseUrl.pathname)) throw new Error("Identity fixtures require a local development/test database");
const database = new PrismaClient();
const password = "Identity-fixture-password";
const emails: string[] = [];
const householdIds = new Set<string>();
function emailFor(label: string) { const value = `identity-${label.toLowerCase()}-${randomUUID()}@example.com`; emails.push(value); return value; }

async function createAccount(label: string, verified = true) {
  return database.user.create({ data: { email: emailFor(label), displayName: label, passwordHash: await hash(password), emailVerifiedAt: verified ? new Date() : null } });
}

async function createHousehold(owner: Awaited<ReturnType<typeof createAccount>>, name = "Identity fixture household") {
  const household = await database.household.create({ data: { name, ledgers: { create: { name: "Default", isDefault: true } }, members: { create: { memberName: owner.displayName, role: "OWNER", userId: owner.id } } }, include: { members: true, ledgers: true } });
  householdIds.add(household.id);
  const member = household.members[0];
  const session = await database.appSession.create({ data: { userId: owner.id, memberId: member.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 3_600_000) } });
  return { household, member, session: { id: owner.id, appSessionId: session.id, email: owner.email, name: owner.displayName, householdId: household.id, memberId: member.id, role: "OWNER" as const } };
}

async function allowNextMail(email: string) {
  await database.identityRateLimit.updateMany({ where: { id: `mail:${createHash("sha256").update(email.toLowerCase()).digest("hex")}` }, data: { lastAttemptAt: new Date(Date.now() - 61_000) } });
}

async function linkFromMail(email: string, kind: string, afterCount = 0) {
  let links: string[] = [];
  await expect.poll(async () => {
    links = (await getCapturedIdentityMail(email)).flatMap((mail) => mail.text.match(/http:\/\/127\.0\.0\.1:2501\/account-link#[^\s]+/g) ?? []).filter((link) => new URLSearchParams(new URL(link).hash.slice(1)).get("kind") === kind);
    return links.length;
  }, { timeout: 15_000 }).toBeGreaterThan(afterCount);
  return links[links.length - 1];
}

async function openEmailLink(page: Page, link: string) {
  const requests: string[] = [];
  const capture = (request: { method(): string; url(): string }) => { if (request.method() === "GET") requests.push(request.url()); };
  page.on("request", capture);
  await page.goto(link);
  await expect(page).toHaveURL("http://127.0.0.1:2501/account-link");
  expect(requests.every((url) => !url.includes("token=") && !url.includes("#kind="))).toBe(true);
  page.off("request", capture);
  const token = new URLSearchParams(new URL(link).hash.slice(1)).get("token")!;
  expect(await page.evaluate((raw) => [localStorage, sessionStorage].some((storage) => Object.keys(storage).some((key) => storage.getItem(key)?.includes(raw))), token)).toBe(false);
}

async function login(page: Page, email: string, currentPassword = password) {
  await page.goto("/login");
  await page.getByLabel("邮箱", { exact: true }).fill(email);
  await page.getByLabel("密码", { exact: true }).fill(currentPassword);
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/);
}

async function captureIdentityScreen(page: Page, name: string) {
  for (const width of [390, 768, 1440]) {
    await page.setViewportSize({ width, height: width === 390 ? 844 : 1000 });
    expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
    await page.screenshot({ path: `test-results/${name}-${width}.png`, fullPage: true });
  }
  // Inspect the actual rendered DOM with its original CSS and fonts, without auth cookies or scripts.
  const snapshot = await page.evaluate(async () => {
    let css = Array.from(document.styleSheets).flatMap((sheet) => Array.from(sheet.cssRules).map((rule) => rule.cssText.replace(/url\(["']?([^"')]+)["']?\)/g, (match, resource: string) => resource.startsWith("data:") ? match : `url("${new URL(resource, sheet.href ?? document.baseURI).href}")`))).join("\n");
    const resources = [...css.matchAll(/url\(["']?([^"')]+)["']?\)/g)].map((match) => match[1]).filter((url) => !url.startsWith("data:"));
    for (const resource of new Set(resources)) {
      const response = await fetch(new URL(resource, document.baseURI));
      if (!response.ok) continue;
      const bytes = new Uint8Array(await response.arrayBuffer());
      let binary = "";
      for (let offset = 0; offset < bytes.length; offset += 0x8000) binary += String.fromCharCode(...bytes.slice(offset, offset + 0x8000));
      css = css.split(resource).join(`data:${response.headers.get("content-type") ?? "application/octet-stream"};base64,${btoa(binary)}`);
    }
    const documentCopy = document.documentElement.cloneNode(true) as HTMLElement;
    documentCopy.querySelectorAll("script,link,input[type=hidden],nextjs-portal").forEach((element) => element.remove());
    documentCopy.querySelectorAll<HTMLInputElement>('input[type="password"]').forEach((input) => { input.value = ""; input.removeAttribute("value"); });
    const style = document.createElement("style");
    style.textContent = css;
    documentCopy.querySelector("head")!.appendChild(style);
    return `<!doctype html>${documentCopy.outerHTML}`;
  });
  await writeFile(`test-results/${name}.html`, snapshot);
}

test.afterEach(async () => {
  const users = await database.user.findMany({ where: { email: { in: emails } }, select: { id: true, householdMember: { select: { householdId: true } } } });
  for (const user of users) for (const member of user.householdMember) householdIds.add(member.householdId);
  const ids = users.map((user) => user.id);
  await database.appSession.deleteMany({ where: { userId: { in: ids } } });
  await database.accountToken.deleteMany({ where: { OR: [{ userId: { in: ids } }, { email: { in: emails } }] } });
  await database.invitation.deleteMany({ where: { OR: [{ email: { in: emails } }, { householdId: { in: [...householdIds] } }] } });
  await database.household.deleteMany({ where: { id: { in: [...householdIds] } } });
  await database.user.deleteMany({ where: { id: { in: ids } } });
  emails.length = 0;
  householdIds.clear();
});
test.afterAll(async () => { await database.$disconnect(); });

for (const exit of ["account", "invitation", "builtin"] as const) {
  test(`${exit} sign-out rejects a replayed old cookie while retaining another device session`, async ({ page, browser }) => {
    const account = await createAccount(`logout-${exit}`);
    const host = await createHousehold(account);
    await login(page, account.email);
    const current = await database.appSession.findFirstOrThrow({
      where: { userId: account.id, id: { not: host.session.appSessionId } }, orderBy: { loginAt: "desc" },
    });
    const originalCookies = await page.context().cookies();
    const other = await browser.newContext();
    const replay = await browser.newContext({ storageState: { cookies: originalCookies, origins: [] } });
    try {
      const otherPage = await other.newPage();
      await login(otherPage, account.email);
      expect((await replay.request.get("http://127.0.0.1:2501/api/account/processing")).status()).toBe(200);
      if (exit === "account") {
        await page.goto("/account");
        await page.getByRole("button", { name: "退出登录", exact: true }).click();
        await expect(page).toHaveURL(/\/login$/);
      } else if (exit === "invitation") {
        const token = randomBytes(32).toString("base64url");
        await database.invitation.create({ data: {
          purpose: "PLATFORM", email: emailFor("logout-invitation-target"),
          tokenHash: createHash("sha256").update(token).digest("hex"),
          expiresAt: new Date(Date.now() + 60_000), sentAt: new Date(),
        } });
        await openEmailLink(page, `http://127.0.0.1:2501/account-link#kind=invite&token=${token}`);
        await page.getByRole("button", { name: "切换账号", exact: true }).click();
        await expect(page.getByRole("tab", { name: "已有账号", exact: true })).toHaveAttribute("aria-selected", "true");
      } else {
        await page.goto("/api/auth/signout?callbackUrl=%2Flogin");
        const formOrigin = await page.locator("form").evaluate((form: HTMLFormElement) => new URL(form.action).origin);
        expect(formOrigin).toBe(new URL(page.url()).origin);
        expect((await database.appSession.findUniqueOrThrow({ where: { id: current.id } })).revokedAt).toBeNull();
        await page.getByRole("button", { name: "Sign out", exact: true }).click();
        await expect(page).toHaveURL(/\/login$/);
      }
      expect((await database.appSession.findUniqueOrThrow({ where: { id: current.id } })).revokedAt).not.toBeNull();
      expect((await replay.request.get("http://127.0.0.1:2501/api/account/processing")).status()).toBe(401);
      await otherPage.goto("/account");
      await expect(otherPage.getByRole("heading", { name: "本人账号", exact: true })).toBeVisible();
    } finally { await replay.close(); await other.close(); }
  });
}

test("a new platform invite registers only after the second email and explicit confirmation", async ({ page }) => {
  test.setTimeout(90_000);
  const email = emailFor("registration");
  const invitation = await createPlatformInvitation({ email });
  const inviteLink = await linkFromMail(email, "invite");
  await openEmailLink(page, inviteLink);
  await expect(page.getByRole("heading", { name: "创建独立家庭", exact: true })).toBeVisible();
  expect((await database.invitation.findUniqueOrThrow({ where: { id: invitation.id } })).consumedAt).toBeNull();
  expect(await database.user.count({ where: { email } })).toBe(0);
  await page.getByLabel("账号显示名", { exact: true }).fill("New household owner");
  await page.getByLabel("家庭内称呼", { exact: true }).fill("Owner");
  await page.getByLabel("家庭名称", { exact: true }).fill("Independent family");
  await page.getByLabel("新密码", { exact: true }).fill(password);
  await page.getByLabel("再次输入新密码", { exact: true }).fill(password);
  await allowNextMail(email);
  await page.getByRole("button", { name: "设置账号并验证邮箱", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("邮件已发送");
  expect(await database.user.count({ where: { email } })).toBe(0);
  const registrationLink = await linkFromMail(email, "registration");
  await openEmailLink(page, registrationLink);
  await expect(page.getByRole("button", { name: "验证邮箱并完成注册", exact: true })).toBeVisible();
  expect(await database.user.count({ where: { email } })).toBe(0);
  await page.getByRole("button", { name: "验证邮箱并完成注册", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?reason=account-updated$/);
  const account = await database.user.findUniqueOrThrow({ where: { email }, include: { householdMember: { include: { household: { include: { ledgers: true } } } } } });
  expect(account.emailVerifiedAt).not.toBeNull();
  expect(account.householdMember).toHaveLength(1);
  expect(account.householdMember[0].role).toBe("OWNER");
  expect(account.householdMember[0].household.name).toBe("Independent family");
  expect(account.householdMember[0].household.ledgers.filter((ledger) => ledger.isDefault && !ledger.archivedAt)).toHaveLength(1);
  await login(page, email);
  await page.goto("/account");
  await expect(page.getByRole("heading", { name: "本人账号", exact: true })).toBeVisible();
  await expect(page.getByText(email, { exact: true })).toBeVisible();
  await openEmailLink(page, registrationLink);
  await page.getByRole("button", { name: "验证邮箱并完成注册", exact: true }).click();
  await expect(page.getByRole("alert").filter({ hasText: "注册验证链接无法使用" })).toBeVisible();
  expect(await database.user.count({ where: { email } })).toBe(1);
});

for (const purpose of ["PLATFORM", "HOUSEHOLD"] as const) {
  test(`an existing account without a household accepts ${purpose} through inline sign-in`, async ({ page }) => {
    test.setTimeout(90_000);
    const invited = await createAccount(`existing-${purpose}`);
    let targetHouseholdId: string | undefined;
    if (purpose === "PLATFORM") await createPlatformInvitation({ email: invited.email });
    else {
      const owner = await createAccount("host-owner");
      const host = await createHousehold(owner, "Target shared family");
      targetHouseholdId = host.household.id;
      await createHouseholdInvitation(host.session, { email: invited.email });
    }
    await openEmailLink(page, await linkFromMail(invited.email, "invite"));
    await expect(page.getByRole("heading", { name: purpose === "PLATFORM" ? "创建独立家庭" : "加入家庭", exact: true })).toBeVisible();
    if (purpose === "HOUSEHOLD") await expect(page.getByText("Target shared family", { exact: true })).toBeVisible();
    await page.getByRole("tab", { name: "已有账号", exact: true }).click();
    await page.getByLabel("当前密码", { exact: true }).fill(password);
    await page.getByRole("button", { name: "在此登录", exact: true }).click();
    await expect(page.getByText(invited.email, { exact: true })).toHaveCount(2);
    await expect(page).toHaveURL("http://127.0.0.1:2501/account-link");
    await page.getByLabel("家庭内称呼", { exact: true }).fill("Invited member");
    if (purpose === "PLATFORM") await page.getByLabel("家庭名称", { exact: true }).fill("Existing account new family");
    await page.getByRole("checkbox").check();
    await page.getByRole("button", { name: "确认使用邀请", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?reason=account-updated$/);
    const memberships = await database.householdMember.findMany({ where: { userId: invited.id, leftAt: null } });
    expect(memberships).toHaveLength(1);
    expect(memberships[0].role).toBe(purpose === "PLATFORM" ? "OWNER" : "MEMBER");
    if (targetHouseholdId) expect(memberships[0].householdId).toBe(targetHouseholdId);
    expect(await database.user.count({ where: { email: invited.email } })).toBe(1);
    expect(await database.appSession.count({ where: { userId: invited.id, revokedAt: null } })).toBe(0);
    await login(page, invited.email);
    await page.goto("/account/household");
    await expect(page.getByText("Invited member · 本人", { exact: true })).toBeVisible();
    if (purpose === "HOUSEHOLD") await expect(page.getByRole("heading", { name: "邀请家人", exact: true })).toHaveCount(0);
  });
}

test("password change has one authoritative reauthentication destination", async ({ page }) => {
  const account = await createAccount("reauthentication-order");
  await login(page, account.email);
  await page.goto("/account");
  const form = page.locator("form").filter({ has: page.getByLabel("再次输入新密码", { exact: true }) });
  await form.getByLabel("当前密码", { exact: true }).fill(password);
  await form.getByLabel("新密码", { exact: true }).fill("Changed-fixture-password");
  await form.getByLabel("再次输入新密码", { exact: true }).fill("Changed-fixture-password");
  const staleCookie = (await page.context().cookies()).map((cookie) => `${cookie.name}=${cookie.value}`).join("; ");
  const draftKey = "billboard:transaction-draft:reauthentication-probe";
  await page.evaluate((key) => sessionStorage.setItem(key, "synthetic-draft"), draftKey);
  let inspectResponse!: (state: { expired: boolean; revoked: boolean; replayStatus: number }) => void;
  const inspected = new Promise<{ expired: boolean; revoked: boolean; replayStatus: number }>((resolve) => { inspectResponse = resolve; });
  let first = true;
  let inspectCleanup!: (cleaned: boolean) => void;
  const cleanup = new Promise<boolean>((resolve) => { inspectCleanup = resolve; });
  await page.route("**/account", async (route) => {
    if (route.request().method() !== "POST") return route.continue();
    const mutation = first;
    first = false;
    if (!mutation) inspectCleanup(await page.evaluate((key) => sessionStorage.getItem(key) === null, draftKey));
    const response = await route.fetch();
    if (mutation) {
      const body = await response.text();
      const revoked = await database.appSession.count({ where: { userId: account.id, revokedAt: null } }) === 0;
      const replay = await page.request.get("/api/account/processing", { headers: { Cookie: staleCookie } });
      inspectResponse({ expired: body.includes("session-expired"), revoked, replayStatus: replay.status() });
    }
    await route.fulfill({ response });
  });
  await form.getByRole("button", { name: "修改密码", exact: true }).click();
  // Inspect only the reason flag; never include a Flight payload or credentials in diagnostics.
  expect(await inspected).toEqual({ expired: false, revoked: true, replayStatus: 401 });
  await expect(page).toHaveURL(/\/login\?reason=account-updated$/);
  expect(await cleanup).toBe(true);
  expect(await database.appSession.count({ where: { userId: account.id, revokedAt: null } })).toBe(0);
  await login(page, account.email, "Changed-fixture-password");
});

test("account-only access verifies and changes email, recovers a password, and revokes other sessions", async ({ page, browser }) => {
  test.setTimeout(120_000);
  const account = await createAccount("account-security", false);
  const changedEmail = emailFor("changed-email");
  await login(page, account.email);
  await expect(page.getByRole("heading", { name: "当前没有可访问的家庭", exact: true })).toBeVisible();
  await page.getByRole("link", { name: "管理本人账号", exact: true }).click();
  await expect(page.getByRole("heading", { name: "本人账号", exact: true })).toBeVisible();
  await expect(page.getByText("未验证", { exact: true })).toBeVisible();
  await page.getByRole("button", { name: "验证当前邮箱", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("请求已受理");
  expect((await database.user.findUniqueOrThrow({ where: { id: account.id } })).emailVerifiedAt).toBeNull();
  await openEmailLink(page, await linkFromMail(account.email, "verify"));
  await page.getByRole("button", { name: "确认验证邮箱", exact: true }).click();
  await expect(page.getByRole("status")).toContainText("已完成");
  await page.getByRole("link", { name: "打开本人账号", exact: true }).click();
  await expect(page.getByText("已验证", { exact: true })).toBeVisible();
  await page.getByText("换绑邮箱", { exact: true }).click();
  const emailForm = page.locator("form").filter({ has: page.getByLabel("新邮箱", { exact: true }) });
  await emailForm.getByLabel("新邮箱", { exact: true }).fill(changedEmail);
  await emailForm.getByLabel("当前密码", { exact: true }).fill(password);
  await emailForm.getByRole("button", { name: "确认", exact: true }).click();
  await expect(emailForm.getByRole("status")).toContainText("请求已受理");
  expect((await database.user.findUniqueOrThrow({ where: { id: account.id } })).email).toBe(account.email);
  await openEmailLink(page, await linkFromMail(changedEmail, "verify"));
  await page.getByRole("button", { name: "确认验证邮箱", exact: true }).click();
  await expect(page).toHaveURL(/\/login\?reason=account-updated$/);
  expect((await database.user.findUniqueOrThrow({ where: { id: account.id } })).email).toBe(changedEmail);
  const other = await browser.newContext();
  try {
    const otherPage = await other.newPage();
    await login(otherPage, changedEmail);
    await login(page, changedEmail);
    await page.goto("/account");
    const otherSession = page.locator("li").filter({ has: page.getByRole("button", { name: "撤销会话", exact: true }) });
    await expect(otherSession).toHaveCount(1);
    const targetSessionId = await otherSession.locator('input[name="sessionId"]').inputValue();
    await otherSession.getByRole("button", { name: "撤销会话", exact: true }).click();
    await expect(page.locator(`input[name="sessionId"][value="${targetSessionId}"]`)).toHaveCount(0);
    expect((await database.appSession.findUniqueOrThrow({ where: { id: targetSessionId } })).revokedAt).not.toBeNull();
    await otherPage.goto("/account");
    await expect(otherPage).toHaveURL(/\/login(?:\?.*)?$/);
    const passwordForm = page.locator("form").filter({ has: page.getByLabel("再次输入新密码", { exact: true }) });
    await passwordForm.getByLabel("当前密码", { exact: true }).fill("Incorrect-fixture-password");
    await passwordForm.getByLabel("新密码", { exact: true }).fill("Changed-fixture-password");
    await passwordForm.getByLabel("再次输入新密码", { exact: true }).fill("Changed-fixture-password");
    await passwordForm.getByRole("button", { name: "修改密码", exact: true }).click();
    await expect(passwordForm.getByRole("alert")).toContainText("当前密码不正确");
    expect(await database.appSession.count({ where: { userId: account.id, revokedAt: null } })).toBe(1);
    await captureIdentityScreen(page, "identity-account-error");
    await passwordForm.getByLabel("当前密码", { exact: true }).fill(password);
    await passwordForm.getByRole("button", { name: "修改密码", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?reason=account-updated$/);
    await login(page, changedEmail, "Changed-fixture-password");
    await page.goto("/forgot-password");
    await page.getByLabel("邮箱", { exact: true }).fill(changedEmail);
    await allowNextMail(changedEmail);
    await page.getByRole("button", { name: "申请恢复邮件", exact: true }).click();
    await expect(page.getByRole("status")).toContainText("请求已受理");
    const resetLink = await linkFromMail(changedEmail, "reset");
    await openEmailLink(page, resetLink);
    const replacement = "Replacement-fixture-password";
    await page.getByLabel("新密码", { exact: true }).fill(replacement);
    await page.getByLabel("再次输入新密码", { exact: true }).fill(replacement);
    await page.getByRole("button", { name: "设置新密码", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?reason=account-updated$/);
    expect(await database.appSession.count({ where: { userId: account.id, revokedAt: null } })).toBe(0);
    await login(page, changedEmail, replacement);
    expect((await database.user.findUniqueOrThrow({ where: { id: account.id } })).status).toBe("ACTIVE");
  } finally { await other.close(); }
});

test("removal and reinvitation use a new member identity while shared history survives ownership transfer and leaving", async ({ page, browser }) => {
  test.setTimeout(150_000);
  const owner = await createAccount("original-owner");
  const memberAccount = await createAccount("original-member");
  const host = await createHousehold(owner);
  const originalMember = await database.householdMember.create({ data: { householdId: host.household.id, userId: memberAccount.id, role: "MEMBER", memberName: "Family member" } });
  const category = await database.category.findFirstOrThrow({ where: { isActive: true, type: "EXPENSE" } });
  const history = await database.transaction.create({ data: { householdId: host.household.id, ledgerId: host.household.ledgers[0].id, actorMemberId: originalMember.id, createdByMemberId: originalMember.id, amountFen: 12345, categoryId: category.id, occurredAt: new Date(), type: "EXPENSE", note: "Identity historical expense" } });
  const memberBrowser = await browser.newContext();
  try {
    const memberPage = await memberBrowser.newPage();
    await login(memberPage, memberAccount.email);
    await login(page, owner.email);
    await page.goto("/account/household");
    const removeDetails = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: "移除成员 · Family member" }) });
    await removeDetails.locator("summary").click();
    await removeDetails.getByLabel("当前密码", { exact: true }).fill(password);
    await removeDetails.getByRole("checkbox").check();
    await removeDetails.getByRole("button", { name: "移除成员 · Family member", exact: true }).click();
    await expect(removeDetails).toHaveCount(0);
    expect((await database.householdMember.findUniqueOrThrow({ where: { id: originalMember.id } })).leftAt).not.toBeNull();
    await memberPage.goto("/records");
    await expect(memberPage).toHaveURL(/\/login(?:\?.*)?$/);
    await login(memberPage, memberAccount.email);
    await expect(memberPage.getByRole("heading", { name: "当前没有可访问的家庭", exact: true })).toBeVisible();
    await page.getByLabel("受邀邮箱", { exact: true }).fill(memberAccount.email);
    await page.getByRole("button", { name: "发送邀请", exact: true }).click();
    const invitationForm = page.locator("form").filter({ has: page.getByLabel("受邀邮箱", { exact: true }) });
    await expect(invitationForm.getByRole("status")).toContainText("邮件已发送");
    await openEmailLink(memberPage, await linkFromMail(memberAccount.email, "invite"));
    await memberPage.getByLabel("家庭内称呼", { exact: true }).fill("Family member");
    await memberPage.getByRole("checkbox").check();
    await memberPage.getByRole("button", { name: "确认使用邀请", exact: true }).click();
    await expect(memberPage).toHaveURL(/\/login\?reason=account-updated$/);
    const newMember = await database.householdMember.findFirstOrThrow({ where: { userId: memberAccount.id, leftAt: null } });
    expect(newMember.id).not.toBe(originalMember.id);
    await login(memberPage, memberAccount.email);
    await memberPage.goto("/records");
    await expect(memberPage.getByText("Identity historical expense", { exact: true })).toBeVisible();
    await expect(memberPage.getByText("Family member（已退出）", { exact: false }).first()).toBeVisible();
    expect((await database.transaction.findUniqueOrThrow({ where: { id: history.id } })).actorMemberId).toBe(originalMember.id);
    await page.reload();
    const transferDetails = page.locator("details").filter({ has: page.locator("summary").filter({ hasText: "转让负责人 · Family member" }) });
    await transferDetails.locator("summary").click();
    await transferDetails.getByLabel("当前密码", { exact: true }).fill(password);
    await transferDetails.getByRole("checkbox").check();
    await transferDetails.getByRole("button", { name: "转让负责人 · Family member", exact: true }).click();
    await expect(page.getByRole("heading", { name: "邀请家人", exact: true })).toHaveCount(0);
    expect((await database.householdMember.findUniqueOrThrow({ where: { id: newMember.id } })).role).toBe("OWNER");
    const leaveForm = page.locator("form").filter({ has: page.getByRole("button", { name: "退出家庭", exact: true }) });
    await leaveForm.getByLabel("当前密码", { exact: true }).fill(password);
    await leaveForm.getByRole("checkbox").check();
    await leaveForm.getByRole("button", { name: "退出家庭", exact: true }).click();
    await expect(page).toHaveURL(/\/login\?reason=account-updated$/);
    await memberPage.goto("/account/household");
    await expect(memberPage.getByRole("heading", { name: "邀请家人", exact: true })).toBeVisible();
    await expect(memberPage.getByText(getMessages("zh-CN").identity.ownerLeaveHelp, { exact: true })).toBeVisible();
    expect(await database.transaction.aggregate({ where: { householdId: host.household.id, deletedAt: null }, _sum: { amountFen: true } })).toMatchObject({ _sum: { amountFen: 12345 } });
    await captureIdentityScreen(memberPage, "identity-household");
  } finally { await memberBrowser.close(); }
});
