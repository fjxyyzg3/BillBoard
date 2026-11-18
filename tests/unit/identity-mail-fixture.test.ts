import { createTransport } from "smtp-mailer";
import { expect, it } from "vitest";
import { getCapturedIdentityMail, startMailFixture } from "../e2e/mail-fixture";

it("captures a real authenticated SMTP envelope through a secret-protected loopback reader", async () => {
  const stop = await startMailFixture();
  try {
    const transport = createTransport({ host: "127.0.0.1", port: Number(process.env.SMTP_PORT), secure: false, ignoreTLS: true, auth: { user: "sender@example.com", pass: "test-fixture-only" } });
    await transport.sendMail({ from: "sender@example.com", to: "fixture@example.test", subject: "Fixture", text: "验证邮箱\nhttp://127.0.0.1:2500/account-link#kind=verify&token=synthetic" });
    expect(await getCapturedIdentityMail("fixture@example.test")).toEqual([{ to: "fixture@example.test", text: expect.stringContaining("验证邮箱\nhttp://127.0.0.1:2500/account-link#kind=verify&token=synthetic") }]);
    expect(await getCapturedIdentityMail("another@example.test")).toEqual([]);
    expect((await fetch(`${process.env.E2E_MAIL_FIXTURE_URL}/messages?to=fixture@example.test`)).status).toBe(401);
  } finally { await stop(); }
});
