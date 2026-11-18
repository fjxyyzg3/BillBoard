import { Children, isValidElement, type ReactElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { getMessages } from "@/lib/i18n";

const harness = vi.hoisted(() => ({ account: vi.fn(), app: vi.fn(), overview: vi.fn(), management: vi.fn(), locale: vi.fn(), preview: vi.fn(), complete: vi.fn() }));
vi.mock("@/lib/encryption/request", () => ({ getHouseholdEncryptionStatus: async () => ({ mode: "UNENCRYPTED", revision: 0, generation: null, keyVersion: 0, isOwner: true, operation: null }) }));
vi.mock("@/auth", () => ({ signOut: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireAccountSession: harness.account, requireAppSession: harness.app }));
vi.mock("@/lib/identity/account", () => ({ getAccountOverview: harness.overview, changeAccountPassword: vi.fn(), prepareEmailVerification: vi.fn(), requestEmailVerification: vi.fn(), revokeOwnSession: vi.fn() }));
vi.mock("@/lib/identity/invitations", () => ({ createHouseholdInvitation: vi.fn(), revokeHouseholdInvitation: vi.fn(), getInvitationPreview: harness.preview, startInvitedRegistration: vi.fn(), completeInvitedRegistration: harness.complete, acceptInvitation: harness.complete }));
vi.mock("@/lib/identity/households", () => ({ getHouseholdManagement: harness.management, leaveHousehold: vi.fn(), removeHouseholdMember: vi.fn(), transferHouseholdOwnership: vi.fn() }));
vi.mock("@/lib/identity/shared", () => ({ IdentityError: class IdentityError extends Error { constructor(public code: string) { super(code); } } }));
vi.mock("@/lib/i18n-server", () => ({ getServerLocale: harness.locale }));
vi.mock("@/lib/ops/config", () => ({ isOpsAdminInstance: () => false }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); }, useRouter: () => ({ replace: vi.fn(), refresh: vi.fn() }), usePathname: () => "/account" }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("next/server", () => ({ after: vi.fn() }));
vi.mock("next/headers", () => ({ headers: async () => new Headers({ "x-nonce": "fixture-document-nonce" }) }));

import AccountPage from "@/app/account/page";
import HouseholdPage from "@/app/account/household/page";
import AccountLayout from "@/app/account/layout";
import AccountLinkPage from "@/app/(auth)/account-link/page";
import { IdentityError } from "@/lib/identity/shared";

const session = { id: "user", appSessionId: "current-session", email: "owner@example.test", name: "Owner" };
beforeEach(() => {
  vi.resetAllMocks();
  harness.locale.mockResolvedValue("zh-CN");
  harness.account.mockResolvedValue(session);
  harness.app.mockResolvedValue({ ...session, householdId: "household", memberId: "member", role: "OWNER" });
  harness.overview.mockResolvedValue({ email: session.email, displayName: "Owner", emailVerifiedAt: null, sessions: [{ id: "current-session", deviceLabel: "Browser", loginAt: new Date(), lastSeenAt: new Date(), expiresAt: new Date(), isCurrent: true }] });
});

describe("identity page boundaries", () => {
  it.each(["zh-CN", "en-US"] as const)("keeps all identity client labels losslessly serializable in %s", (locale) => {
    const messages = getMessages(locale);
    for (const labels of [messages.identity, messages.identityMail, messages.accountAccess]) {
      expect(JSON.parse(JSON.stringify(labels))).toEqual(labels);
      expect(structuredClone(labels)).toEqual(labels);
    }
    expect(Object.keys(messages.identity)).toEqual(Object.keys(getMessages(locale === "zh-CN" ? "en-US" : "zh-CN").identity));
  });

  it("does not preview or consume any credential in a GET-rendered account link page", async () => {
    const page = await AccountLinkPage();
    const elements = Children.toArray(page.props.children).filter(isValidElement) as ReactElement<{ labels?: unknown; nonce?: string; dangerouslySetInnerHTML?: { __html: string } }>[];
    expect(elements[0].type).toBe("script");
    expect(elements[0].props.nonce).toBe("fixture-document-nonce");
    expect(elements[0].props.dangerouslySetInnerHTML?.__html).toContain("history.replaceState");
    expect(structuredClone(elements[1].props.labels)).toEqual(elements[1].props.labels);
    expect(harness.preview).not.toHaveBeenCalled();
    expect(harness.complete).not.toHaveBeenCalled();
  });

  it("allows account-only sessions to view their own security settings and the invitation guide", async () => {
    const layout = renderToStaticMarkup(await AccountLayout({ children: await AccountPage() }));
    expect(layout).toContain("本人账号");
    expect(layout).toContain(session.email);
    expect(layout).toContain("当前会话");
    expect(layout).toContain('method="post"');
    expect(layout).toContain('name="currentPassword"');
    expect(layout).toContain('href="/account/household"');
    expect(harness.overview).toHaveBeenCalledWith(session);
    const household = renderToStaticMarkup(await HouseholdPage());
    expect(household).toContain("当前没有有效家庭身份");
    expect(household).toContain("需要有效邀请");
    expect(harness.management).not.toHaveBeenCalled();
  });

  it("redirects an expired account at the page boundary even when layouts render concurrently", async () => {
    harness.account.mockRejectedValue(new Error("Unauthorized"));
    await expect(AccountPage()).rejects.toThrow("REDIRECT:/login?reason=session-expired");
    await expect(HouseholdPage()).rejects.toThrow("REDIRECT:/login?reason=session-expired");
    await expect(AccountLayout({ children: null })).rejects.toThrow("REDIRECT:/login?reason=session-expired");
    expect(harness.overview).not.toHaveBeenCalled();
  });

  it("redirects if the session is revoked between account resolution and the security read", async () => {
    harness.overview.mockRejectedValue(new IdentityError("UNAUTHORIZED"));
    await expect(AccountPage()).rejects.toThrow("REDIRECT:/login?reason=session-expired");
  });

  it("retains historical names and exposes household administration only for the owner", async () => {
    harness.account.mockResolvedValue({ ...session, memberId: "member", householdId: "household" });
    const overview = { household: { id: "household", name: "Family" }, currentMemberId: "member", role: "OWNER", invitations: [], members: [{ id: "member", memberName: "Owner", role: "OWNER", joinedAt: new Date(), leftAt: null }, { id: "former", memberName: "Former partner", role: "MEMBER", joinedAt: new Date(), leftAt: new Date() }, { id: "active", memberName: "Current partner", role: "MEMBER", joinedAt: new Date(), leftAt: null }] };
    harness.management.mockResolvedValue(overview);
    const ownerMarkup = renderToStaticMarkup(await HouseholdPage());
    expect(ownerMarkup).toContain("Former partner");
    expect(ownerMarkup).toContain("已退出");
    expect(ownerMarkup).toContain("转让负责人 · Current partner");
    expect(ownerMarkup).not.toContain("转让负责人 · Former partner");
    expect(ownerMarkup).toContain("邀请家人");
    expect(ownerMarkup).not.toContain(session.email);
    harness.management.mockResolvedValue({ ...overview, role: "MEMBER" });
    const memberMarkup = renderToStaticMarkup(await HouseholdPage());
    expect(memberMarkup).not.toContain("发送邀请");
    expect(memberMarkup).not.toContain("移除成员 ·");
    expect(memberMarkup).not.toContain("转让负责人 ·");
    expect(memberMarkup).toContain("我确认退出当前家庭");
  });
});
