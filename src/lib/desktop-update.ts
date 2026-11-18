import { requireAppSession } from "@/lib/auth/session";
import {
  DESKTOP_SHA256_PATTERN, MAX_DESKTOP_INSTALLER_BYTES, MAX_DESKTOP_MANIFEST_BYTES,
  parseDesktopEnvelope, parseDesktopRelease,
} from "./desktop-update-manifest.mjs";
import {
  openReleaseArtifact, readReleaseManifest, releaseDeadline, releaseHeaders, releaseFailure, reserveReleaseFile,
  streamReleaseArtifact, verifyReleaseArtifact, type ReleaseFailure, type ReleaseFile,
} from "./release-files";

export const desktopUpdateHeaders = releaseHeaders;
export const desktopUpdateFailure = releaseFailure;
type UpdateSession = Awaited<ReturnType<typeof requireAppSession>>;

export async function requireDesktopUpdateSession(original?: UpdateSession) {
  const session = await requireAppSession();
  if (!session.id || !session.appSessionId || !session.householdId || !session.memberId
    || (original && ["id", "appSessionId", "householdId", "memberId"].some(
      (key) => session[key as keyof UpdateSession] !== original[key as keyof UpdateSession],
    ))) throw new Error("Unauthorized");
  return session;
}

export async function readDesktopUpdate(requestSignal: AbortSignal) {
  if (requestSignal.aborted) return { status: "cancelled" } as ReleaseFailure;
  const operation = releaseDeadline(requestSignal, 30_000);
  let file: ReleaseFile | undefined;
  const releaseSlot = reserveReleaseFile();
  if (!releaseSlot) { operation.clear(); return { status: "busy" } as ReleaseFailure; }
  try {
    const bytes = await readReleaseManifest("windows", MAX_DESKTOP_MANIFEST_BYTES, operation.signal);
    const envelope = parseDesktopEnvelope(bytes);
    // The client authenticates these original signed bytes with its pinned public key.
    const release = parseDesktopRelease(JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(envelope.payload, "base64"))));
    file = await openReleaseArtifact("windows", release.sha256, MAX_DESKTOP_INSTALLER_BYTES, operation.signal);
    if (file.info.size !== release.size || !await verifyReleaseArtifact(file, release.sha256, operation.signal)) {
      return { status: "missing" } as ReleaseFailure;
    }
    operation.signal.throwIfAborted();
    return { status: "ok" as const, bytes: new Uint8Array(bytes), release };
  } catch {
    return { status: operation.signal.aborted ? "cancelled" : "missing" } as ReleaseFailure;
  } finally {
    try { await file?.handle.close(); } finally {
      releaseSlot();
      operation.clear();
    }
  }
}

export async function streamDesktopInstaller(sha256: string, requestSignal: AbortSignal) {
  if (requestSignal.aborted) return { status: "cancelled" } as ReleaseFailure;
  if (!DESKTOP_SHA256_PATTERN.test(sha256)) return { status: "missing" } as ReleaseFailure;
  const releaseSlot = reserveReleaseFile();
  if (!releaseSlot) return { status: "busy" } as ReleaseFailure;
  const operation = releaseDeadline(requestSignal, 10 * 60_000);
  let file: ReleaseFile | undefined;
  try {
    file = await openReleaseArtifact("windows", sha256, MAX_DESKTOP_INSTALLER_BYTES, operation.signal);
    if (!await verifyReleaseArtifact(file, sha256, operation.signal)) throw new Error("Unavailable Windows update");
    operation.signal.throwIfAborted();
    return { status: "ok" as const, body: streamReleaseArtifact(file, sha256, operation, releaseSlot), size: file.info.size };
  } catch {
    try { await file?.handle.close(); } finally {
      releaseSlot();
      operation.clear();
    }
    return { status: operation.signal.aborted ? "cancelled" : "missing" } as ReleaseFailure;
  }
}
