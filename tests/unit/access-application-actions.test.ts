import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const harness = vi.hoisted(() => ({
  prepare: vi.fn(), deliver: vi.fn(), confirm: vi.fn(), list: vi.fn(), decide: vi.fn(), retry: vi.fn(),
  after: vi.fn(), revalidate: vi.fn(), opsInstance: vi.fn(), config: vi.fn(), verify: vi.fn(), cookies: vi.fn(),
}));
vi.mock("next/server", () => ({ after: harness.after }));
vi.mock("next/cache", () => ({ revalidatePath: harness.revalidate }));
vi.mock("next/headers", () => ({ cookies: harness.cookies }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
vi.mock("@/lib/ops/config", () => ({ isOpsAdminInstance: harness.opsInstance, getOpsAdminConfig: harness.config }));
vi.mock("@/lib/ops/auth", () => ({ opsAdminSessionCookieName: "ops-session", verifyOpsAdminSessionToken: harness.verify, createOpsAdminSessionToken: vi.fn(), verifyOpsAdminPassword: vi.fn() }));
vi.mock("@/lib/identity/access-applications", () => ({ prepareAccessApplication: harness.prepare, confirmAccessApplication: harness.confirm, listAccessApplicationsForOps: harness.list, decideAccessApplication: harness.decide, retryAccessApplicationMail: harness.retry }));
vi.mock("@/lib/identity/invitations", () => ({ createPlatformInvitation: vi.fn(), listPlatformInvitations: vi.fn(), revokePlatformInvitation: vi.fn() }));
vi.mock("@/lib/identity/shared", () => ({ IdentityError: class IdentityError extends Error { constructor(public code: string) { super(code); } }, revokeAccountTokens: vi.fn() }));
vi.mock("@/lib/db", () => ({ db: {} }));

import { confirmAccessApplicationAction, requestAccessApplicationAction } from "@/app/help/actions";
import { decideAccessApplicationAction, getAccessApplicationsForOps, retryAccessApplicationMailAction } from "@/app/ops/actions";
import { IdentityError } from "@/lib/identity/shared";

function form(fields: Record<string, string> = {}) {
  const result = new FormData();
  for (const [key, value] of Object.entries(fields)) result.set(key, value);
  return result;
}

beforeEach(() => {
  vi.resetAllMocks();
  vi.stubEnv("AUTH_SECRET", "unit-test-secret");
  harness.opsInstance.mockReturnValue(false);
  harness.prepare.mockResolvedValue({ deliver: harness.deliver });
  harness.deliver.mockResolvedValue({ accepted: true });
  harness.confirm.mockResolvedValue({ status: "pending" });
  harness.config.mockReturnValue({ enabled: true, instance: true, hasPasswordHash: true });
  harness.cookies.mockResolvedValue({ get: () => ({ value: "ops-cookie" }) });
  harness.verify.mockReturnValue(true);
  harness.list.mockResolvedValue([]);
  harness.decide.mockResolvedValue({ status: "APPROVED", mailStatus: "SENT" });
  harness.retry.mockResolvedValue({ status: "REJECTED", mailStatus: "SENT" });
});
afterEach(() => vi.unstubAllEnvs());

describe("public access application action boundaries", () => {
  it("accepts before eligibility or delivery work and forwards only public application fields", async () => {
    expect(await requestAccessApplicationAction(form({ email: "applicant@example.com", locale: "en-US", note: "Family friend", householdId: "forged", approved: "true" }))).toEqual({ ok: true, data: { message: "accepted" } });
    expect(harness.prepare).toHaveBeenCalledWith({ email: "applicant@example.com", locale: "en-US", note: "Family friend" });
    expect(harness.deliver).not.toHaveBeenCalled();
    expect(harness.after).toHaveBeenCalledTimes(1);
    await harness.after.mock.calls[0][0]();
    expect(harness.deliver).toHaveBeenCalledTimes(1);
  });

  it("keeps throttling and ineligible mail handling indistinguishable from acceptance", async () => {
    harness.prepare.mockRejectedValueOnce(new IdentityError("RATE_LIMITED"));
    expect(await requestAccessApplicationAction(form({ email: "applicant@example.com" }))).toEqual({ ok: true, data: { message: "accepted" } });
    expect(harness.after).not.toHaveBeenCalled();
    harness.deliver.mockRejectedValue(new Error("private delivery details"));
    expect(await requestAccessApplicationAction(form({ email: "applicant@example.com" }))).toEqual({ ok: true, data: { message: "accepted" } });
    await expect(harness.after.mock.calls[0][0]()).resolves.toBeUndefined();
  });

  it("returns input errors without exposing other preparation details", async () => {
    harness.prepare.mockRejectedValueOnce(new IdentityError("INVALID_INPUT"));
    expect(await requestAccessApplicationAction(form())).toEqual({ ok: false, code: "INVALID_INPUT" });
    harness.prepare.mockRejectedValueOnce(new Error("database credential"));
    expect(await requestAccessApplicationAction(form())).toEqual({ ok: false, code: "SERVICE_UNAVAILABLE" });
    harness.prepare.mockRejectedValueOnce(new IdentityError("ACCOUNT_EXISTS"));
    expect(await requestAccessApplicationAction(form())).toEqual({ ok: false, code: "SERVICE_UNAVAILABLE" });
    expect(harness.after).not.toHaveBeenCalled();
  });

  it("returns the note length error before scheduling delivery", async () => {
    harness.prepare.mockRejectedValueOnce(new IdentityError("APPLICATION_NOTE_TOO_LONG"));
    expect(await requestAccessApplicationAction(form({ email: "applicant@example.com", note: "说".repeat(81) }))).toEqual({ ok: false, code: "APPLICATION_NOTE_TOO_LONG" });
    expect(harness.after).not.toHaveBeenCalled();
  });

  it("rejects file values instead of coercing an uploaded note into text", async () => {
    const input = form({ email: "applicant@example.com" });
    input.set("note", new Blob(["unexpected upload"]), "note.txt");
    expect(await requestAccessApplicationAction(input)).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.after).not.toHaveBeenCalled();
  });

  it("confirms the request without asking the browser to sign out or register", async () => {
    expect(await confirmAccessApplicationAction("opaque-token")).toEqual({ ok: true, data: { message: "saved" } });
    expect(harness.confirm).toHaveBeenCalledWith("opaque-token");
    expect(harness.after).not.toHaveBeenCalled();
    harness.confirm.mockRejectedValueOnce(new IdentityError("APPLICATION_LINK_INVALID"));
    expect(await confirmAccessApplicationAction("expired-token")).toEqual({ ok: false, code: "APPLICATION_LINK_INVALID" });
    harness.confirm.mockRejectedValueOnce(new Error("private-token"));
    expect(await confirmAccessApplicationAction("opaque-token")).toEqual({ ok: false, code: "SERVICE_UNAVAILABLE" });
  });

  it("rejects every public action on the OPS instance before calling the service", async () => {
    harness.opsInstance.mockReturnValue(true);
    expect(await requestAccessApplicationAction(form({ email: "applicant@example.com" }))).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(await confirmAccessApplicationAction("opaque-token")).toEqual({ ok: false, code: "FORBIDDEN" });
    expect(harness.prepare).not.toHaveBeenCalled();
    expect(harness.confirm).not.toHaveBeenCalled();
    expect(harness.after).not.toHaveBeenCalled();
  });
});

describe("OPS access application action boundaries", () => {
  it.each(["missing-session", "public-instance", "disabled", "missing-password"])("guards list, decision, and retry independently for %s", async (condition) => {
    if (condition === "missing-session") harness.verify.mockReturnValue(false);
    if (condition === "public-instance") harness.config.mockReturnValue({ enabled: true, instance: false, hasPasswordHash: true });
    if (condition === "disabled") harness.config.mockReturnValue({ enabled: false, instance: true, hasPasswordHash: true });
    if (condition === "missing-password") harness.config.mockReturnValue({ enabled: true, instance: true, hasPasswordHash: false });
    await expect(getAccessApplicationsForOps()).rejects.toThrow("REDIRECT:/ops");
    await expect(decideAccessApplicationAction(form({ applicationId: "application", decision: "APPROVED" }))).rejects.toThrow("REDIRECT:/ops");
    await expect(retryAccessApplicationMailAction(form({ applicationId: "application" }))).rejects.toThrow("REDIRECT:/ops");
    expect(harness.list).not.toHaveBeenCalled();
    expect(harness.decide).not.toHaveBeenCalled();
    expect(harness.retry).not.toHaveBeenCalled();
  });

  it("forwards the requested page only after validating the OPS session", async () => {
    expect(await getAccessApplicationsForOps(3)).toEqual([]);
    expect(harness.list).toHaveBeenCalledWith(3);
    expect(harness.verify).toHaveBeenCalledWith("ops-cookie", "unit-test-secret");
  });

  it("validates the decision and does not trust a client email or household", async () => {
    expect(await decideAccessApplicationAction(form({ applicationId: "application", decision: "PENDING" }))).toEqual({ ok: false, code: "INVALID_INPUT" });
    expect(harness.decide).not.toHaveBeenCalled();
    expect(await decideAccessApplicationAction(form({ applicationId: "application", decision: "APPROVED", email: "forged@example.com", householdId: "forged" }))).toEqual({ ok: true, data: { status: "APPROVED", mailStatus: "SENT" } });
    expect(harness.decide).toHaveBeenCalledWith("application", "APPROVED");
    expect(harness.revalidate).toHaveBeenCalledWith("/ops");
  });

  it("preserves a saved decision when its email fails and retry cannot change it", async () => {
    harness.decide.mockResolvedValue({ status: "REJECTED", mailStatus: "FAILED", internalToken: "never-return" });
    expect(await decideAccessApplicationAction(form({ applicationId: "application", decision: "REJECTED" }))).toEqual({ ok: true, data: { status: "REJECTED", mailStatus: "FAILED" } });
    expect(await retryAccessApplicationMailAction(form({ applicationId: "application", decision: "APPROVED" }))).toEqual({ ok: true, data: { status: "REJECTED", mailStatus: "SENT" } });
    expect(harness.retry).toHaveBeenCalledWith("application");
    expect(harness.decide).toHaveBeenCalledTimes(1);
  });

  it("surfaces safe stale and busy states while hiding unexpected delivery details", async () => {
    harness.decide.mockRejectedValueOnce(new IdentityError("APPLICATION_NOT_PENDING"));
    expect(await decideAccessApplicationAction(form({ applicationId: "application", decision: "REJECTED" }))).toEqual({ ok: false, code: "APPLICATION_NOT_PENDING" });
    harness.retry.mockRejectedValueOnce(new IdentityError("APPLICATION_MAIL_BUSY"));
    expect(await retryAccessApplicationMailAction(form({ applicationId: "application" }))).toEqual({ ok: false, code: "APPLICATION_MAIL_BUSY" });
    harness.retry.mockRejectedValueOnce(new Error("smtp://private-password"));
    expect(await retryAccessApplicationMailAction(form({ applicationId: "application" }))).toEqual({ ok: false, code: "SERVICE_UNAVAILABLE" });
  });
});
