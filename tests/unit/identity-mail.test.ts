import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

const { sendMail, createTransport, takeRateLimit } = vi.hoisted(() => ({
  sendMail: vi.fn(), createTransport: vi.fn(), takeRateLimit: vi.fn(),
}));
vi.mock("smtp-mailer", () => ({ createTransport }));
vi.mock("@/lib/identity/mail-budget", () => ({ withIdentityMailLease: (work: () => Promise<unknown>) => work() }));
vi.mock("@/lib/identity/shared", async (original) => ({
  ...await original<typeof import("@/lib/identity/shared")>(), takeIdentityRateLimit: takeRateLimit,
}));

import { sendIdentityEmail } from "@/lib/identity/mail";
import { getMessages } from "@/lib/i18n";

const token = "a".repeat(43);
beforeEach(() => {
  vi.stubEnv("APP_PUBLIC_ORIGIN", "https://app.example.com");
  vi.stubEnv("SMTP_HOST", "smtp.example.com");
  vi.stubEnv("SMTP_PORT", "465");
  vi.stubEnv("SMTP_SECURE", "true");
  vi.stubEnv("SMTP_USER", "sender@example.com");
  vi.stubEnv("SMTP_PASSWORD", "test-transport-credential");
  vi.stubEnv("SMTP_FROM_EMAIL", "sender@example.com");
  createTransport.mockReturnValue({ sendMail, close: vi.fn() });
  sendMail.mockResolvedValue({ accepted: ["recipient@example.com"], rejected: [] });
  takeRateLimit.mockResolvedValue(undefined);
});
afterEach(() => { vi.unstubAllEnvs(); vi.clearAllMocks(); });

describe("identity SMTP boundary", () => {
  it.each(["zh-CN", "en-US"] as const)("delivers an application confirmation with a purpose-bound fragment and a 30-minute expiry in %s", async (locale) => {
    await sendIdentityEmail({ to: " Applicant@Example.com ", kind: "application-confirmation", token, locale }, { mailLeaseToken: "reserved-public-slot" });
    const message = sendMail.mock.calls[0][0];
    const link = new URL(message.text.match(/https:\/\/\S+/)[0]);
    expect(link.origin).toBe("https://app.example.com");
    expect(link.pathname).toBe("/account-link");
    expect(link.search).toBe("");
    expect(Object.fromEntries(new URLSearchParams(link.hash.slice(1)))).toEqual({ kind: "application", token });
    expect(message.to).toEqual({ address: "applicant@example.com", name: "" });
    const messages = getMessages(locale).identityMail;
    expect(message.subject).toBe(messages.subjectApplicationConfirmation);
    expect(message.subject.length).toBeGreaterThan(0);
    expect(message.text).toContain(messages.applicationConfirmation);
    expect(message.text).toContain(messages.applicationConfirmationExpiry);
    expect(messages.applicationConfirmationExpiry).toContain("30");
    expect(message.text).not.toContain("undefined");
    expect(takeRateLimit).not.toHaveBeenCalled();
  });

  it.each(["zh-CN", "en-US"] as const)("delivers a brief application rejection without any bearer credential or capability link in %s", async (locale) => {
    await sendIdentityEmail({ to: "applicant@example.com", kind: "application-rejected", locale });
    const message = sendMail.mock.calls[0][0];
    const messages = getMessages(locale).identityMail;
    expect(message.subject).toBe(messages.subjectApplicationRejected);
    expect(message.subject.length).toBeGreaterThan(0);
    expect(message.text).toBe(messages.applicationRejected);
    expect(message.text.length).toBeGreaterThan(0);
    expect(message.text).not.toMatch(/https?:\/\/|\/account-link|token=/);
    expect(message.text).not.toContain(token);
    expect(message.text).not.toContain("undefined");
  });

  it("refuses an invalid application confirmation credential before delivery", async () => {
    await expect(sendIdentityEmail({ to: "applicant@example.com", kind: "application-confirmation", token: "invalid" })).rejects.toMatchObject({ code: "INVALID_TOKEN" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("requires a reserved public slot before an application confirmation can be sent", async () => {
    await expect(sendIdentityEmail({ to: "applicant@example.com", kind: "application-confirmation", token })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(sendMail).not.toHaveBeenCalled();
    expect(takeRateLimit).not.toHaveBeenCalled();
  });

  it("does not reuse a public reservation to bypass ordinary identity mail admission", async () => {
    await expect(sendIdentityEmail({ to: "applicant@example.com", kind: "reset", token }, { mailLeaseToken: "reserved-public-slot" })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(sendMail).not.toHaveBeenCalled();
    expect(takeRateLimit).not.toHaveBeenCalled();
  });

  it("delivers only a server-bound recipient and a fragment link on the configured origin", async () => {
    await sendIdentityEmail({ to: "recipient@example.com", kind: "reset", token });
    const message = sendMail.mock.calls[0][0];
    expect(message.to).toEqual({ address: "recipient@example.com", name: "" });
    expect(message.from).toEqual({ address: "sender@example.com", name: "BillBoard" });
    const link = new URL(message.text.match(/https:\/\/\S+/)[0]);
    expect(link.origin).toBe("https://app.example.com");
    expect(link.pathname).toBe("/account-link");
    expect(link.search).toBe("");
    expect(new URLSearchParams(link.hash.slice(1)).get("token")).toBe(token);
    expect(new URLSearchParams(link.hash.slice(1)).get("kind")).toBe("reset");
    expect(message.text).not.toContain("test-transport-credential");
    expect(takeRateLimit).toHaveBeenCalledWith("mail", "recipient@example.com");
    expect(createTransport.mock.calls[0][0]).toMatchObject({ secure: true, logger: false, debug: false, disableFileAccess: true, disableUrlAccess: true });
  });

  it.each(["http://app.example.com", "https://user:password@app.example.com", "https://app.example.com/base", "https://app.example.com?returnTo=elsewhere", "https://app.example.com/#secret"])("refuses unsafe trusted origin %s before delivery", async (origin) => {
    vi.stubEnv("APP_PUBLIC_ORIGIN", origin);
    await expect(sendIdentityEmail({ to: "recipient@example.com", kind: "verify", token })).rejects.toMatchObject({ code: "EMAIL_DELIVERY_FAILED" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("does not expose SMTP credentials or provider errors to a caller", async () => {
    sendMail.mockRejectedValue(new Error("Provider rejected test-transport-credential and recipient@example.com"));
    const error = await sendIdentityEmail({ to: "recipient@example.com", kind: "invite", token }).catch((value: unknown) => value);
    expect(error).toMatchObject({ code: "EMAIL_DELIVERY_FAILED", message: "EMAIL_DELIVERY_FAILED" });
    expect(String(error)).not.toContain("test-transport-credential");
  });

  it("treats partial or refused delivery as failure", async () => {
    sendMail.mockResolvedValue({ accepted: [], rejected: ["recipient@example.com"] });
    await expect(sendIdentityEmail({ to: "recipient@example.com", kind: "registration", token })).rejects.toMatchObject({ code: "EMAIL_DELIVERY_FAILED" });
  });

  it.each(["recipient@example.com,other@example.com", "recipient@example.com\r\nBcc: other@example.com", "A <recipient@example.com>"])("rejects address lists and headers: %s", async (to) => {
    await expect(sendIdentityEmail({ to, kind: "verify", token })).rejects.toMatchObject({ code: "INVALID_INPUT" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("requires encrypted authenticated SMTP in production, including a loopback host", async () => {
    vi.stubEnv("NODE_ENV", "production");
    vi.stubEnv("SMTP_HOST", "127.0.0.1");
    vi.stubEnv("SMTP_PORT", "25252");
    vi.stubEnv("SMTP_SECURE", "false");
    await sendIdentityEmail({ to: "recipient@example.com", kind: "verify", token });
    expect(createTransport.mock.calls[0][0]).toMatchObject({ requireTLS: true, ignoreTLS: false, tls: { rejectUnauthorized: true } });
  });

  it("does not attempt a send without complete private config", async () => {
    vi.stubEnv("SMTP_PASSWORD", "");
    await expect(sendIdentityEmail({ to: "recipient@example.com", kind: "verify", token })).rejects.toMatchObject({ code: "EMAIL_DELIVERY_FAILED" });
    expect(sendMail).not.toHaveBeenCalled();
  });

  it("closes a stalled provider connection at the absolute delivery deadline", async () => {
    vi.useFakeTimers();
    try {
      sendMail.mockImplementation(() => new Promise(() => undefined));
      const pending = sendIdentityEmail({ to: "recipient@example.com", kind: "verify", token });
      const rejected = expect(pending).rejects.toMatchObject({ code: "EMAIL_DELIVERY_FAILED" });
      await vi.advanceTimersByTimeAsync(25_000);
      await rejected;
      expect(createTransport.mock.results[0].value.close).toHaveBeenCalled();
    } finally { vi.useRealTimers(); }
  });
});
