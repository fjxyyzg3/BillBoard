import { randomUUID } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { IdentityError } from "./shared";

let localActive = 0;

async function reserveMailLease(tx: Prisma.TransactionClient, slots: readonly number[], now: Date) {
  // Slot allocation has its own lock and does not depend on an identity quota row existing.
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('billboard:identity-mail-slots', 0))::text`;
  const active = await tx.identityMailLease.findMany({ where: { expiresAt: { gt: now } } });
  const slot = slots.find((value) => !active.some((lease) => lease.slot === value));
  if (active.length >= 2 || slot === undefined) throw new IdentityError("RATE_LIMITED");
  await tx.identityMailLease.deleteMany({ where: { expiresAt: { lte: now } } });
  return tx.identityMailLease.create({ data: { slot, token: randomUUID(), expiresAt: new Date(now.getTime() + 60_000) } });
}

export function reservePublicApplicationMailLease(tx: Prisma.TransactionClient, now: Date) {
  return reserveMailLease(tx, [1], now);
}

export async function releaseIdentityMailLease(token: string) {
  await db.identityMailLease.deleteMany({ where: { token } }).catch(() => undefined);
}

export async function withIdentityMailLease<T>(work: () => Promise<T>, reservedToken?: string): Promise<T> {
  // A public sender already owns a shared slot; pending local admissions cannot deny that handoff.
  if (!reservedToken && localActive >= 2) throw new IdentityError("RATE_LIMITED");
  localActive += 1;
  let token: string | undefined;
  let refresh: ReturnType<typeof setInterval> | undefined;
  let refreshing: Promise<unknown> | undefined;
  try {
    if (reservedToken) {
      // Claim once and leave enough lifetime for a full send before its first heartbeat.
      const claimedToken = randomUUID();
      const valid = await db.$queryRaw<{ token: string }[]>`
        UPDATE "IdentityMailLease" SET token = ${claimedToken}, expires_at = clock_timestamp() + INTERVAL '60 seconds'
        WHERE token = ${reservedToken} AND slot = 1 AND expires_at > clock_timestamp()
        RETURNING token
      `;
      if (valid.length !== 1) throw new IdentityError("RATE_LIMITED");
      token = claimedToken;
    } else {
      token = await db.$transaction(async (tx) => {
        const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
        return (await reserveMailLease(tx, [0, 1], now)).token;
      }, { maxWait: 5_000, timeout: 10_000 });
    }
    const leaseToken = token;
    refresh = setInterval(() => {
      if (!refreshing) {
        refreshing = db.$executeRaw`
          UPDATE "IdentityMailLease" SET expires_at = clock_timestamp() + INTERVAL '60 seconds'
          WHERE token = ${leaseToken} AND expires_at > clock_timestamp()
        `.catch(() => undefined).finally(() => { refreshing = undefined; });
      }
    }, 15_000);
    refresh.unref();
    return await work();
  } finally {
    clearInterval(refresh);
    await refreshing;
    if (token) await releaseIdentityMailLease(token);
    localActive -= 1;
  }
}
