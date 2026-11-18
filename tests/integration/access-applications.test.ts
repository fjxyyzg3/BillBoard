import { randomUUID } from "node:crypto";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.loadEnvFile(".env.example");
const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/identity/mail", () => ({ sendIdentityEmail: sendEmail }));

let db: typeof import("@/lib/db").db;
let applications: typeof import("@/lib/identity/access-applications") | undefined;
let shared: typeof import("@/lib/identity/shared");
const emails: string[] = [];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) {
    throw new Error("Application tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  shared = await import("@/lib/identity/shared");
  const modulePath = "../../src/lib/identity/access-applications.ts";
  applications = await import(modulePath).catch(() => undefined);
});

beforeEach(async () => {
  sendEmail.mockReset();
  sendEmail.mockResolvedValue(undefined);
  await db.identityRateLimit.deleteMany();
});

afterEach(async () => {
  if (applications) {
    const rows = await db.accessApplication.findMany({ where: { email: { in: emails } }, select: { id: true } });
    await db.opsAuditLog.deleteMany({ where: { targetAccessApplicationId: { in: rows.map((row) => row.id) } } });
    await db.identityAuditLog.deleteMany({ where: { targetId: { in: (await db.invitation.findMany({ where: { email: { in: emails } }, select: { id: true } })).map((row) => row.id) } } });
    await db.invitation.deleteMany({ where: { email: { in: emails } } });
    await db.accessApplication.deleteMany({ where: { email: { in: emails } } });
    await db.accessApplicationConfirmation.deleteMany({ where: { email: { in: emails } } });
  }
  emails.length = 0;
});

afterAll(async () => { await db?.$disconnect(); });

function mailbox() {
  const email = `application-fixture-${randomUUID()}@example.com`;
  emails.push(email);
  return email;
}

async function pending(email = mailbox(), note?: string) {
  await applications!.requestAccessApplication({ email, locale: "en-US", note });
  const message = sendEmail.mock.calls.at(-1)![0];
  await applications!.confirmAccessApplication(message.token);
  return db.accessApplication.findFirstOrThrow({ where: { email, status: "PENDING" } });
}

describe("verified public access applications", () => {
  it("rejects notes longer than 80 characters before preparing mail or storing credentials", async () => {
    const input = { email: mailbox(), note: "说".repeat(81) };
    await expect(applications!.prepareAccessApplication(input)).rejects.toMatchObject({ code: "APPLICATION_NOTE_TOO_LONG" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await db.accessApplicationConfirmation.count({ where: { email: input.email } })).toBe(0);
    expect(await db.identityRateLimit.count({ where: { id: { startsWith: "public-application:mail:" } } })).toBe(0);
    expect(await db.identityMailLease.count()).toBe(0);
  });

  it("bounds note storage on both confirmation and application records", async () => {
    const email = mailbox();
    const note = "说".repeat(81);
    await expect(db.accessApplicationConfirmation.create({ data: {
      email, note, tokenHash: shared.createIdentityToken().tokenHash, expiresAt: new Date(Date.now() + 60_000),
    } })).rejects.toMatchObject({ code: "P2000" });
    await expect(db.accessApplication.create({ data: { email, note, verifiedAt: new Date() } })).rejects.toMatchObject({ code: "P2000" });
  });

  it.each([
    { note: undefined, expected: null },
    { note: "", expected: null },
    { note: " \n\t ", expected: null },
    { note: "  家庭朋友\n希望试用  ", expected: "家庭朋友\n希望试用" },
    { note: "说".repeat(80), expected: "说".repeat(80) },
    { note: "Multi\r\nline".padEnd(81, "x"), expected: "Multi\nline".padEnd(80, "x") },
  ])("preserves normalized optional notes through confirmation: $note", async ({ note, expected }) => {
    const input = { email: mailbox(), note };
    await applications!.requestAccessApplication(input);
    const confirmation = await db.accessApplicationConfirmation.findFirstOrThrow({ where: { email: input.email } });
    expect(confirmation).toMatchObject({ note: expected });
    expect(await applications!.listAccessApplicationsForOps()).not.toContainEqual(expect.objectContaining({ email: input.email }));
    const message = sendEmail.mock.calls[0]![0];
    expect(message).not.toHaveProperty("note");
    await applications!.confirmAccessApplication(message.token);
    const row = await db.accessApplication.findFirstOrThrow({ where: { email: input.email } });
    expect(row).toMatchObject({ note: expected });
    expect(await applications!.listAccessApplicationsForOps()).toContainEqual(expect.objectContaining({ id: row.id, note: expected }));
  });

  it("confirms a pre-upgrade link without a note", async () => {
    const credential = shared.createIdentityToken();
    const email = mailbox();
    await db.accessApplicationConfirmation.create({ data: {
      email, tokenHash: credential.tokenHash, sentAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    } });
    await applications!.confirmAccessApplication(credential.token);
    expect(await db.accessApplication.findFirstOrThrow({ where: { email } })).toMatchObject({ note: null, status: "PENDING" });
  });

  it("isolates public requests and confirmations from the normal identity budget", async () => {
    const email = mailbox();
    await applications!.requestAccessApplication({ email });
    await applications!.confirmAccessApplication(sendEmail.mock.calls[0]![0].token);
    expect(await db.identityRateLimit.findUnique({ where: { id: "global" } })).toBeNull();
  });

  it("coalesces independent in-flight requests for the same normalized mailbox", async () => {
    const email = mailbox();
    let begin!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const completed = new Promise<void>((resolve) => { finish = resolve; });
    sendEmail.mockImplementationOnce(async () => { begin(); await completed; });
    const first = await applications!.prepareAccessApplication({ email, note: "First applicant note" });
    const second = await applications!.prepareAccessApplication({ email: ` ${email.toUpperCase()} `, note: "Replacement note" });
    const delivery = first.deliver();
    // Retain the outcome immediately so the original implementation cannot leak a rejection.
    const firstOutcome = Promise.allSettled([delivery]);
    try {
      await started;
      expect(await second.deliver()).toEqual({ accepted: true });
      expect(await db.accessApplicationConfirmation.count({ where: { email } })).toBe(1);
      expect(sendEmail).toHaveBeenCalledTimes(1);
    } finally {
      finish();
      await firstOutcome;
    }
    expect(await db.accessApplicationConfirmation.findFirstOrThrow({ where: { email } })).toMatchObject({ note: "First applicant note" });
  });

  it("does not mistake an old unsent credential with a 30-minute lifetime for active delivery", async () => {
    const email = mailbox();
    const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    const legacy = await db.accessApplicationConfirmation.create({ data: {
      email, tokenHash: shared.createIdentityToken().tokenHash,
      createdAt: new Date(now.getTime() - 120_000), expiresAt: new Date(now.getTime() + 30 * 60_000),
    } });
    expect(await applications!.requestAccessApplication({ email })).toEqual({ accepted: true });
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await db.accessApplicationConfirmation.findUnique({ where: { id: legacy.id } })).toMatchObject({ revokedAt: expect.any(Date) });
  });

  it("requires mailbox confirmation before an application enters the OPS queue", async () => {
    const email = mailbox();
    expect(await applications?.requestAccessApplication({ email: `  ${email.toUpperCase()}  `, locale: "en-US" })).toEqual({ accepted: true });
    expect(await db.accessApplication.count({ where: { email } })).toBe(0);
    expect(await db.user.count({ where: { email } })).toBe(0);
    const message = sendEmail.mock.calls[0]![0];
    expect(message).toMatchObject({ kind: "application-confirmation", to: email, locale: "en-US" });
    const confirmation = await db.accessApplicationConfirmation.findFirstOrThrow({ where: { email } });
    expect(confirmation.tokenHash).toBe(shared.hashIdentityToken(message.token));
    expect(JSON.stringify(confirmation)).not.toContain(message.token);
    expect(await applications!.confirmAccessApplication(message.token)).toEqual({ status: "pending" });
    expect(await db.accessApplication.findFirst({ where: { email } })).toMatchObject({ email, status: "PENDING", verifiedAt: expect.any(Date) });
    expect(await db.user.count({ where: { email } })).toBe(0);
  });

  it("does not create or send another application while the mailbox has a pending one", async () => {
    const row = await pending(mailbox(), "Original note");
    await db.identityRateLimit.deleteMany();
    sendEmail.mockClear();
    await applications!.requestAccessApplication({ email: row.email.toUpperCase(), note: "Anonymous replacement" });
    expect(await db.accessApplication.count({ where: { email: row.email } })).toBe(1);
    expect(await db.accessApplication.findUniqueOrThrow({ where: { id: row.id } })).toMatchObject({ note: "Original note" });
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("enforces one pending application for concurrent confirmations and direct database writes", async () => {
    const email = mailbox();
    const first = shared.createIdentityToken();
    const second = shared.createIdentityToken();
    for (const credential of [first, second]) await db.accessApplicationConfirmation.create({ data: {
      email, locale: "zh-CN", tokenHash: credential.tokenHash, sentAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    } });
    const results = await Promise.allSettled([first, second].map(({ token }) => applications!.confirmAccessApplication(token)));
    expect(results.filter((entry) => entry.status === "fulfilled")).toEqual([{ status: "fulfilled", value: { status: "pending" } }]);
    expect(results.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { code: "APPLICATION_LINK_INVALID" } });
    expect(await db.accessApplication.count({ where: { email, status: "PENDING" } })).toBe(1);
    await expect(db.accessApplication.create({ data: { email, locale: "zh-CN", verifiedAt: new Date() } })).rejects.toMatchObject({ code: "P2002" });
    const row = await db.accessApplication.findFirstOrThrow({ where: { email, status: "PENDING" } });
    await applications!.decideAccessApplication(row.id, "REJECTED");
    for (const credential of [first, second]) await expect(applications!.confirmAccessApplication(credential.token)).rejects.toMatchObject({ code: "APPLICATION_LINK_INVALID" });
  });

  it("rejects malformed, expired, undelivered and replayed confirmation capabilities", async () => {
    await expect(applications!.confirmAccessApplication("not-a-token")).rejects.toMatchObject({ code: "APPLICATION_LINK_INVALID" });
    for (const state of ["expired", "unsent", "consumed", "revoked"] as const) {
      const credential = shared.createIdentityToken();
      await db.accessApplicationConfirmation.create({ data: {
        email: mailbox(), tokenHash: credential.tokenHash, expiresAt: new Date(Date.now() + (state === "expired" ? -1_000 : 60_000)),
        sentAt: state === "unsent" ? null : new Date(), consumedAt: state === "consumed" ? new Date() : null,
        revokedAt: state === "revoked" ? new Date() : null,
      } });
      await expect(applications!.confirmAccessApplication(credential.token)).rejects.toMatchObject({ code: "APPLICATION_LINK_INVALID" });
    }
  });

  it("keeps the last delivered confirmation valid when replacement delivery fails", async () => {
    const email = mailbox();
    await applications!.requestAccessApplication({ email, note: "Delivered note" });
    const first = sendEmail.mock.calls[0]![0].token;
    await db.identityRateLimit.deleteMany();
    sendEmail.mockRejectedValueOnce(new Error("Synthetic SMTP failure"));
    await expect(applications!.requestAccessApplication({ email, note: "Undelivered note" })).rejects.toBeInstanceOf(Error);
    await expect(applications!.confirmAccessApplication(sendEmail.mock.calls[1]![0].token)).rejects.toMatchObject({ code: "APPLICATION_LINK_INVALID" });
    await expect(applications!.confirmAccessApplication(first)).resolves.toEqual({ status: "pending" });
    expect(await db.accessApplication.findFirstOrThrow({ where: { email } })).toMatchObject({ note: "Delivered note" });
  });

  it("binds a replacement note to its own successfully delivered confirmation", async () => {
    const email = mailbox();
    await applications!.requestAccessApplication({ email, note: "Old note" });
    const first = sendEmail.mock.calls[0]![0].token;
    await db.identityRateLimit.deleteMany();
    await applications!.requestAccessApplication({ email, note: "New note" });
    await expect(applications!.confirmAccessApplication(first)).rejects.toMatchObject({ code: "APPLICATION_LINK_INVALID" });
    await applications!.confirmAccessApplication(sendEmail.mock.calls[1]![0].token);
    expect(await db.accessApplication.findFirstOrThrow({ where: { email } })).toMatchObject({ note: "New note" });
  });

  it("approves once, delivers a bound platform invitation and records an email-free OPS audit", async () => {
    const row = await pending(mailbox(), "Private applicant context");
    sendEmail.mockClear();
    expect(await applications!.decideAccessApplication(row.id, "APPROVED")).toMatchObject({ status: "APPROVED", mailStatus: "SENT" });
    const message = sendEmail.mock.calls[0]![0];
    expect(message).toMatchObject({ kind: "invite", to: row.email, invitationPurpose: "PLATFORM" });
    expect(JSON.stringify(sendEmail.mock.calls)).not.toContain(row.note!);
    expect(JSON.stringify(await db.opsAuditLog.findMany({ where: { targetAccessApplicationId: row.id } }))).not.toContain(row.note!);
    expect(await applications!.listAccessApplicationsForOps()).toContainEqual(expect.objectContaining({ id: row.id, status: "APPROVED", note: row.note }));
    const invitation = await db.invitation.findFirstOrThrow({ where: { accessApplicationId: row.id } });
    expect(invitation).toMatchObject({ email: row.email, purpose: "PLATFORM", householdId: null, createdByMemberId: null, sentAt: expect.any(Date) });
    expect(invitation.expiresAt.getTime() - invitation.createdAt.getTime()).toBeGreaterThan(6 * 86_400_000);
    const audit = await db.opsAuditLog.findMany({ where: { targetAccessApplicationId: row.id } });
    expect(audit).toHaveLength(1);
    expect(audit[0].action).toBe("ACCESS_APPLICATION_APPROVED");
    expect(JSON.stringify(audit)).not.toContain(row.email);
    expect(JSON.stringify(audit)).not.toContain(message.token);
    await applications!.decideAccessApplication(row.id, "APPROVED");
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await db.user.count({ where: { email: row.email } })).toBe(0);
  });

  it("serializes conflicting OPS decisions and sends only the winning outcome", async () => {
    const row = await pending();
    sendEmail.mockClear();
    const results = await Promise.allSettled([
      applications!.decideAccessApplication(row.id, "APPROVED"), applications!.decideAccessApplication(row.id, "REJECTED"),
    ]);
    expect(results.filter((result) => result.status === "fulfilled")).toHaveLength(1);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await db.opsAuditLog.count({ where: { targetAccessApplicationId: row.id } })).toBe(1);
  });

  it("rejects with a capability-free notice and allows a new verified application afterwards", async () => {
    const row = await pending();
    sendEmail.mockClear();
    expect(await applications!.decideAccessApplication(row.id, "REJECTED")).toMatchObject({ status: "REJECTED", mailStatus: "SENT" });
    expect(sendEmail.mock.calls[0]![0]).toEqual({ kind: "application-rejected", to: row.email, locale: "en-US" });
    expect(await db.invitation.count({ where: { accessApplicationId: row.id } })).toBe(0);
    await db.identityRateLimit.deleteMany();
    await pending(row.email);
    expect(await db.accessApplication.count({ where: { email: row.email } })).toBe(2);
  });

  it("retains approval on delivery failure, revokes its bearer and retries with a new invitation", async () => {
    const row = await pending();
    sendEmail.mockClear();
    sendEmail.mockRejectedValueOnce(new Error("Synthetic SMTP failure"));
    expect(await applications!.decideAccessApplication(row.id, "APPROVED")).toMatchObject({ status: "APPROVED", mailStatus: "FAILED" });
    const oldToken = sendEmail.mock.calls[0]![0].token;
    const invitations = await import("@/lib/identity/invitations");
    await expect(invitations.getInvitationPreview(oldToken)).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    expect(await applications!.retryAccessApplicationMail(row.id)).toMatchObject({ status: "APPROVED", mailStatus: "SENT" });
    const newToken = sendEmail.mock.calls[1]![0].token;
    expect(newToken).not.toBe(oldToken);
    expect(await invitations.getInvitationPreview(newToken)).toMatchObject({ purpose: "PLATFORM", email: row.email });
    expect(await db.invitation.count({ where: { accessApplicationId: row.id, revokedAt: null } })).toBe(1);
    expect(await db.opsAuditLog.count({ where: { targetAccessApplicationId: row.id, action: "ACCESS_APPLICATION_APPROVED" } })).toBe(1);
  });

  it("recovers an interrupted mail attempt and prevents concurrent duplicate retries", async () => {
    const row = await pending();
    await db.accessApplication.update({ where: { id: row.id }, data: {
      status: "REJECTED", decidedAt: new Date(), mailStatus: "SENDING", mailAttemptToken: randomUUID(), mailLeaseExpiresAt: new Date(Date.now() - 1_000),
    } });
    sendEmail.mockClear();
    const results = await Promise.allSettled([applications!.retryAccessApplicationMail(row.id), applications!.retryAccessApplicationMail(row.id)]);
    expect(results.some((result) => result.status === "fulfilled")).toBe(true);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    expect(await db.accessApplication.findUnique({ where: { id: row.id } })).toMatchObject({ mailStatus: "SENT" });
  });

  it("lists only confirmed applications with bounded safe DTOs", async () => {
    const row = await pending();
    await applications!.requestAccessApplication({ email: mailbox() });
    const result = await applications!.listAccessApplicationsForOps();
    expect(result.find((item) => item.id === row.id)).toMatchObject({ status: "PENDING", canRetry: false });
    expect(result.length).toBeLessThanOrEqual(100);
    expect(JSON.stringify(result)).not.toMatch(/tokenHash|mailAttemptToken|passwordHash/);
    expect(result.some((item) => item.email === emails[1])).toBe(false);
  });

  it("consumes a prepared delivery once and keeps confirmation credentials purpose-bound", async () => {
    const email = mailbox();
    const prepared = await applications!.prepareAccessApplication({ email });
    await Promise.all([prepared.deliver(), prepared.deliver()]);
    expect(sendEmail).toHaveBeenCalledTimes(1);
    const token = sendEmail.mock.calls[0]![0].token;
    const invitations = await import("@/lib/identity/invitations");
    await expect(invitations.getInvitationPreview(token)).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    const credential = shared.createIdentityToken();
    await db.invitation.create({ data: { email, purpose: "PLATFORM", tokenHash: credential.tokenHash, sentAt: new Date(), expiresAt: new Date(Date.now() + 60_000) } });
    await expect(applications!.confirmAccessApplication(credential.token)).rejects.toMatchObject({ code: "APPLICATION_LINK_INVALID" });
  });

  it("retains rejection and retries its notice without creating an invitation", async () => {
    const row = await pending();
    sendEmail.mockClear();
    sendEmail.mockRejectedValueOnce(new Error("Synthetic SMTP failure"));
    expect(await applications!.decideAccessApplication(row.id, "REJECTED")).toEqual({ status: "REJECTED", mailStatus: "FAILED" });
    expect(await applications!.retryAccessApplicationMail(row.id)).toEqual({ status: "REJECTED", mailStatus: "SENT" });
    expect(sendEmail.mock.calls.map(([message]) => message)).toEqual([
      { kind: "application-rejected", to: row.email, locale: "en-US" },
      { kind: "application-rejected", to: row.email, locale: "en-US" },
    ]);
    expect(await db.invitation.count({ where: { accessApplicationId: row.id } })).toBe(0);
    expect(await db.opsAuditLog.count({ where: { targetAccessApplicationId: row.id, action: "ACCESS_APPLICATION_REJECTED" } })).toBe(1);
  });

  it("fences a delayed sender after an interrupted attempt is replaced", async () => {
    const row = await pending();
    sendEmail.mockClear();
    let release!: () => void;
    let started!: () => void;
    const begun = new Promise<void>((resolve) => { started = resolve; });
    sendEmail.mockImplementationOnce(() => { started(); return new Promise<void>((resolve) => { release = resolve; }); });
    const first = applications!.decideAccessApplication(row.id, "APPROVED");
    await begun;
    try {
      await expect(applications!.retryAccessApplicationMail(row.id)).rejects.toMatchObject({ code: "APPLICATION_MAIL_BUSY" });
      expect(sendEmail).toHaveBeenCalledTimes(1);
      await db.accessApplication.update({ where: { id: row.id }, data: { mailLeaseExpiresAt: new Date(Date.now() - 1_000) } });
      expect(await applications!.retryAccessApplicationMail(row.id)).toEqual({ status: "APPROVED", mailStatus: "SENT" });
    } finally { release(); }
    expect(await first).toEqual({ status: "APPROVED", mailStatus: "SENT" });
    const invitations = await import("@/lib/identity/invitations");
    await expect(invitations.getInvitationPreview(sendEmail.mock.calls[0]![0].token)).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    await expect(invitations.getInvitationPreview(sendEmail.mock.calls[1]![0].token)).resolves.toMatchObject({ purpose: "PLATFORM", email: row.email });
    expect(await db.invitation.count({ where: { accessApplicationId: row.id, revokedAt: null } })).toBe(1);
  });

  it("bounds confirmation capacity before another email or row is created", async () => {
    const email = mailbox();
    await db.accessApplicationConfirmation.createMany({ data: Array.from({ length: 1_000 }, () => ({
      email, tokenHash: shared.createIdentityToken().tokenHash, expiresAt: new Date(Date.now() + 60_000),
    })) });
    await expect(applications!.requestAccessApplication({ email: mailbox() })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await db.accessApplicationConfirmation.count({ where: { email: { in: emails } } })).toBe(1_000);
  });

  it("bounds pending capacity without consuming a valid confirmation", async () => {
    await db.accessApplication.createMany({ data: Array.from({ length: 1_000 }, () => ({ email: mailbox(), verifiedAt: new Date() })) });
    const email = mailbox();
    const credential = shared.createIdentityToken();
    const confirmation = await db.accessApplicationConfirmation.create({ data: {
      email, tokenHash: credential.tokenHash, sentAt: new Date(), expiresAt: new Date(Date.now() + 60_000),
    } });
    await expect(applications!.confirmAccessApplication(credential.token)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await db.accessApplicationConfirmation.findUnique({ where: { id: confirmation.id } })).toMatchObject({ consumedAt: null });
    expect(await db.accessApplication.count({ where: { email } })).toBe(0);
  });

  it("refuses new mail before creating a credential when the review queue is full", async () => {
    await db.accessApplication.createMany({ data: Array.from({ length: 1_000 }, () => ({ email: mailbox(), verifiedAt: new Date() })) });
    const email = mailbox();
    await expect(applications!.requestAccessApplication({ email })).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await db.accessApplicationConfirmation.count({ where: { email } })).toBe(0);
    expect(await db.identityRateLimit.count({ where: { id: { startsWith: "public-application:mail:" } } })).toBe(0);
    expect(await db.identityMailLease.count()).toBe(0);
    expect(sendEmail).not.toHaveBeenCalled();
  });

  it("uses a shared mailbox request limit before queuing any mail work", async () => {
    const email = mailbox();
    const results = await Promise.allSettled(Array.from({ length: 31 }, () => applications!.prepareAccessApplication({ email })));
    expect(results.filter((entry) => entry.status === "rejected").map((entry) => entry.reason.code)).toEqual(["RATE_LIMITED"]);
    expect(results.filter((entry) => entry.status === "fulfilled")).toHaveLength(30);
    expect(results.find((entry) => entry.status === "rejected")).toMatchObject({ reason: { code: "RATE_LIMITED" } });
    expect(sendEmail).not.toHaveBeenCalled();
    expect(await db.accessApplicationConfirmation.count({ where: { email } })).toBe(0);
  });
});
