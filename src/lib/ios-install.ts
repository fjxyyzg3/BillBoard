import { createCipheriv, createDecipheriv, createHmac, randomBytes } from "node:crypto";
import type { AppSessionUser } from "@/auth";
import { loadValidAppSessionUser } from "@/lib/auth/app-sessions";
import { requireAppSession } from "@/lib/auth/session";
import { normalizeAppBasePath } from "@/lib/base-path";
import {
  IOS_DOWNLOAD_TIMEOUT_MS, IOS_INSTALL_TTL_MS, MAX_IOS_IPA_BYTES, MAX_IOS_METADATA_BYTES, parseIosRelease,
  type IosRelease,
} from "@/lib/ios-release-manifest.mjs";
import { isOpsAdminInstance } from "@/lib/ops/config";
import {
  openReleaseArtifact, readReleaseManifest, releaseDeadline, releaseFailure, releaseHeaders, reserveReleaseFile,
  streamReleaseArtifact, verifyReleaseArtifact, type ReleaseFile,
} from "@/lib/release-files";

type Config = { origin: string; householdId: string; key: Buffer };
type Resource = "manifest" | "package";
type Ticket = {
  session: string; user: string; member: string; household: string; sha256: string; expires: number;
};

export type IosInstallOffer = { status: "sign-in" | "unavailable" } | { status: "available"; version: string; build: string };

function config(): Config | null {
  if (isOpsAdminInstance()) return null;
  const householdId = process.env.IOS_INSTALL_HOUSEHOLD_ID?.trim();
  const origin = process.env.APP_PUBLIC_ORIGIN?.trim();
  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET;
  if (!householdId || !origin || !secret) return null;
  try {
    const url = new URL(origin);
    if (url.protocol !== "https:" || (origin !== url.origin && origin !== url.origin + "/") || normalizeAppBasePath()) return null;
    return { origin: url.origin, householdId, key: createHmac("sha256", secret).update("billboard-ios-install-v1").digest() };
  } catch {
    return null;
  }
}

async function getMember() {
  try { return await requireAppSession(); } catch { return null; }
}

async function readRelease(signal: AbortSignal, sha256?: string) {
  const bytes = await readReleaseManifest("ios", MAX_IOS_METADATA_BYTES, signal, sha256);
  const release = parseIosRelease(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)));
  if ((sha256 && release.sha256 !== sha256) || release.validUntil <= Date.now()) throw new Error("Unavailable iOS release");
  return release;
}

async function availableRelease(signal: AbortSignal) {
  const releaseSlot = reserveReleaseFile();
  if (!releaseSlot) return null;
  const operation = releaseDeadline(signal, 5000);
  let file: ReleaseFile | undefined;
  try {
    const latest = await readRelease(operation.signal);
    const release = await readRelease(operation.signal, latest.sha256);
    if (JSON.stringify(latest) !== JSON.stringify(release)) return null;
    file = await openReleaseArtifact("ios", release.sha256, MAX_IOS_IPA_BYTES, operation.signal);
    return file.info.size === release.size && !operation.signal.aborted ? release : null;
  } catch {
    return null;
  } finally {
    try { await file?.handle.close(); } finally { operation.clear(); releaseSlot(); }
  }
}

export async function getIosInstallOffer(): Promise<IosInstallOffer> {
  if (isOpsAdminInstance()) return { status: "unavailable" };
  const member = await getMember();
  if (!member) return { status: "sign-in" };
  if (member.householdId !== config()?.householdId) return { status: "unavailable" };
  const release = await availableRelease(AbortSignal.timeout(5000));
  return release ? { status: "available", version: release.version, build: release.build } : { status: "unavailable" };
}

function seal(ticket: Ticket, resource: Resource, settings: Config) {
  const nonce = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", settings.key, nonce);
  cipher.setAAD(Buffer.from(resource));
  const body = Buffer.concat([cipher.update(JSON.stringify(ticket), "utf8"), cipher.final()]);
  return Buffer.concat([nonce, cipher.getAuthTag(), body]).toString("base64url");
}

function openTicket(value: string, resource: Resource, settings: Config): Ticket | null {
  if (!/^[A-Za-z0-9_-]{39,1024}$/.test(value)) return null;
  try {
    const bytes = Buffer.from(value, "base64url");
    if (bytes.toString("base64url") !== value) return null;
    const decipher = createDecipheriv("aes-256-gcm", settings.key, bytes.subarray(0, 12));
    decipher.setAAD(Buffer.from(resource));
    decipher.setAuthTag(bytes.subarray(12, 28));
    const ticket = JSON.parse(Buffer.concat([decipher.update(bytes.subarray(28)), decipher.final()]).toString("utf8")) as Ticket;
    return ticket.household === settings.householdId && ticket.expires > Date.now() ? ticket : null;
  } catch {
    return null;
  }
}

function toTicket(user: AppSessionUser, release: IosRelease): Ticket {
  return {
    session: user.appSessionId, user: user.id, member: user.memberId, household: user.householdId,
    expires: Math.min(Date.now() + IOS_INSTALL_TTL_MS, release.validUntil), sha256: release.sha256,
  };
}

async function stillAuthorized(ticket: Ticket) {
  const user = await loadValidAppSessionUser(ticket.session);
  return ticket.expires > Date.now() && user?.id === ticket.user
    && user.memberId === ticket.member && user.householdId === ticket.household;
}

function urlFor(ticket: Ticket, resource: Resource, settings: Config) {
  return new URL(`/api/ios/install/${resource}/${seal(ticket, resource, settings)}`, settings.origin).href;
}

export async function grantIosInstall(request: Request) {
  const settings = config();
  if (!settings || request.headers.get("origin") !== settings.origin || request.signal.aborted) return releaseFailure("missing");
  const site = request.headers.get("sec-fetch-site");
  if (site && site !== "same-origin") return releaseFailure("missing");
  const user = await getMember();
  if (!user || user.householdId !== settings.householdId) return releaseFailure("missing");
  const release = await availableRelease(request.signal);
  if (!release) return releaseFailure("missing");
  const ticket = toTicket(user, release);
  if (!await stillAuthorized(ticket) || request.signal.aborted) return releaseFailure("missing");
  return Response.json({
    url: `itms-services://?action=download-manifest&url=${encodeURIComponent(urlFor(ticket, "manifest", settings))}`,
    expiresAt: ticket.expires,
  }, { headers: releaseHeaders });
}

function manifest(release: IosRelease, packageUrl: string) {
  const encodedUrl = packageUrl.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
  return `<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN" "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0"><dict><key>items</key><array><dict>
<key>assets</key><array><dict><key>kind</key><string>software-package</string><key>url</key><string>${encodedUrl}</string></dict></array>
<key>metadata</key><dict><key>bundle-identifier</key><string>${release.bundleId}</string>
<key>bundle-version</key><string>${release.build}</string><key>kind</key><string>software</string><key>title</key><string>BillBoard</string></dict>
</dict></array></dict></plist>`;
}

function byteRange(value: string | null, size: number) {
  if (!value) return undefined;
  const match = /^bytes=(\d{0,16})-(\d{0,16})$/.exec(value);
  if (!match || (!match[1] && !match[2])) return null;
  const start = match[1] ? Number(match[1]) : Math.max(0, size - Number(match[2]));
  const end = match[1] && match[2] ? Math.min(Number(match[2]), size - 1) : size - 1;
  return Number.isSafeInteger(start) && start <= end && start < size ? { start, end } : null;
}

export async function serveIosInstall(request: Request, resource: string, secret: string) {
  const settings = config();
  if (!settings || (resource !== "manifest" && resource !== "package")) return releaseFailure("missing");
  const ticket = openTicket(secret, resource, settings);
  if (!ticket) return releaseFailure("missing");
  const releaseSlot = reserveReleaseFile();
  if (!releaseSlot) return releaseFailure("busy");
  const operation = releaseDeadline(request.signal, IOS_DOWNLOAD_TIMEOUT_MS);
  const head = request.method === "HEAD";
  let file: ReleaseFile | undefined;
  let streaming = false;
  try {
    if (!await stillAuthorized(ticket)) return releaseFailure("missing");
    const release = await readRelease(operation.signal, ticket.sha256);
    if (resource === "manifest") {
      if (!await stillAuthorized(ticket) || operation.signal.aborted) return releaseFailure("missing");
      const xml = manifest(release, urlFor(ticket, "package", settings));
      return new Response(head ? null : xml, { headers: {
        ...releaseHeaders, "Content-Type": "application/xml; charset=utf-8", "Content-Length": String(Buffer.byteLength(xml)),
      } });
    }
    file = await openReleaseArtifact("ios", release.sha256, MAX_IOS_IPA_BYTES, operation.signal);
    if (file.info.size !== release.size || (!head && !await verifyReleaseArtifact(file, release.sha256, operation.signal))
      || !await stillAuthorized(ticket) || release.validUntil <= Date.now()) return releaseFailure("missing");
    operation.signal.throwIfAborted();
    const etag = `"${release.sha256}"`;
    const ifRange = request.headers.get("if-range");
    const range = byteRange(head || (ifRange && ifRange !== etag) ? null : request.headers.get("range"), release.size);
    const headers = { ...releaseHeaders, "Accept-Ranges": "bytes", ETag: etag, "Content-Type": "application/octet-stream" };
    if (range === null) return new Response(null, { status: 416, headers: { ...headers, "Content-Range": `bytes */${release.size}` } });
    const body = head ? null : streamReleaseArtifact(file, release.sha256, operation, releaseSlot, range);
    streaming = !head;
    return new Response(body, {
      status: range ? 206 : 200,
      headers: {
        ...headers, "Content-Length": String(range ? range.end - range.start + 1 : release.size),
        ...(range ? { "Content-Range": `bytes ${range.start}-${range.end}/${release.size}` } : {}),
      },
    });
  } catch {
    return releaseFailure(operation.signal.aborted ? "cancelled" : "missing");
  } finally {
    if (!streaming) {
      try { await file?.handle.close(); } finally { operation.clear(); releaseSlot(); }
    }
  }
}
