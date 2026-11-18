import { createHash, randomUUID } from "node:crypto";
import { createServer, type Socket } from "node:net";
import { afterAll, beforeAll, expect, it, vi } from "vitest";

process.loadEnvFile(".env.example");
let db: typeof import("@/lib/db").db;

beforeAll(async () => {
  const url = new URL(process.env.DATABASE_URL!);
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) throw new Error("SMTP tests require a local development/test database");
  ({ db } = await import("@/lib/db"));
});

afterAll(async () => { await db?.$disconnect(); });

it("destroys stalled real SMTP sockets before releasing either delivery slot", async () => {
  const sockets = new Set<Socket>();
  let connections = 0;
  let maximumConnections = 0;
  let slowHandshakes = 0;
  let handshakesReady!: () => void;
  const ready = new Promise<void>((resolve) => { handshakesReady = resolve; });
  const server = createServer((socket) => {
    sockets.add(socket);
    connections += 1;
    maximumConnections = Math.max(maximumConnections, sockets.size);
    const slow = connections <= 2;
    let trickle: ReturnType<typeof setInterval> | undefined;
    let buffer = "";
    let inData = false;
    socket.on("error", () => undefined);
    socket.once("close", () => { clearInterval(trickle); sockets.delete(socket); });
    socket.write("220 fixture SMTP ready\r\n");
    socket.on("data", (chunk) => {
      buffer += chunk.toString();
      while (buffer.includes("\r\n")) {
        const boundary = buffer.indexOf("\r\n");
        const line = buffer.slice(0, boundary);
        buffer = buffer.slice(boundary + 2);
        if (inData) {
          if (line === ".") { inData = false; socket.write("250 queued\r\n"); }
        } else if (line.startsWith("EHLO")) {
          if (slow) {
            socket.write("250-fixture\r\n");
            // Activity prevents the inactivity timeout from replacing the absolute deadline.
            trickle = setInterval(() => socket.write("250-still waiting\r\n"), 1_000);
            slowHandshakes += 1;
            if (slowHandshakes === 2) handshakesReady();
          } else socket.write("250-fixture\r\n250 AUTH PLAIN\r\n");
        } else if (line.startsWith("AUTH ")) socket.write("235 authenticated\r\n");
        else if (line.startsWith("MAIL FROM:") || line.startsWith("RCPT TO:")) socket.write("250 accepted\r\n");
        else if (line === "DATA") { inData = true; socket.write("354 continue\r\n"); }
        else if (line === "QUIT") socket.end("221 goodbye\r\n");
      }
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  if (!address || typeof address === "string") throw new Error("Missing SMTP fixture port");
  const recipients = Array.from({ length: 4 }, () => `smtp-${randomUUID()}@example.com`);
  const ids = recipients.map((recipient) => `mail:${createHash("sha256").update(recipient).digest("hex")}`);
  vi.stubEnv("APP_PUBLIC_ORIGIN", "https://app.example.com");
  vi.stubEnv("SMTP_HOST", "127.0.0.1");
  vi.stubEnv("SMTP_PORT", String(address.port));
  vi.stubEnv("SMTP_SECURE", "false");
  vi.stubEnv("SMTP_USER", "sender@example.com");
  vi.stubEnv("SMTP_PASSWORD", "fixture-password");
  vi.stubEnv("SMTP_FROM_EMAIL", "sender@example.com");
  const { sendIdentityEmail } = await import("@/lib/identity/mail");
  const send = (to: string) => sendIdentityEmail({ to, kind: "verify", token: "a".repeat(43) });
  let deliveries: Promise<PromiseSettledResult<void>[]> | undefined;
  try {
    const sending = [send(recipients[0]), send(recipients[1])];
    deliveries = Promise.allSettled(sending);
    await Promise.race([ready, ...sending.map((delivery) => delivery.then(() => { throw new Error("Delivery ended before the slow SMTP handshake"); }))]);
    expect(await db.identityMailLease.count()).toBe(2);
    await expect(send(recipients[2])).rejects.toMatchObject({ code: "EMAIL_DELIVERY_FAILED" });
    expect(connections).toBe(2);
    const outcomes = await deliveries;
    expect(outcomes.every((outcome) => outcome.status === "rejected")).toBe(true);
    expect(await db.identityMailLease.count()).toBe(0);
    // Allow the peer's close event to observe the local socket destruction.
    await new Promise((resolve) => setTimeout(resolve, 50));
    const socketsAfterDeadline = sockets.size;
    await send(recipients[3]);
    expect(socketsAfterDeadline).toBe(0);
    expect(maximumConnections).toBe(2);
    expect(connections).toBe(3);
  } finally {
    for (const socket of sockets) socket.destroy();
    await deliveries;
    await new Promise<void>((resolve) => server.close(() => resolve()));
    await db.identityRateLimit.deleteMany({ where: { id: { in: ids } } });
    vi.unstubAllEnvs();
  }
}, 35_000);
