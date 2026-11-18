import { randomUUID } from "node:crypto";
import { hash, verify } from "argon2";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.loadEnvFile(".env.example");

const { sendEmail } = vi.hoisted(() => ({ sendEmail: vi.fn() }));
vi.mock("@/lib/identity/mail", () => ({ sendIdentityEmail: sendEmail }));

let db: typeof import("@/lib/db").db;
let invitations: typeof import("@/lib/identity/invitations");
let shared: typeof import("@/lib/identity/shared");
let passwordHash: string;
const password = "Synthetic-registration-password-42";
const householdIds: string[] = [];
const userIds: string[] = [];
const invitationIds: string[] = [];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(dev|test)$/.test(url.pathname)) {
    throw new Error("Invitation tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  shared = await import("@/lib/identity/shared");
  invitations = await import("@/lib/identity/invitations");
  passwordHash = await hash(password);
});

beforeEach(async () => {
  sendEmail.mockReset(); sendEmail.mockResolvedValue(undefined);
  await db.loginBudget.upsert({ where: { id: 1 }, create: { id: 1, tokens: 10, refilledAt: new Date() }, update: { tokens: 10, refilledAt: new Date() } });
});
afterEach(async () => {
  const rows = await db.invitation.findMany({ where: { id: { in: invitationIds } }, select: { email: true } });
  const createdUsers = await db.user.findMany({ where: { email: { in: rows.map(({ email }) => email) } }, select: { id: true } });
  userIds.push(...createdUsers.map(({ id }) => id));
  const members = await db.householdMember.findMany({ where: { userId: { in: userIds }, role: "OWNER" }, select: { householdId: true } });
  householdIds.push(...members.map(({ householdId }) => householdId));
  await db.accountToken.deleteMany({ where: { OR: [{ invitationId: { in: invitationIds } }, { userId: { in: userIds } }] } });
  await db.invitation.deleteMany({ where: { OR: [{ id: { in: invitationIds } }, { householdId: { in: householdIds } }] } });
  await db.identityAuditLog.deleteMany({ where: { OR: [
    { householdId: { in: householdIds } }, { actorUserId: { in: userIds } }, { targetId: { in: invitationIds } },
  ] } });
  await db.household.deleteMany({ where: { id: { in: householdIds.splice(0) } } });
  await db.user.deleteMany({ where: { id: { in: userIds.splice(0) } } });
  invitationIds.length = 0;
});
afterAll(async () => { await db?.$disconnect(); });

async function account(email = `identity-account-${randomUUID()}@example.com`, verified = true) {
  const user = await db.user.create({ data: {
    email, displayName: "Invited account", passwordHash, emailVerifiedAt: verified ? new Date() : null,
  } });
  userIds.push(user.id);
  const session = await db.appSession.create({ data: { userId: user.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000) } });
  return { user, session: { id: user.id, appSessionId: session.id, email: user.email, name: user.displayName } };
}

async function household() {
  const owner = await account();
  const family = await db.household.create({ data: { name: "Invitation fixture" } });
  householdIds.push(family.id);
  await db.ledger.create({ data: { householdId: family.id, name: "Default", isDefault: true } });
  const member = await db.householdMember.create({ data: {
    householdId: family.id, userId: owner.user.id, memberName: "Owner", role: "OWNER",
  } });
  await db.appSession.update({ where: { id: owner.session.appSessionId }, data: { memberId: member.id } });
  return { family, member, user: owner.user, session: { ...owner.session, householdId: family.id, memberId: member.id, role: "OWNER" as const } };
}

async function invitation(purpose: "PLATFORM" | "HOUSEHOLD" = "PLATFORM", email = `identity-invite-${randomUUID()}@example.com`) {
  const issuer = purpose === "HOUSEHOLD" ? await household() : null;
  const credential = shared.createIdentityToken();
  const row = await db.invitation.create({ data: {
    purpose, email, tokenHash: credential.tokenHash, expiresAt: new Date(Date.now() + 60_000), sentAt: new Date(),
    householdId: issuer?.family.id, createdByMemberId: issuer?.member.id,
  } });
  invitationIds.push(row.id);
  return { ...credential, row, issuer };
}

describe("invitation lifecycle", () => {
  it("uses the same invitation error for malformed and unknown bearer values", async () => {
    await expect(invitations.getInvitationPreview("a".repeat(44))).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    await expect(invitations.getInvitationPreview("a".repeat(43))).rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });

  it("sends platform invitations without returning or persisting the bearer secret", async () => {
    const email = `identity-platform-${randomUUID()}@example.com`;
    const result = await invitations.createPlatformInvitation({ email });
    invitationIds.push(result.id);
    expect(result).toMatchObject({ purpose: "PLATFORM", email, sentAt: expect.any(Date), consumedAt: null });
    expect(JSON.stringify(result)).not.toContain("token");
    const delivered = sendEmail.mock.calls[0]![0];
    const stored = await db.invitation.findUniqueOrThrow({ where: { id: result.id } });
    expect(stored.tokenHash).toBe(shared.hashIdentityToken(delivered.token));
    expect(JSON.stringify(stored)).not.toContain(delivered.token);
    expect(await invitations.getInvitationPreview(delivered.token)).toMatchObject({ purpose: "PLATFORM", email, householdName: null });
  });

  it("does not leave a usable invitation when delivery fails", async () => {
    const email = `identity-undelivered-${randomUUID()}@example.com`;
    sendEmail.mockRejectedValueOnce(new Error("Synthetic delivery failure"));
    await expect(invitations.createPlatformInvitation({ email })).rejects.toBeInstanceOf(Error);
    const stored = await db.invitation.findFirstOrThrow({ where: { email } });
    invitationIds.push(stored.id);
    expect(stored).toMatchObject({ consumedAt: null, sentAt: null, revokedAt: expect.any(Date) });
    await expect(invitations.getInvitationPreview(sendEmail.mock.calls[0]![0].token)).rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });

  it.each(["PLATFORM", "HOUSEHOLD"] as const)("verifies an invited %s registration once and keeps its purpose and target", async (purpose) => {
    const current = await invitation(purpose);
    await expect(invitations.startInvitedRegistration(current.token, {
      displayName: "New account", memberName: "New member", householdName: "Independent family", password,
    })).resolves.toEqual({ status: "sent" });
    const delivered = sendEmail.mock.calls[0]![0];
    expect(delivered).toMatchObject({ kind: "registration", to: current.row.email });
    expect((await db.invitation.findUniqueOrThrow({ where: { id: current.row.id } })).consumedAt).toBeNull();
    expect(await db.user.count({ where: { email: current.row.email } })).toBe(0);
    const result = await invitations.completeInvitedRegistration(delivered.token);
    const user = await db.user.findUniqueOrThrow({ where: { email: current.row.email } });
    expect(await verify(user.passwordHash, password)).toBe(true);
    expect(user.emailVerifiedAt).toBeInstanceOf(Date);
    const member = await db.householdMember.findUniqueOrThrow({ where: { id: result.memberId } });
    expect(member.role).toBe(purpose === "PLATFORM" ? "OWNER" : "MEMBER");
    expect(member.userId).toBe(user.id);
    expect(member.householdId).toBe(purpose === "PLATFORM" ? result.householdId : current.issuer!.family.id);
    if (purpose === "PLATFORM") expect(await db.ledger.count({ where: { householdId: result.householdId, isDefault: true } })).toBe(1);
    await expect(invitations.completeInvitedRegistration(delivered.token)).rejects.toMatchObject({ code: "REGISTRATION_INVALID" });
    expect(await db.householdMember.count({ where: { userId: user.id } })).toBe(1);
  });

  it("lets an existing verified account build a new family without replacing its credentials or upgrading its old session", async () => {
    const existing = await account();
    const current = await invitation("PLATFORM", existing.user.email);
    const result = await invitations.acceptInvitation(existing.session, current.token, { memberName: "Existing", householdName: "New family" });
    expect(result.status).toBe("completed");
    expect(await db.user.findUniqueOrThrow({ where: { id: existing.user.id } })).toMatchObject({ passwordHash: existing.user.passwordHash });
    expect(await db.appSession.findUniqueOrThrow({ where: { id: existing.session.appSessionId } }))
      .toMatchObject({ memberId: null, revokedAt: expect.any(Date) });
    expect(await db.householdMember.count({ where: { userId: existing.user.id, leftAt: null } })).toBe(1);
    await expect(invitations.acceptInvitation(existing.session, current.token, { memberName: "Again", householdName: "Again" })).rejects.toBeInstanceOf(Error);
  });

  it("allows only one concurrent consumption of a household registration token", async () => {
    const current = await invitation("HOUSEHOLD");
    await invitations.startInvitedRegistration(current.token, { displayName: "New account", memberName: "New member", password });
    const token = sendEmail.mock.calls[0]![0].token;
    const results = await Promise.allSettled([
      invitations.completeInvitedRegistration(token), invitations.completeInvitedRegistration(token),
    ]);
    expect(results.filter(({ status }) => status === "fulfilled")).toHaveLength(1);
    const user = await db.user.findUniqueOrThrow({ where: { email: current.row.email } });
    expect(await db.householdMember.count({ where: { userId: user.id } })).toBe(1);
  });

  it("rejects a registration whose invitation was revoked after the verification email was sent", async () => {
    const current = await invitation("HOUSEHOLD");
    await invitations.startInvitedRegistration(current.token, { displayName: "New account", memberName: "New member", password });
    await db.invitation.update({ where: { id: current.row.id }, data: { revokedAt: new Date() } });
    await expect(invitations.completeInvitedRegistration(sendEmail.mock.calls[0]![0].token)).rejects.toMatchObject({ code: "REGISTRATION_INVALID" });
    expect(await db.user.count({ where: { email: current.row.email } })).toBe(0);
  });

  it("keeps the last delivered registration link usable when a replacement email fails", async () => {
    const current = await invitation("HOUSEHOLD");
    const input = { displayName: "New account", memberName: "New member", password };
    await invitations.startInvitedRegistration(current.token, input);
    const originalToken = sendEmail.mock.calls[0]![0].token;
    sendEmail.mockRejectedValueOnce(new Error("Synthetic replacement delivery failure"));
    await expect(invitations.startInvitedRegistration(current.token, input)).rejects.toBeInstanceOf(Error);
    expect(await db.accountToken.findUniqueOrThrow({ where: { tokenHash: shared.hashIdentityToken(originalToken) } }))
      .toMatchObject({ revokedAt: null, consumedAt: null, sentAt: expect.any(Date) });
    await expect(invitations.completeInvitedRegistration(originalToken)).resolves.toMatchObject({ status: "completed" });
  });

  it.each(["expired", "revoked", "consumed", "unsent", "issuer-locked", "closed"] as const)(
    "does not preview or consume an invitation that is %s", async (reason) => {
      const current = await invitation("HOUSEHOLD");
      if (reason === "issuer-locked") await db.user.update({ where: { id: current.issuer!.user.id }, data: { status: "LOCKED" } });
      else if (reason === "closed") await db.household.update({ where: { id: current.issuer!.family.id }, data: { closedAt: new Date() } });
      else await db.invitation.update({ where: { id: current.row.id }, data: {
        ...(reason === "expired" ? { expiresAt: new Date(Date.now() - 1) } : {}),
        ...(reason === "revoked" ? { revokedAt: new Date() } : {}),
        ...(reason === "consumed" ? { consumedAt: new Date() } : {}),
        ...(reason === "unsent" ? { sentAt: null } : {}),
      } });
      await expect(invitations.getInvitationPreview(current.token)).rejects.toMatchObject({ code: "INVITATION_INVALID" });
      await expect(invitations.startInvitedRegistration(current.token, {
        displayName: "New account", memberName: "New member", password,
      })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
      expect(await db.user.count({ where: { email: current.row.email } })).toBe(0);
      expect(await db.accountToken.count({ where: { invitationId: current.row.id } })).toBe(0);
    },
  );

  it("keeps invitation and registration credentials bound to their separate purposes", async () => {
    const current = await invitation("HOUSEHOLD");
    await invitations.startInvitedRegistration(current.token, { displayName: "New account", memberName: "New member", password });
    const registrationToken = sendEmail.mock.calls[0]![0].token;
    await expect(invitations.completeInvitedRegistration(current.token)).rejects.toMatchObject({ code: "REGISTRATION_INVALID" });
    await expect(invitations.getInvitationPreview(registrationToken)).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    expect((await db.invitation.findUniqueOrThrow({ where: { id: current.row.id } })).consumedAt).toBeNull();
    await expect(invitations.completeInvitedRegistration(registrationToken)).resolves.toMatchObject({ status: "completed" });
  });

  it("does not report an invitation as usable if its issuer loses eligibility during delivery", async () => {
    const issuer = await household();
    const email = `identity-invalidated-${randomUUID()}@example.com`;
    sendEmail.mockImplementationOnce(async () => {
      await db.user.update({ where: { id: issuer.user.id }, data: { status: "LOCKED" } });
    });
    await expect(invitations.createHouseholdInvitation(issuer.session, { email })).rejects.toMatchObject({ code: "INVITATION_INVALID" });
    const stored = await db.invitation.findFirstOrThrow({ where: { email } });
    invitationIds.push(stored.id);
    expect(stored).toMatchObject({ sentAt: null, consumedAt: null, revokedAt: expect.any(Date) });
    await expect(invitations.getInvitationPreview(sendEmail.mock.calls[0]![0].token)).rejects.toMatchObject({ code: "INVITATION_INVALID" });
  });

  it("rejects registration completion when the issuer loses eligibility during verification delivery", async () => {
    const current = await invitation("HOUSEHOLD");
    sendEmail.mockImplementationOnce(async () => {
      await db.user.update({ where: { id: current.issuer!.user.id }, data: { status: "LOCKED" } });
    });
    await expect(invitations.startInvitedRegistration(current.token, {
      displayName: "New account", memberName: "New member", password,
    })).rejects.toMatchObject({ code: "REGISTRATION_INVALID" });
    const pending = await db.accountToken.findFirstOrThrow({ where: { invitationId: current.row.id } });
    expect(pending).toMatchObject({ sentAt: null, revokedAt: expect.any(Date) });
    expect((await db.invitation.findUniqueOrThrow({ where: { id: current.row.id } })).consumedAt).toBeNull();
    expect(await db.user.count({ where: { email: current.row.email } })).toBe(0);
  });

  it.each(["unverified", "wrong-email", "revoked-session"] as const)(
    "rejects an existing account with %s without consuming its invitation", async (reason) => {
      const existing = await account(undefined, reason !== "unverified");
      const current = await invitation("PLATFORM", reason === "wrong-email" ? undefined : existing.user.email);
      if (reason === "revoked-session") await db.appSession.update({
        where: { id: existing.session.appSessionId }, data: { revokedAt: new Date() },
      });
      const code = reason === "unverified" ? "EMAIL_NOT_VERIFIED" : reason === "wrong-email" ? "INVITATION_INVALID" : "UNAUTHORIZED";
      await expect(invitations.acceptInvitation(existing.session, current.token, {
        memberName: "Existing", householdName: "Rejected family",
      })).rejects.toMatchObject({ code });
      expect((await db.invitation.findUniqueOrThrow({ where: { id: current.row.id } })).consumedAt).toBeNull();
      expect(await db.householdMember.count({ where: { userId: existing.user.id } })).toBe(0);
    },
  );

  it("rejects mutually invited active members without waiting for either target household lock", async () => {
    const first = await household();
    const second = await household();
    const credentials = [shared.createIdentityToken(), shared.createIdentityToken()];
    const rows = await Promise.all([first, second].map((issuer, index) => db.invitation.create({ data: {
      purpose: "HOUSEHOLD", email: index === 0 ? second.user.email : first.user.email,
      householdId: issuer.family.id, createdByMemberId: issuer.member.id, tokenHash: credentials[index]!.tokenHash,
      expiresAt: new Date(Date.now() + 60_000), sentAt: new Date(),
    } })));
    invitationIds.push(...rows.map(({ id }) => id));
    const attempts: ReturnType<typeof invitations.acceptInvitation>[] = [];
    try {
      await db.$transaction(async (transaction) => {
        await transaction.$queryRaw`
          SELECT id FROM "Household" WHERE id IN (${first.family.id}, ${second.family.id}) ORDER BY id FOR UPDATE
        `;
        attempts.push(
          invitations.acceptInvitation(second.session, credentials[0]!.token, { memberName: "Second" }),
          invitations.acceptInvitation(first.session, credentials[1]!.token, { memberName: "First" }),
        );
        const results = await Promise.allSettled(attempts);
        for (const result of results) expect(result).toMatchObject({ status: "rejected", reason: { code: "HOUSEHOLD_MEMBERSHIP_EXISTS" } });
      }, { timeout: 3_000 });
    } finally {
      await Promise.allSettled(attempts);
    }
    expect(await db.invitation.count({ where: { id: { in: rows.map(({ id }) => id) }, consumedAt: null } })).toBe(2);
  });

  it("limits pending registration retries and keeps only the latest delivered verification usable", async () => {
    const current = await invitation("HOUSEHOLD");
    const input = { displayName: "New account", memberName: "New member", password };
    for (let index = 0; index < 3; index += 1) await invitations.startInvitedRegistration(current.token, input);
    await expect(invitations.startInvitedRegistration(current.token, input)).rejects.toMatchObject({ code: "RATE_LIMITED" });
    expect(await db.accountToken.count({ where: { invitationId: current.row.id } })).toBe(3);
    expect(await db.accountToken.count({ where: { invitationId: current.row.id, revokedAt: null, consumedAt: null } })).toBe(1);
    await expect(invitations.completeInvitedRegistration(sendEmail.mock.calls[0]![0].token)).rejects.toMatchObject({ code: "REGISTRATION_INVALID" });
    await expect(invitations.completeInvitedRegistration(sendEmail.mock.calls[2]![0].token)).resolves.toMatchObject({ status: "completed" });
  });

  it("creates a fresh membership when a former member rejoins under the same historical nickname", async () => {
    const existing = await account();
    const current = await invitation("HOUSEHOLD", existing.user.email);
    const oldMember = await db.householdMember.create({ data: {
      householdId: current.issuer!.family.id, userId: existing.user.id, memberName: "Returning", role: "MEMBER",
    } });
    await db.appSession.update({ where: { id: existing.session.appSessionId }, data: { memberId: oldMember.id } });
    const { leaveHousehold } = await import("@/lib/identity/households");
    await leaveHousehold({ ...existing.session, householdId: current.issuer!.family.id, memberId: oldMember.id, role: "MEMBER" }, password);
    const freshSession = await db.appSession.create({ data: {
      userId: existing.user.id, sessionKey: randomUUID(), expiresAt: new Date(Date.now() + 60_000),
    } });
    const result = await invitations.acceptInvitation({ ...existing.session, appSessionId: freshSession.id }, current.token, { memberName: "Returning" });
    expect(result.memberId).not.toBe(oldMember.id);
    expect(await db.householdMember.findUniqueOrThrow({ where: { id: oldMember.id } })).toMatchObject({ leftAt: expect.any(Date), memberName: "Returning" });
    expect(await db.householdMember.findUniqueOrThrow({ where: { id: result.memberId } })).toMatchObject({
      userId: existing.user.id, householdId: current.issuer!.family.id, memberName: "Returning", leftAt: null,
    });
    expect(await db.appSession.findUniqueOrThrow({ where: { id: existing.session.appSessionId } })).toMatchObject({
      memberId: oldMember.id, revokedAt: expect.any(Date),
    });
    expect(await db.appSession.findUniqueOrThrow({ where: { id: freshSession.id } })).toMatchObject({ memberId: null, revokedAt: expect.any(Date) });
  });
});
