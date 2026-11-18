import { createHash, randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";

process.loadEnvFile(".env.example");
let db: typeof import("@/lib/db").db;
let applications: typeof import("@/lib/identity/access-applications");
let mail: typeof import("@/lib/identity/mail");
const emails: string[] = [];

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) {
    throw new Error("Public SMTP tests require a local development/test database");
  }
  ({ db } = await import("@/lib/db"));
  applications = await import("@/lib/identity/access-applications");
  mail = await import("@/lib/identity/mail");
});

beforeEach(async () => {
  await db.identityRateLimit.deleteMany();
  expect(await db.identityMailLease.count()).toBe(0);
});

afterEach(async () => {
  await db.accessApplicationConfirmation.deleteMany({ where: { email: { in: emails } } });
  await db.identityRateLimit.deleteMany();
  emails.length = 0;
  vi.unstubAllEnvs();
});

afterAll(async () => { await db?.$disconnect(); });

function mailbox() {
  const email = `public-smtp-${randomUUID()}@example.com`;
  emails.push(email);
  return email;
}

type SMTPFixture = {
  messages: { recipient: string; text: string }[];
  heldCount: () => number;
  connections: () => number;
  maximumConnections: () => number;
  holdThrough: (messageCount: number) => void;
  release: () => void;
  track: <T>(promise: Promise<T>) => Promise<T>;
};

async function withSMTPFixture(work: (fixture: SMTPFixture) => Promise<void>, heldMessages = 0) {
  const sockets = new Set<Socket>();
  const held = new Set<Socket>();
  const pending = new Set<Promise<unknown>>();
  const messages: SMTPFixture["messages"] = [];
  let holdThrough = heldMessages;
  let connections = 0;
  let maximumConnections = 0;
  let stopping = false;
  const release = () => {
    for (const socket of held) if (!socket.destroyed) socket.write("250 queued\r\n");
    held.clear();
  };
  const server = createServer((socket) => {
    if (stopping) { socket.destroy(); return; }
    sockets.add(socket);
    connections += 1;
    maximumConnections = Math.max(maximumConnections, sockets.size);
    let buffer = "";
    let inData = false;
    let recipient = "";
    let text = "";
    socket.on("error", () => undefined);
    socket.once("close", () => { sockets.delete(socket); held.delete(socket); });
    socket.write("220 fixture SMTP ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes("\r\n")) {
        const boundary = buffer.indexOf("\r\n");
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (inData) {
          if (line !== ".") text += `${line}\r\n`;
          else {
            inData = false;
            messages.push({ recipient, text });
            if (messages.length <= holdThrough) held.add(socket);
            else socket.write("250 queued\r\n");
          }
        } else if (line.startsWith("EHLO")) socket.write("250-fixture\r\n250 AUTH PLAIN\r\n");
        else if (line.startsWith("AUTH ")) socket.write("235 authenticated\r\n");
        else if (line.startsWith("MAIL FROM:")) socket.write("250 accepted\r\n");
        else if (line.startsWith("RCPT TO:")) {
          recipient = line.match(/<([^>]+)>/)?.[1].toLowerCase() ?? "";
          socket.write("250 accepted\r\n");
        } else if (line === "DATA") { inData = true; socket.write("354 continue\r\n"); }
        else if (line === "QUIT") socket.end("221 goodbye\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing public SMTP fixture port");
  vi.stubEnv("APP_PUBLIC_ORIGIN", "https://app.example.com");
  vi.stubEnv("SMTP_HOST", "127.0.0.1");
  vi.stubEnv("SMTP_PORT", String(address.port));
  vi.stubEnv("SMTP_SECURE", "false");
  vi.stubEnv("SMTP_USER", "sender@example.com");
  vi.stubEnv("SMTP_PASSWORD", "fixture-password");
  vi.stubEnv("SMTP_FROM_EMAIL", "sender@example.com");
  try {
    await work({
      messages,
      heldCount: () => held.size,
      connections: () => connections,
      maximumConnections: () => maximumConnections,
      holdThrough: (count) => { holdThrough = count; },
      release,
      track: (promise) => {
        pending.add(promise);
        void promise.catch(() => undefined);
        return promise;
      },
    });
  } finally {
    // Stop accepting sockets before letting pending database admissions finish.
    stopping = true;
    const closed = new Promise<void>((resolve) => server.close(() => resolve()));
    for (const socket of sockets) socket.destroy();
    await Promise.allSettled(pending);
    await closed;
  }
}

async function publicMailBudget() {
  return db.identityRateLimit.findMany({ where: { id: { startsWith: "public-application:mail:" } }, orderBy: { id: "asc" } });
}

describe("public applications through real SMTP and shared admission", () => {
  it("delivers while normal identity quota is exhausted without touching its global or recipient buckets", async () => {
    const email = mailbox();
    const now = new Date();
    await db.identityRateLimit.create({ data: { id: "global", attempts: 240, windowStartedAt: now, lastAttemptAt: now } });
    const original = await db.identityRateLimit.findUniqueOrThrow({ where: { id: "global" } });
    await withSMTPFixture(async (fixture) => {
      await expect(applications.requestAccessApplication({ email })).resolves.toEqual({ accepted: true });
      expect(fixture.messages.map((message) => message.recipient)).toEqual([email]);
      expect(await db.accessApplicationConfirmation.findFirst({ where: { email } })).toMatchObject({ sentAt: expect.any(Date), revokedAt: null });
      expect(await db.identityRateLimit.findUnique({ where: { id: "global" } })).toEqual(original);
      const recipientId = `mail:${createHash("sha256").update(email).digest("hex")}`;
      expect(await db.identityRateLimit.findUnique({ where: { id: recipientId } })).toBeNull();
      expect(await db.identityMailLease.count()).toBe(0);
    });
  }, 10_000);

  it("reserves one SMTP slot for ordinary identity mail and refuses another public send before creating a credential", async () => {
    const email = mailbox();
    const blockedEmail = mailbox();
    const thirdEmail = mailbox();
    await withSMTPFixture(async (fixture) => {
      const first = fixture.track(applications.requestAccessApplication({ email }));
      await expect.poll(fixture.heldCount).toBe(1);
      expect(await db.identityMailLease.count()).toBe(1);
      const before = await publicMailBudget();
      await applications.requestAccessApplication({ email: blockedEmail }).catch((error: unknown) => {
        expect(error).toMatchObject({ code: "RATE_LIMITED" });
      });
      expect(await db.accessApplicationConfirmation.count({ where: { email: blockedEmail } })).toBe(0);
      expect(await publicMailBudget()).toEqual(before);
      expect(fixture.connections()).toBe(1);

      fixture.holdThrough(2);
      const ordinary = fixture.track(mail.sendIdentityEmail({ to: email, kind: "reset", token: "a".repeat(43) }));
      await expect.poll(fixture.heldCount).toBe(2);
      expect(await db.identityMailLease.count()).toBe(2);
      await expect(mail.sendIdentityEmail({ to: thirdEmail, kind: "verify", token: "b".repeat(43) })).rejects.toMatchObject({ code: "EMAIL_DELIVERY_FAILED" });
      expect(fixture.connections()).toBe(2);
      expect(fixture.maximumConnections()).toBe(2);
      expect(fixture.messages.map((message) => message.recipient)).toEqual([email, email]);

      fixture.release();
      await expect(first).resolves.toEqual({ accepted: true });
      await expect(ordinary).resolves.toBeUndefined();
      await expect.poll(async () => db.identityMailLease.count()).toBe(0);
    }, 1);
  }, 10_000);

  it("coalesces independent same-mailbox deliveries while the real socket is still active", async () => {
    const email = mailbox();
    const first = await applications.prepareAccessApplication({ email });
    const second = await applications.prepareAccessApplication({ email: ` ${email.toUpperCase()} ` });
    await withSMTPFixture(async (fixture) => {
      const delivery = fixture.track(first.deliver());
      await expect.poll(fixture.heldCount).toBe(1);
      const before = await publicMailBudget();
      await expect(second.deliver()).resolves.toEqual({ accepted: true });
      expect(await db.accessApplicationConfirmation.count({ where: { email } })).toBe(1);
      expect(await publicMailBudget()).toEqual(before);
      expect(fixture.connections()).toBe(1);
      fixture.release();
      await expect(delivery).resolves.toEqual({ accepted: true });
      expect(await db.accessApplicationConfirmation.count({ where: { email, sentAt: { not: null }, revokedAt: null } })).toBe(1);
      expect(await db.identityMailLease.count()).toBe(0);
    }, 1);
  }, 10_000);

  it("hands off a public reservation only once while keeping its running work reserved", async () => {
    const budget = await import("@/lib/identity/mail-budget");
    const lease = await db.$transaction(async (tx) => {
      const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      return budget.reservePublicApplicationMailLease(tx, now);
    });
    let begin!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const stopped = new Promise<void>((resolve) => { finish = resolve; });
    const sending = budget.withIdentityMailLease(async () => { begin(); await stopped; }, lease.token);
    try {
      await started;
      await expect(budget.withIdentityMailLease(async () => undefined, lease.token)).rejects.toMatchObject({ code: "RATE_LIMITED" });
      expect(await db.identityMailLease.count({ where: { slot: 1 } })).toBe(1);
    } finally {
      finish();
      await sending;
    }
    expect(await db.identityMailLease.count()).toBe(0);
  });

  it("does not release ordinary identity work after an invalid public handoff", async () => {
    const budget = await import("@/lib/identity/mail-budget");
    let begin!: () => void;
    let finish!: () => void;
    const started = new Promise<void>((resolve) => { begin = resolve; });
    const stopped = new Promise<void>((resolve) => { finish = resolve; });
    const sending = budget.withIdentityMailLease(async () => { begin(); await stopped; });
    try {
      await started;
      const lease = await db.identityMailLease.findUniqueOrThrow({ where: { slot: 0 } });
      await expect(budget.withIdentityMailLease(async () => undefined, lease.token)).rejects.toMatchObject({ code: "RATE_LIMITED" });
      expect(await db.identityMailLease.findUnique({ where: { token: lease.token } })).not.toBeNull();
    } finally {
      finish();
      await sending;
    }
    expect(await db.identityMailLease.count()).toBe(0);
  });

  it("keeps public quota cleanup owned by public admission", async () => {
    const id = "public-application:mail:mailbox:expired-fixture:hour";
    const expired = new Date(Date.now() - 25 * 60 * 60_000);
    await db.identityRateLimit.create({ data: { id, attempts: 3, windowStartedAt: expired, lastAttemptAt: expired } });
    const identity = await import("@/lib/identity/shared");
    await identity.takeIdentityRateLimit("token", "ordinary-identity-fixture");
    expect(await db.identityRateLimit.findUnique({ where: { id } })).not.toBeNull();
    const publicBudget = await import("@/lib/identity/access-application-budget");
    await publicBudget.takeAccessApplicationRequestLimit("request");
    expect(await db.identityRateLimit.findUnique({ where: { id } })).toBeNull();
  });

  it("renews a nearly expired public reservation before starting its send", async () => {
    const budget = await import("@/lib/identity/mail-budget");
    const lease = await db.$transaction(async (tx) => {
      const [{ now }] = await tx.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      return budget.reservePublicApplicationMailLease(tx, now);
    });
    await db.$executeRaw`UPDATE "IdentityMailLease" SET expires_at = clock_timestamp() + INTERVAL '2 seconds' WHERE token = ${lease.token}`;
    await budget.withIdentityMailLease(async () => {
      const active = await db.identityMailLease.findUniqueOrThrow({ where: { slot: 1 } });
      const [{ now }] = await db.$queryRaw<{ now: Date }[]>`SELECT clock_timestamp() AS now`;
      expect(active.expiresAt.getTime() - now.getTime()).toBeGreaterThan(55_000);
    }, lease.token);
    expect(await db.identityMailLease.count()).toBe(0);
  });
});
