import { isIP, Socket } from "node:net";
import type SMTPTransport from "nodemailer/lib/smtp-transport";
import { createTransport } from "smtp-mailer";
import { getMessages, type Locale } from "@/lib/i18n";
import { normalizeCredentialEmail } from "@/lib/auth/credentials";
import { hashIdentityToken, IdentityError, takeIdentityRateLimit } from "@/lib/identity/shared";
import { withIdentityMailLease } from "./mail-budget";

export type IdentityEmail = {
  to: string;
  locale?: Locale;
} & (
  | { kind: "invite" | "registration" | "verify" | "reset"; token: string; householdName?: string; invitationPurpose?: "PLATFORM" | "HOUSEHOLD" }
  | { kind: "application-confirmation"; token: string }
  | { kind: "application-rejected"; token?: never }
);

function mailbox(value: string) {
  const email = normalizeCredentialEmail(value);
  if (!email || /[\r\n<>()\[\]:;,"\\]/.test(email)) throw new IdentityError("INVALID_INPUT");
  return email;
}

function mailConfig() {
  const origin = new URL(process.env.APP_PUBLIC_ORIGIN ?? "");
  const developmentLoopback = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "[::1]"].includes(origin.hostname);
  if ((origin.protocol !== "https:" && !(developmentLoopback && origin.protocol === "http:"))
    || origin.username || origin.password || origin.pathname !== "/" || origin.search || origin.hash) throw new Error("Invalid public origin");
  const host = process.env.SMTP_HOST?.trim() ?? "";
  const port = Number(process.env.SMTP_PORT ?? "465");
  const secureValue = process.env.SMTP_SECURE ?? "true";
  if (!/^[a-zA-Z0-9.:-]+$/.test(host) || !Number.isInteger(port) || port < 1 || port > 65535 || !["true", "false"].includes(secureValue)) throw new Error("Invalid SMTP config");
  const user = mailbox(process.env.SMTP_USER ?? "");
  const from = mailbox(process.env.SMTP_FROM_EMAIL ?? user);
  const password = process.env.SMTP_PASSWORD ?? "";
  if (!password || password.length > 1024 || /[\r\n]/.test(password) || from !== user) throw new Error("Invalid SMTP identity");
  const secure = secureValue === "true";
  const localFixture = process.env.NODE_ENV !== "production" && ["localhost", "127.0.0.1", "::1"].includes(host);
  return { origin, host, port, user, from, password, secure, localFixture };
}

export async function sendIdentityEmail(input: IdentityEmail, options?: { mailLeaseToken: string }): Promise<void> {
  const to = mailbox(input.to);
  if (input.kind !== "application-rejected") hashIdentityToken(input.token);
  const publicConfirmation = input.kind === "application-confirmation";
  if (publicConfirmation && !options?.mailLeaseToken) throw new IdentityError("RATE_LIMITED");
  if (!publicConfirmation && options?.mailLeaseToken) throw new IdentityError("INVALID_INPUT");
  let config: ReturnType<typeof mailConfig>;
  try { config = mailConfig(); } catch { throw new IdentityError("EMAIL_DELIVERY_FAILED"); }
  if (!publicConfirmation) await takeIdentityRateLimit("mail", to);
  const messages = getMessages(input.locale ?? "zh-CN").identityMail;
  let subject: string;
  let text: string;
  if (input.kind === "application-rejected") {
    subject = messages.subjectApplicationRejected;
    text = messages.applicationRejected;
  } else {
    const isConfirmation = input.kind === "application-confirmation";
    const isPlatform = !isConfirmation && input.invitationPurpose === "PLATFORM";
    subject = isConfirmation ? messages.subjectApplicationConfirmation
      : input.kind === "reset" ? messages.subjectReset
        : input.kind === "registration" ? messages.subjectRegistration
          : input.kind === "verify" ? messages.subjectVerify
            : isPlatform ? messages.subjectInvitePlatform : messages.subjectInviteHousehold;
    const intro = isConfirmation ? messages.applicationConfirmation
      : input.kind === "reset" ? messages.reset
        : input.kind === "registration" ? messages.registration
          : input.kind === "verify" ? messages.verify
            : isPlatform ? messages.invitePlatform : messages.inviteHousehold;
    const link = new URL("/account-link", config.origin);
    link.hash = new URLSearchParams({ kind: isConfirmation ? "application" : input.kind, token: input.token }).toString();
    const household = !isConfirmation ? input.householdName?.replace(/[\r\n]/g, " ").slice(0, 80) : undefined;
    const expiry = isConfirmation ? messages.applicationConfirmationExpiry : messages.expiry;
    text = `${intro}\n${household ? `${messages.householdLabel}${household}\n` : ""}\n${messages.link}\n${link.href}\n\n${expiry}\n${messages.ignore}`;
  }
  try {
    await withIdentityMailLease(async () => {
      // Own the underlying socket: a non-pooled transport's close() does not cancel a send.
      const socket = new Socket();
      const closed = new Promise<void>((resolve) => socket.once("close", resolve));
      socket.on("error", () => undefined);
      let stopped = false;
      let connectionDeadline: ReturnType<typeof setTimeout> | undefined;
      const options: SMTPTransport.Options = {
        host: config.host, port: config.port, secure: config.secure,
        auth: { user: config.user, pass: config.password },
        name: "billboard.local", logger: false, debug: false,
        requireTLS: !config.secure && !config.localFixture,
        ignoreTLS: !config.secure && config.localFixture,
        tls: { rejectUnauthorized: true, minVersion: "TLSv1.2", ...(!isIP(config.host) ? { servername: config.host } : {}) },
        connectionTimeout: 10_000, greetingTimeout: 10_000, socketTimeout: 20_000, dnsTimeout: 5_000,
        disableFileAccess: true, disableUrlAccess: true,
        getSocket(_options, callback) {
          if (stopped) { callback(new Error("Delivery already ended"), {}); return; }
          const onError = (error: Error) => {
            clearTimeout(connectionDeadline);
            socket.off("connect", onConnect);
            callback(error, {});
          };
          const onConnect = () => {
            clearTimeout(connectionDeadline);
            socket.off("error", onError);
            if (stopped || socket.destroyed) { callback(new Error("Delivery already ended"), {}); return; }
            // Nodemailer still performs implicit TLS or STARTTLS and validates the server.
            callback(null, { connection: socket, secured: false });
          };
          socket.once("error", onError);
          socket.once("connect", onConnect);
          connectionDeadline = setTimeout(() => socket.destroy(new Error("Connection deadline expired")), 10_000);
          connectionDeadline.unref();
          socket.connect({ host: config.host, port: config.port });
        },
      };
      const transport = createTransport(options);
      let deadline: ReturnType<typeof setTimeout> | undefined;
      try {
        const expired = new Promise<never>((_resolve, reject) => {
          deadline = setTimeout(() => {
            stopped = true;
            socket.destroy();
            reject(new Error("Delivery deadline expired"));
          }, 25_000);
          deadline.unref();
        });
        const result = await Promise.race([transport.sendMail({
          from: { address: config.from, name: "BillBoard" },
          to: { address: to, name: "" }, subject, text,
          disableFileAccess: true, disableUrlAccess: true,
        }), expired]);
        if (result.accepted.length !== 1 || result.rejected.length !== 0) throw new Error("Delivery was not accepted");
      } finally {
        stopped = true;
        clearTimeout(deadline);
        clearTimeout(connectionDeadline);
        transport.close();
        socket.destroy();
        // A delivery slot stays occupied until the actual connection has closed.
        await closed;
      }
    }, options?.mailLeaseToken);
  } catch {
    // Provider errors may contain full recipients, credentials or the recovery link.
    throw new IdentityError("EMAIL_DELIVERY_FAILED");
  }
}
