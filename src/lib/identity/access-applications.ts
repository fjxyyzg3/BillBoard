import { randomUUID } from "node:crypto";
import type { AccessApplication, Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { normalizeCredentialEmail } from "@/lib/auth/credentials";
import { parseLocale, type Locale } from "@/lib/i18n";
import { invitationTtlMs } from "./invitations";
import { sendIdentityEmail } from "./mail";
import { takeAccessApplicationMailLimit, takeAccessApplicationRequestLimit } from "./access-application-budget";
import { releaseIdentityMailLease, reservePublicApplicationMailLease } from "./mail-budget";
import { createIdentityToken, hashIdentityToken, IdentityError, takeIdentityRateLimit } from "./shared";

type Transaction = Prisma.TransactionClient;
type Decision = "APPROVED" | "REJECTED";
const transactionOptions = { maxWait: 5_000, timeout: 15_000 };
const confirmationLifetimeMs = 30 * 60_000;
const mailLeaseMs = 90_000;
const maximumPendingApplications = 1_000;
const maximumConfirmations = 1_000;

function normalizedEmail(value: string) {
  const email = normalizeCredentialEmail(value);
  if (!email || /[\r\n<>()\[\]:;,"\\]/.test(email)) throw new IdentityError("INVALID_INPUT");
  return email;
}

async function lockAdmission(tx: Transaction) {
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('billboard:access-applications', 0))::text`;
}

async function collectExpiredConfirmations(tx: Transaction, now: Date) {
  await tx.$executeRaw`
    DELETE FROM "AccessApplicationConfirmation" WHERE id IN (
      SELECT id FROM "AccessApplicationConfirmation" WHERE expires_at < ${new Date(now.getTime() - 86_400_000)}
      ORDER BY expires_at LIMIT 100 FOR UPDATE SKIP LOCKED
    )
  `;
}

export async function prepareAccessApplication(input: { email: string; locale?: Locale; note?: string | null }) {
  await takeAccessApplicationRequestLimit("request");
  const email = normalizedEmail(input.email);
  if (input.note != null && typeof input.note !== "string") throw new IdentityError("INVALID_INPUT");
  // Multipart form submissions expand textarea line endings to CRLF.
  const note = input.note?.replace(/\r\n?/g, "\n").trim() || null;
  if (note && note.length > 80) throw new IdentityError("APPLICATION_NOTE_TOO_LONG");
  const locale = parseLocale(input.locale);
  let delivery: Promise<{ accepted: true }> | undefined;
  return { deliver: () => delivery ??= deliverConfirmation(email, locale, note) };
}

export async function requestAccessApplication(input: { email: string; locale?: Locale; note?: string | null }) {
  return (await prepareAccessApplication(input)).deliver();
}

async function deliverConfirmation(email: string, locale: Locale, note: string | null): Promise<{ accepted: true }> {
  const credential = createIdentityToken();
  const prepared = await db.$transaction(async (tx) => {
    await lockAdmission(tx);
    const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
    await collectExpiredConfirmations(tx, now);
    if (await tx.accessApplication.findFirst({ where: { email, status: "PENDING" }, select: { id: true } })) return null;
    // Older versions gave unsent credentials a 30-minute lifetime; only recent attempts are in flight.
    if (await tx.accessApplicationConfirmation.findFirst({
      where: { email, sentAt: null, consumedAt: null, revokedAt: null,
        expiresAt: { gt: now }, createdAt: { gt: new Date(now.getTime() - mailLeaseMs) } },
      select: { id: true },
    })) return null;
    if (await tx.accessApplication.count({ where: { status: "PENDING" } }) >= maximumPendingApplications) throw new IdentityError("RATE_LIMITED");
    if (await tx.accessApplicationConfirmation.count({ where: { expiresAt: { gt: now }, consumedAt: null, revokedAt: null } }) >= maximumConfirmations) {
      throw new IdentityError("RATE_LIMITED");
    }
    await takeAccessApplicationMailLimit(tx, email, now);
    const lease = await reservePublicApplicationMailLease(tx, now);
    const confirmation = await tx.accessApplicationConfirmation.create({ data: {
      // An unsent credential expires with its in-flight reservation, including after a process crash.
      email, locale, note, tokenHash: credential.tokenHash, expiresAt: lease.expiresAt,
    } });
    return { confirmation, mailLeaseToken: lease.token };
  }, transactionOptions);
  if (!prepared) return { accepted: true };
  const { confirmation, mailLeaseToken } = prepared;
  try {
    await sendIdentityEmail({ kind: "application-confirmation", to: email, token: credential.token, locale }, { mailLeaseToken });
    await db.$transaction(async (tx) => {
      await lockAdmission(tx);
      const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      const current = await tx.accessApplicationConfirmation.findUnique({ where: { id: confirmation.id } });
      if (!current || current.revokedAt || current.consumedAt || current.expiresAt <= now) throw new IdentityError("APPLICATION_LINK_INVALID");
      if (await tx.accessApplication.findFirst({ where: { email, status: "PENDING" }, select: { id: true } })) {
        await tx.accessApplicationConfirmation.update({ where: { id: current.id }, data: { revokedAt: now } });
        return;
      }
      await tx.accessApplicationConfirmation.update({ where: { id: current.id }, data: { sentAt: now, expiresAt: new Date(now.getTime() + confirmationLifetimeMs) } });
      await tx.accessApplicationConfirmation.updateMany({
        where: { email, id: { not: current.id }, consumedAt: null, revokedAt: null }, data: { revokedAt: now },
      });
    }, transactionOptions);
  } catch {
    await db.accessApplicationConfirmation.updateMany({ where: { id: confirmation.id, consumedAt: null }, data: { revokedAt: new Date() } });
    throw new IdentityError("EMAIL_DELIVERY_FAILED");
  } finally {
    await releaseIdentityMailLease(mailLeaseToken);
  }
  return { accepted: true };
}

export async function confirmAccessApplication(token: string): Promise<{ status: "pending" }> {
  await takeAccessApplicationRequestLimit("confirmation");
  let tokenHash: string;
  try { tokenHash = hashIdentityToken(token); } catch { throw new IdentityError("APPLICATION_LINK_INVALID"); }
  return db.$transaction(async (tx) => {
    await lockAdmission(tx);
    const now = new Date();
    const confirmation = await tx.accessApplicationConfirmation.findUnique({ where: { tokenHash } });
    if (!confirmation || !confirmation.sentAt || confirmation.consumedAt || confirmation.revokedAt || confirmation.expiresAt <= now) {
      throw new IdentityError("APPLICATION_LINK_INVALID");
    }
    const existing = await tx.accessApplication.findFirst({ where: { email: confirmation.email, status: "PENDING" }, select: { id: true } });
    if (!existing) {
      if (await tx.accessApplication.count({ where: { status: "PENDING" } }) >= maximumPendingApplications) throw new IdentityError("RATE_LIMITED");
      await tx.accessApplication.create({ data: { email: confirmation.email, locale: confirmation.locale, note: confirmation.note, verifiedAt: now } });
    }
    await tx.accessApplicationConfirmation.update({ where: { id: confirmation.id }, data: { consumedAt: now } });
    // No older confirmation may open a fresh application after this one is decided.
    await tx.accessApplicationConfirmation.updateMany({
      where: { email: confirmation.email, id: { not: confirmation.id }, consumedAt: null, revokedAt: null }, data: { revokedAt: now },
    });
    return { status: "pending" as const };
  }, transactionOptions);
}

function result(row: Pick<AccessApplication, "status" | "mailStatus">) {
  return { status: row.status, mailStatus: row.mailStatus };
}

async function lockedApplication(tx: Transaction, id: string) {
  if (typeof id !== "string" || !id || id.length > 128) throw new IdentityError("INVALID_INPUT");
  await tx.$queryRaw`SELECT id FROM "AccessApplication" WHERE id = ${id} FOR UPDATE`;
  const row = await tx.accessApplication.findUnique({ where: { id } });
  if (!row) throw new IdentityError("APPLICATION_NOT_PENDING");
  return row;
}

type MailAttempt = {
  applicationId: string; decision: Decision; email: string; locale: Locale;
  attemptToken: string; invitationId?: string; token?: string;
};

async function prepareMailAttempt(tx: Transaction, row: AccessApplication, decision: Decision): Promise<MailAttempt> {
  const now = new Date();
  const attemptToken = randomUUID();
  let invitationId: string | undefined;
  let token: string | undefined;
  if (decision === "APPROVED") {
    // A retry replaces only this application's unused attempts, never manual invitations.
    await tx.invitation.updateMany({ where: { accessApplicationId: row.id, consumedAt: null, revokedAt: null }, data: { revokedAt: now } });
    const credential = createIdentityToken();
    const invitation = await tx.invitation.create({ data: {
      accessApplicationId: row.id, purpose: "PLATFORM", email: row.email,
      tokenHash: credential.tokenHash, expiresAt: new Date(now.getTime() + invitationTtlMs),
    } });
    await tx.identityAuditLog.create({ data: { action: "PLATFORM_INVITATION_CREATED", targetId: invitation.id } });
    invitationId = invitation.id;
    token = credential.token;
  }
  await tx.accessApplication.update({ where: { id: row.id }, data: {
    mailStatus: "SENDING", mailAttemptToken: attemptToken, mailLeaseExpiresAt: new Date(now.getTime() + mailLeaseMs), mailSentAt: null,
  } });
  return { applicationId: row.id, decision, email: row.email, locale: parseLocale(row.locale), attemptToken, invitationId, token };
}

async function sendApplicationOutcome(attempt: MailAttempt) {
  try {
    if (attempt.decision === "APPROVED") {
      await sendIdentityEmail({ kind: "invite", to: attempt.email, token: attempt.token!, locale: attempt.locale, invitationPurpose: "PLATFORM" });
    } else {
      await sendIdentityEmail({ kind: "application-rejected", to: attempt.email, locale: attempt.locale });
    }
    await db.$transaction(async (tx) => {
      const row = await lockedApplication(tx, attempt.applicationId);
      const now = new Date();
      if (row.mailStatus !== "SENDING" || row.mailAttemptToken !== attempt.attemptToken || !row.mailLeaseExpiresAt || row.mailLeaseExpiresAt <= now) {
        throw new IdentityError("APPLICATION_MAIL_BUSY");
      }
      if (attempt.invitationId) {
        const updated = await tx.invitation.updateMany({ where: {
          id: attempt.invitationId, accessApplicationId: row.id, email: row.email, purpose: "PLATFORM",
          sentAt: null, consumedAt: null, revokedAt: null, expiresAt: { gt: now },
        }, data: { sentAt: now } });
        if (updated.count !== 1) throw new IdentityError("INVITATION_INVALID");
      }
      await tx.accessApplication.update({ where: { id: row.id }, data: {
        mailStatus: "SENT", mailSentAt: now, mailAttemptToken: null, mailLeaseExpiresAt: null,
      } });
    }, transactionOptions);
  } catch {
    if (attempt.invitationId) await db.invitation.updateMany({ where: { id: attempt.invitationId, consumedAt: null }, data: { revokedAt: new Date() } });
    await db.accessApplication.updateMany({ where: {
      id: attempt.applicationId, mailStatus: "SENDING", mailAttemptToken: attempt.attemptToken,
    }, data: { mailStatus: "FAILED", mailAttemptToken: null, mailLeaseExpiresAt: null } });
  }
  return result(await db.accessApplication.findUniqueOrThrow({ where: { id: attempt.applicationId } }));
}

export async function decideAccessApplication(id: string, decision: Decision) {
  if (decision !== "APPROVED" && decision !== "REJECTED") throw new IdentityError("INVALID_INPUT");
  await takeIdentityRateLimit("application-ops", "ops-admin");
  const prepared = await db.$transaction(async (tx) => {
    const row = await lockedApplication(tx, id);
    if (row.status !== "PENDING") {
      if (row.status === decision) return { existing: result(row) };
      throw new IdentityError("APPLICATION_NOT_PENDING");
    }
    await tx.accessApplication.update({ where: { id: row.id }, data: { status: decision, decidedAt: new Date() } });
    await tx.opsAuditLog.create({ data: {
      action: decision === "APPROVED" ? "ACCESS_APPLICATION_APPROVED" : "ACCESS_APPLICATION_REJECTED",
      targetAccessApplicationId: row.id, operator: "ops-admin",
    } });
    return { attempt: await prepareMailAttempt(tx, row, decision) };
  }, transactionOptions);
  return prepared.attempt ? sendApplicationOutcome(prepared.attempt) : prepared.existing!;
}

export async function retryAccessApplicationMail(id: string) {
  await takeIdentityRateLimit("application-ops", "ops-admin");
  const prepared = await db.$transaction(async (tx) => {
    const row = await lockedApplication(tx, id);
    if (row.status === "PENDING") throw new IdentityError("APPLICATION_NOT_PENDING");
    if (row.mailStatus === "SENT") return { existing: result(row) };
    if (row.mailStatus === "SENDING" && row.mailLeaseExpiresAt && row.mailLeaseExpiresAt > new Date()) {
      throw new IdentityError("APPLICATION_MAIL_BUSY");
    }
    const attempt = await prepareMailAttempt(tx, row, row.status);
    await tx.opsAuditLog.create({ data: { action: "ACCESS_APPLICATION_MAIL_RETRIED", targetAccessApplicationId: row.id, operator: "ops-admin" } });
    return { attempt };
  }, transactionOptions);
  return prepared.attempt ? sendApplicationOutcome(prepared.attempt) : prepared.existing!;
}

export async function listAccessApplicationsForOps(page = 1) {
  if (!Number.isInteger(page) || page < 1 || page > 1_000) throw new IdentityError("INVALID_INPUT");
  const rows = await db.accessApplication.findMany({
    select: { id: true, email: true, note: true, locale: true, status: true, createdAt: true, verifiedAt: true,
      decidedAt: true, mailStatus: true, mailLeaseExpiresAt: true },
    orderBy: [{ decidedAt: { sort: "desc", nulls: "first" } }, { createdAt: "asc" }, { id: "asc" }],
    skip: (page - 1) * 100, take: 100,
  });
  const now = new Date();
  return rows.map(({ mailLeaseExpiresAt, ...row }) => ({ ...row,
    canRetry: row.status !== "PENDING" && (row.mailStatus === "FAILED" || (row.mailStatus === "SENDING" && (!mailLeaseExpiresAt || mailLeaseExpiresAt <= now))),
  }));
}
