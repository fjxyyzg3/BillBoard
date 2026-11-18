import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import { db } from "@/lib/db";
import { IdentityError } from "./shared";

type Transaction = Prisma.TransactionClient;
type WindowRule = { id: string; startedAt: Date; maximum: number; gapMs?: number };
const prefix = "public-application:";
const minuteMs = 60_000;
const hourMs = 60 * minuteMs;
const dayMs = 24 * hourMs;
const shanghaiOffsetMs = 8 * hourMs;

function windowStart(now: Date, durationMs: number, offsetMs = 0) {
  return new Date(Math.floor((now.getTime() + offsetMs) / durationMs) * durationMs - offsetMs);
}

async function collectExpiredWindows(tx: Transaction, now: Date) {
  await tx.$executeRaw`
    DELETE FROM "IdentityRateLimit" WHERE id IN (
      SELECT id FROM "IdentityRateLimit"
      WHERE id LIKE ${`${prefix}%`} AND last_attempt_at < ${new Date(now.getTime() - dayMs)}
      ORDER BY last_attempt_at, id LIMIT 100 FOR UPDATE SKIP LOCKED
    )
  `;
}

async function takeWindows(tx: Transaction, rules: WindowRule[], now: Date) {
  const rows = await tx.identityRateLimit.findMany({ where: { id: { in: rules.map((rule) => rule.id) } } });
  const previous = new Map(rows.map((row) => [row.id, row]));
  for (const rule of rules) {
    const row = previous.get(rule.id);
    if (!row) continue;
    // A cooldown spans a fixed-window boundary; rolling the clock back must fail closed.
    if (row.windowStartedAt > rule.startedAt
      || (rule.gapMs && now.getTime() - row.lastAttemptAt.getTime() < rule.gapMs)
      || (row.windowStartedAt.getTime() === rule.startedAt.getTime() && row.attempts >= rule.maximum)) {
      throw new IdentityError("RATE_LIMITED");
    }
  }
  // All windows pass before any increment, including when a caller catches the rejection.
  for (const rule of rules) {
    const row = previous.get(rule.id);
    const attempts = row?.windowStartedAt.getTime() === rule.startedAt.getTime() ? row.attempts + 1 : 1;
    const data = { attempts, windowStartedAt: rule.startedAt, lastAttemptAt: now };
    await tx.identityRateLimit.upsert({ where: { id: rule.id }, create: { id: rule.id, ...data }, update: data });
  }
  await collectExpiredWindows(tx, now);
}

export async function takeAccessApplicationRequestLimit(kind: "request" | "confirmation"): Promise<void> {
  if (kind !== "request" && kind !== "confirmation") throw new IdentityError("INVALID_INPUT");
  await db.$transaction(async (tx) => {
    await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended(${`${prefix}${kind}`}, 0))::text`;
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    const namespace = `${prefix}${kind}`;
    await takeWindows(tx, [
      { id: `${namespace}:minute`, startedAt: windowStart(now, minuteMs), maximum: kind === "request" ? 30 : 60 },
      { id: `${namespace}:quarter-hour`, startedAt: windowStart(now, 15 * minuteMs), maximum: kind === "request" ? 120 : 240 },
    ], now);
  }, { maxWait: 5_000, timeout: 10_000 });
}

export async function takeAccessApplicationMailLimit(tx: Transaction, email: string, now: Date): Promise<void> {
  const mailbox = email.trim().toLowerCase();
  if (!mailbox || mailbox.length > 254 || !Number.isFinite(now.getTime())) throw new IdentityError("INVALID_INPUT");
  await tx.$queryRaw`SELECT pg_advisory_xact_lock(hashtextextended('public-application:mail', 0))::text`;
  const mailboxHash = createHash("sha256").update(mailbox).digest("hex");
  const global = `${prefix}mail:global`;
  const recipient = `${prefix}mail:mailbox:${mailboxHash}`;
  const hourStart = windowStart(now, hourMs);
  const dayStart = windowStart(now, dayMs, shanghaiOffsetMs);
  await takeWindows(tx, [
    { id: `${global}:minute`, startedAt: windowStart(now, minuteMs), maximum: 2 },
    { id: `${global}:hour`, startedAt: hourStart, maximum: 20 },
    { id: `${global}:day`, startedAt: dayStart, maximum: 100 },
    { id: `${recipient}:hour`, startedAt: hourStart, maximum: 3, gapMs: minuteMs },
    { id: `${recipient}:day`, startedAt: dayStart, maximum: 5 },
  ], now);
}
