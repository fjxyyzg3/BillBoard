import { requireAppSession } from "@/lib/auth/session";
import { abortEncryption, batchEncryption, commitEncryption, encryptionMaterials, prepareEncryption, queryEncryption } from "@/lib/encryption/service";
import { getHouseholdEncryptionStatus } from "@/lib/encryption/request";
import { EncryptionRequestError } from "@/lib/encryption/types";

export const runtime = "nodejs";
const maxBytes = 7 * 1024 * 1024;
const headers = { "Cache-Control": "no-store", "Referrer-Policy": "no-referrer" };

async function readBody(request: Request): Promise<Record<string, unknown>> {
  const url = new URL(request.url), host = request.headers.get("host") ?? url.host;
  const protocol = request.headers.get("x-forwarded-proto") ?? url.protocol.slice(0, -1);
  const origin = request.headers.get("origin"), forwarded = request.headers.get("x-forwarded-host");
  const site = request.headers.get("sec-fetch-site");
  if (url.search || !origin || (forwarded && forwarded !== host) || (site && site !== "same-origin") || !["http", "https"].includes(protocol) || origin !== new URL(`${protocol}://${host}`).origin || (protocol !== "https" && !["127.0.0.1", "localhost", "[::1]"].includes(new URL(origin).hostname))) throw new Error("Forbidden");
  if (request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json" || (request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity") || !request.body) throw new EncryptionRequestError("ENCRYPTION_INVALID");
  const length = request.headers.get("content-length");
  if (length && (!/^\d+$/.test(length) || Number(length) > maxBytes)) throw new EncryptionRequestError("ENCRYPTION_BUDGET");
  const reader = request.body.getReader(), chunks: Uint8Array[] = [];
  const signal = AbortSignal.any([request.signal, AbortSignal.timeout(30000)]);
  let stopping: Promise<void> | undefined;
  const cancel = () => { stopping ??= reader.cancel().catch(() => undefined); return stopping; };
  const onAbort = () => { void cancel(); };
  signal.addEventListener("abort", onAbort, { once: true });
  let bytes = 0;
  try {
    while (true) {
      if (signal.aborted) throw new EncryptionRequestError("ENCRYPTION_EXPIRED");
      const { value, done } = await reader.read();
      if (signal.aborted) throw new EncryptionRequestError("ENCRYPTION_EXPIRED");
      if (done) break;
      bytes += value.byteLength;
      if (bytes > maxBytes) throw new EncryptionRequestError("ENCRYPTION_BUDGET");
      chunks.push(value);
    }
    const value: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, bytes)));
    if (!value || typeof value !== "object" || Array.isArray(value)) throw new EncryptionRequestError("ENCRYPTION_INVALID");
    return value as Record<string, unknown>;
  } finally {
    signal.removeEventListener("abort", onAbort);
    await cancel(); reader.releaseLock();
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAppSession();
    const input = await readBody(request);
    const current = await requireAppSession();
    if (current.appSessionId !== session.appSessionId || current.memberId !== session.memberId || current.householdId !== session.householdId) throw new Error("Unauthorized");
    const operation = input.operation;
    const allowed = operation === "prepare" ? ["operation", "id", "kind", "expectedRevision", "candidateKeyRing", "candidateRecoveryPackage", "recoveryDigest", "candidateBackedUp"]
      : operation === "batch" || operation === "commit" ? ["operation", "id", "kind", "expectedRevision", "candidateCode", "candidateKeyRing", "candidateRecoveryPackage", "recoveryDigest", "candidateBackedUp", "encryption"]
        : operation === "abort" || operation === "query" ? ["operation", "id"] : ["operation"];
    if (Object.keys(input).some((key) => !allowed.includes(key))) throw new EncryptionRequestError("ENCRYPTION_INVALID");
    let result: unknown;
    switch (operation) {
      case "status": result = await getHouseholdEncryptionStatus(current); break;
      case "materials": result = await encryptionMaterials(current); break;
      case "prepare": result = await prepareEncryption(current, input); break;
      case "batch": result = await batchEncryption(current, input); break;
      case "commit": result = await commitEncryption(current, input); break;
      case "query": result = await queryEncryption(current, input); break;
      case "abort": result = await abortEncryption(current, input); break;
      default: throw new EncryptionRequestError("ENCRYPTION_INVALID");
    }
    return Response.json(result, { headers });
  } catch (error) {
    const code = error instanceof EncryptionRequestError ? error.code : error instanceof Error && error.message === "Unauthorized" ? "UNAUTHORIZED" : error instanceof Error && error.message === "Forbidden" ? "FORBIDDEN" : "ENCRYPTION_INVALID";
    return Response.json({ error: code }, { status: code === "UNAUTHORIZED" ? 401 : code === "FORBIDDEN" ? 403 : code === "ENCRYPTION_BUSY" || code === "ENCRYPTION_CHANGED" || code === "ENCRYPTION_EXPIRED" ? 409 : code === "ENCRYPTION_BUDGET" ? 413 : 400, headers });
  } finally {
    if (request.body && !request.body.locked) await request.body.cancel().catch(() => undefined);
  }
}
