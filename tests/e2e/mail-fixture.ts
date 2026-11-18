import { randomBytes } from "node:crypto";
import { createServer as createHttpServer } from "node:http";
import { createServer as createTcpServer, type Socket } from "node:net";

export type CapturedIdentityMail = { to: string; text: string };

function decodeText(raw: string) {
  const separator = raw.indexOf("\r\n\r\n");
  const headers = raw.slice(0, separator);
  const body = raw.slice(separator + 4);
  if (/content-transfer-encoding:\s*base64/i.test(headers)) return Buffer.from(body.replace(/\s/g, ""), "base64").toString("utf8");
  if (/content-transfer-encoding:\s*quoted-printable/i.test(headers)) {
    const bytes: number[] = [];
    const unfolded = body.replace(/=\r\n/g, "");
    for (let index = 0; index < unfolded.length; index++) {
      const hex = unfolded.slice(index + 1, index + 3);
      if (unfolded[index] === "=" && /^[0-9a-f]{2}$/i.test(hex)) { bytes.push(parseInt(hex, 16)); index += 2; }
      else bytes.push(...Buffer.from(unfolded[index]));
    }
    return Buffer.from(bytes).toString("utf8");
  }
  return body;
}

export async function startMailFixture() {
  const secret = randomBytes(32).toString("hex");
  const messages: CapturedIdentityMail[] = [];
  const sockets = new Set<Socket>();
  const smtp = createTcpServer((socket) => {
    sockets.add(socket);
    socket.on("close", () => sockets.delete(socket));
    socket.on("error", () => socket.destroy());
    socket.setEncoding("utf8");
    socket.setTimeout(15_000, () => socket.destroy());
    let pending = "";
    let authenticated = false;
    let authStage: "user" | "password" | null = null;
    let authUser = "";
    let recipient = "";
    let data: string[] | null = null;
    let dataSize = 0;
    socket.write("220 billboard-fixture ESMTP\r\n");
    socket.on("data", (chunk: string) => {
      pending += chunk;
      if (pending.length + dataSize > 1_048_576) { socket.destroy(); return; }
      let newline: number;
      while ((newline = pending.indexOf("\r\n")) !== -1) {
        const line = pending.slice(0, newline);
        pending = pending.slice(newline + 2);
        if (data) {
          if (line === ".") {
            messages.push({ to: recipient, text: decodeText(data.join("\r\n")).replace(/\r\n/g, "\n") });
            if (messages.length > 1000) messages.shift();
            data = null; dataSize = 0;
            socket.write("250 Message accepted\r\n");
          } else { const value = line.startsWith("..") ? line.slice(1) : line; data.push(value); dataSize += value.length + 2; }
          continue;
        }
        if (authStage) {
          const value = Buffer.from(line, "base64").toString("utf8");
          if (authStage === "user") { authUser = value; authStage = "password"; socket.write("334 UGFzc3dvcmQ6\r\n"); }
          else { authenticated = authUser === "sender@example.com" && value === "test-fixture-only"; authStage = null; socket.write(authenticated ? "235 Authenticated\r\n" : "535 Authentication failed\r\n"); }
          continue;
        }
        if (/^(EHLO|HELO)\b/i.test(line)) socket.write("250-billboard-fixture\r\n250-AUTH PLAIN LOGIN\r\n250 SIZE 1048576\r\n");
        else if (/^AUTH PLAIN\s/i.test(line)) {
          const [, user, password] = Buffer.from(line.replace(/^AUTH PLAIN\s+/i, ""), "base64").toString("utf8").split("\0");
          authenticated = user === "sender@example.com" && password === "test-fixture-only";
          socket.write(authenticated ? "235 Authenticated\r\n" : "535 Authentication failed\r\n");
        } else if (/^AUTH LOGIN\b/i.test(line)) { authStage = "user"; socket.write("334 VXNlcm5hbWU6\r\n"); }
        else if (/^MAIL FROM:/i.test(line)) { recipient = ""; socket.write(authenticated ? "250 Sender accepted\r\n" : "530 Authentication required\r\n"); }
        else if (/^RCPT TO:/i.test(line) && authenticated) {
          recipient = /<([^>]+)>/.exec(line)?.[1].toLowerCase() ?? "";
          socket.write(recipient ? "250 Recipient accepted\r\n" : "550 Invalid recipient\r\n");
        } else if (/^DATA$/i.test(line) && authenticated && recipient) { data = []; socket.write("354 End with a dot\r\n"); }
        else if (/^QUIT$/i.test(line)) { socket.end("221 Bye\r\n"); }
        else if (/^(RSET|NOOP)$/i.test(line)) socket.write("250 OK\r\n");
        else socket.write("500 Unsupported command\r\n");
      }
    });
  });
  const http = createHttpServer((request, response) => {
    if (request.method !== "GET" || request.headers.authorization !== `Bearer ${secret}`) { response.writeHead(401).end(); return; }
    const url = new URL(request.url ?? "/", "http://127.0.0.1");
    const to = url.searchParams.get("to")?.toLowerCase();
    if (url.pathname !== "/messages" || !to) { response.writeHead(404).end(); return; }
    response.writeHead(200, { "Content-Type": "application/json", "Cache-Control": "no-store" }).end(JSON.stringify({ messages: messages.filter((message) => message.to === to) }));
  });
  await new Promise<void>((resolve, reject) => { smtp.once("error", reject); smtp.listen(0, "127.0.0.1", resolve); });
  try {
    await new Promise<void>((resolve, reject) => { http.once("error", reject); http.listen(0, "127.0.0.1", resolve); });
  } catch (error) { smtp.close(); throw error; }
  const smtpAddress = smtp.address();
  const httpAddress = http.address();
  if (!smtpAddress || typeof smtpAddress === "string" || !httpAddress || typeof httpAddress === "string") throw new Error("Mail fixture did not bind loopback ports");
  const environment = {
    APP_PUBLIC_ORIGIN: "http://127.0.0.1:2501", SMTP_HOST: "127.0.0.1", SMTP_PORT: String(smtpAddress.port), SMTP_SECURE: "false",
    SMTP_USER: "sender@example.com", SMTP_PASSWORD: "test-fixture-only", SMTP_FROM_EMAIL: "sender@example.com",
    E2E_MAIL_FIXTURE_URL: `http://127.0.0.1:${httpAddress.port}`, E2E_MAIL_FIXTURE_TOKEN: secret,
  };
  const previous = Object.fromEntries(Object.keys(environment).map((key) => [key, process.env[key]]));
  Object.assign(process.env, environment);
  return async () => {
    for (const socket of sockets) socket.destroy();
    http.closeAllConnections();
    await Promise.all([new Promise<void>((resolve) => smtp.close(() => resolve())), new Promise<void>((resolve) => http.close(() => resolve()))]);
    for (const [key, value] of Object.entries(previous)) { if (value === undefined) delete process.env[key]; else process.env[key] = value; }
  };
}

export async function getCapturedIdentityMail(to: string): Promise<CapturedIdentityMail[]> {
  const origin = process.env.E2E_MAIL_FIXTURE_URL ?? "";
  const target = new URL(`/messages?${new URLSearchParams({ to })}`, origin);
  if (target.hostname !== "127.0.0.1" || target.protocol !== "http:") throw new Error("Mail fixture must use loopback");
  const response = await fetch(target, { headers: { Authorization: `Bearer ${process.env.E2E_MAIL_FIXTURE_TOKEN ?? ""}` }, signal: AbortSignal.timeout(5000) });
  if (!response.ok) throw new Error("Mail fixture query failed");
  return (await response.json() as { messages: CapturedIdentityMail[] }).messages;
}
