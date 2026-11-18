import { randomUUID } from "node:crypto";
import argon2 from "argon2";
import type { Prisma } from "@prisma/client";
import { dummyPasswordHash } from "@/lib/auth/credentials";
import { applyFailedAttempt, isLocked } from "@/lib/auth/login-guard";
import { db } from "@/lib/db";

const maxConcurrentAttempts = 2;
const burstCapacity = 10;
const tokenRefillMs = 3_000;
const leaseDurationMs = 60_000;
const leaseRefreshMs = 15_000;
const transactionOptions = { maxWait: 2_000, timeout: 5_000 };

type LoginUser = Prisma.UserGetPayload<{ include: { householdMember: true } }>;
type AdmittedAttempt = { status: "admitted"; token: string; user: LoginUser | null };
type Admission = AdmittedAttempt | { status: "rejected" } | { status: "rate_limited" };
type LoginResult = { status: "authenticated"; user: LoginUser }
  | { status: "invalid" } | { status: "rejected" } | { status: "rate_limited" };
type LockedBudget = { tokens: number; refilledAt: Date; now: Date };

let localActiveAttempts = 0;

async function lockBudget(tx: Prisma.TransactionClient): Promise<LockedBudget> {
  const [budget] = await tx.$queryRaw<LockedBudget[]>`
    WITH budget AS MATERIALIZED (
      SELECT "tokens", "refilled_at" AS "refilledAt"
      FROM "LoginBudget" WHERE "id" = 1 FOR UPDATE
    )
    SELECT *, clock_timestamp() AS "now" FROM budget
  `;

  if (!budget) {
    throw new Error("Login admission is unavailable");
  }

  return budget;
}

async function acquireAttempt(email: string): Promise<Admission> {
  return db.$transaction(async (tx) => {
    const budget = await lockBudget(tx);
    const refills = Math.floor(Math.max(0, budget.now.getTime() - budget.refilledAt.getTime()) / tokenRefillMs);
    const tokens = Math.min(burstCapacity, budget.tokens + refills);

    if (tokens === 0) {
      return { status: "rate_limited" };
    }

    const active = await tx.loginAttemptLease.findMany({ where: { expiresAt: { gt: budget.now } } });

    if (active.length >= maxConcurrentAttempts) {
      return { status: "rate_limited" };
    }

    await tx.loginBudget.update({
      where: { id: 1 },
      data: {
        tokens: tokens - 1,
        refilledAt: new Date(budget.refilledAt.getTime() + refills * tokenRefillMs),
      },
    });

    const user = await tx.user.findUnique({ where: { email }, include: { householdMember: { where: { leftAt: null, household: { closedAt: null } } } } });

    if (user) {
      const throttle = await tx.loginThrottle.findUnique({ where: { email: user.email } });

      if (isLocked(throttle, budget.now) || active.some((lease) => lease.userId === user.id)) {
        return { status: "rejected" };
      }
    }

    await tx.loginAttemptLease.deleteMany({ where: { expiresAt: { lte: budget.now } } });
    const slot = Array.from({ length: maxConcurrentAttempts }, (_, index) => index)
      .find((candidate) => !active.some((lease) => lease.slot === candidate))!;
    const token = randomUUID();

    await tx.loginAttemptLease.create({
      data: {
        slot,
        token,
        userId: user?.id ?? null,
        expiresAt: new Date(budget.now.getTime() + leaseDurationMs),
      },
    });

    return { status: "admitted", token, user };
  }, transactionOptions);
}

async function completeAttempt(attempt: AdmittedAttempt, succeeded: boolean) {
  return db.$transaction(async (tx) => {
    const { now } = await lockBudget(tx);
    const lease = await tx.loginAttemptLease.findUnique({ where: { token: attempt.token } });

    if (!lease || lease.expiresAt <= now) {
      return false;
    }

    if (attempt.user) {
      const email = attempt.user.email;

      if (succeeded) {
        await tx.loginThrottle.deleteMany({ where: { email } });
      } else {
        const previous = await tx.loginThrottle.findUnique({ where: { email } });
        const next = applyFailedAttempt(previous, now);
        const data = { attemptCount: next.attemptCount, lockedUntil: next.lockedUntil, updatedAt: now };

        await tx.loginThrottle.upsert({ where: { email }, create: { email, ...data }, update: data });
      }
    }

    await tx.loginAttemptLease.deleteMany({ where: { token: attempt.token } });
    return true;
  }, transactionOptions);
}

export async function verifyLoginCredentials(email: string, password: string): Promise<LoginResult> {
  // Also bound work in this process if a database lease expires during a long pause.
  if (localActiveAttempts >= maxConcurrentAttempts) {
    return { status: "rate_limited" };
  }

  localActiveAttempts += 1;
  let attempt: AdmittedAttempt | undefined;
  let refreshTimer: ReturnType<typeof setInterval> | undefined;
  let refreshInFlight: Promise<unknown> | undefined;
  let completed = false;

  try {
    const admission = await acquireAttempt(email);

    if (admission.status !== "admitted") {
      return admission;
    }

    attempt = admission;
    const token = admission.token;
    refreshTimer = setInterval(() => {
      if (!refreshInFlight) {
        refreshInFlight = db.$executeRaw`
          UPDATE "LoginAttemptLease"
          SET "expires_at" = clock_timestamp() + INTERVAL '60 seconds'
          WHERE "token" = ${token} AND "expires_at" > clock_timestamp()
        `.catch(() => undefined).finally(() => { refreshInFlight = undefined; });
      }
    }, leaseRefreshMs);
    refreshTimer.unref();

    const valid = await argon2.verify(admission.user?.passwordHash ?? dummyPasswordHash, password)
      .catch(() => false);

    clearInterval(refreshTimer);
    await refreshInFlight;
    const succeeded = Boolean(valid && admission.user?.status === "ACTIVE");
    completed = await completeAttempt(admission, succeeded);

    if (!completed) {
      return { status: "rate_limited" };
    }

    return succeeded && admission.user
      ? { status: "authenticated", user: admission.user }
      : { status: "invalid" };
  } catch {
    return { status: "rate_limited" };
  } finally {
    clearInterval(refreshTimer);
    await refreshInFlight;

    if (attempt && !completed) {
      await db.loginAttemptLease.deleteMany({ where: { token: attempt.token } }).catch(() => undefined);
    }

    // Do not release admission when only the HTTP request times out: argon2 must settle first.
    localActiveAttempts -= 1;
  }
}

export async function runAdmittedPasswordWork<T>(work: () => Promise<T>): Promise<T> {
  if (localActiveAttempts >= maxConcurrentAttempts) throw new Error("Password admission is unavailable");
  localActiveAttempts += 1;
  let attempt: AdmittedAttempt | undefined;
  let timer: ReturnType<typeof setInterval> | undefined;
  let refreshInFlight: Promise<unknown> | undefined;
  try {
    // The empty address cannot resolve to an account, but shares the login CPU budget.
    const admission = await acquireAttempt("");
    if (admission.status !== "admitted") throw new Error("Password admission is unavailable");
    attempt = admission;
    const token = admission.token;
    timer = setInterval(() => {
      if (!refreshInFlight) {
        refreshInFlight = db.$executeRaw`
          UPDATE "LoginAttemptLease" SET "expires_at" = clock_timestamp() + INTERVAL '60 seconds'
          WHERE "token" = ${token} AND "expires_at" > clock_timestamp()
        `.catch(() => undefined).finally(() => { refreshInFlight = undefined; });
      }
    }, leaseRefreshMs);
    timer.unref();
    const result = await work();
    clearInterval(timer);
    await refreshInFlight;
    if (!await completeAttempt(admission, true)) throw new Error("Password admission expired");
    return result;
  } finally {
    clearInterval(timer);
    await refreshInFlight;
    if (attempt) await db.loginAttemptLease.deleteMany({ where: { token: attempt.token } }).catch(() => undefined);
    localActiveAttempts -= 1;
  }
}
