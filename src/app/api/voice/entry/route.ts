import { z } from "zod";
import { requireAppSession } from "@/lib/auth/session";
import { queryNaturalLanguageEntryForSession, submitNaturalLanguageEntryForSession } from "@/lib/transactions/natural-language-service";
import { entryContextSchema } from "@/lib/transactions/entry-context";
import { getHouseholdEncryptionStatus, parseEncryptionInput, withHouseholdEncryption } from "@/lib/encryption/request";

export const runtime = "nodejs";

const maxBodyBytes = 16 * 1024;
const errorStatuses = { unauthorized: 401, forbidden: 403, invalid_request: 400, payload_too_large: 413, timeout: 408, cancelled: 499, unavailable: 503 };
type ErrorCode = keyof typeof errorStatuses;
class EntryRequestError extends Error {
  constructor(readonly code: ErrorCode) { super(code); }
}

function json(value: unknown, status = 200) {
  return Response.json(value, { status, headers: { "Cache-Control": "no-store" } });
}

function failure(error: unknown) {
  const code = error instanceof EntryRequestError ? error.code
    : error instanceof Error && error.message === "Unauthorized" ? "unauthorized" : "unavailable";
  return json({ error: code }, errorStatuses[code]);
}

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") ?? new URL(request.url).host;
  const forwardedHost = request.headers.get("x-forwarded-host");
  const protocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.slice(0, -1);
  const site = request.headers.get("sec-fetch-site");
  if ((forwardedHost && forwardedHost !== host) || (site && site !== "same-origin") || !["https", "http"].includes(protocol)) {
    throw new EntryRequestError("forbidden");
  }
  // Same-origin GET fetches omit Origin. Require fetch metadata and a custom header instead.
  if (request.method === "GET" && (site !== "same-origin" || request.headers.get("x-requested-with") !== "XMLHttpRequest")) {
    throw new EntryRequestError("forbidden");
  }
  if (!origin) {
    if (request.method === "GET" && origin === null) return;
    throw new EntryRequestError("forbidden");
  }
  try {
    if (new URL(origin).origin !== origin || origin !== new URL(`${protocol}://${host}`).origin) throw new EntryRequestError("forbidden");
  } catch { throw new EntryRequestError("forbidden"); }
}

async function readInput(request: Request): Promise<unknown> {
  const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
  const encoding = request.headers.get("content-encoding");
  const contentLength = request.headers.get("content-length");
  if (contentType !== "application/json" || (encoding && encoding !== "identity") || new URL(request.url).search
    || (contentLength && (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength))))) {
    throw new EntryRequestError("invalid_request");
  }
  if (Number(contentLength) > maxBodyBytes) throw new EntryRequestError("payload_too_large");
  if (!request.body) throw new EntryRequestError("invalid_request");
  const timeout = new AbortController();
  const timer = setTimeout(() => timeout.abort(), 30_000);
  const signal = AbortSignal.any([request.signal, timeout.signal]);
  const reader = request.body.getReader();
  let stopping: Promise<void> | undefined;
  const cancel = () => { stopping ??= reader.cancel().catch(() => undefined); return stopping; };
  const abort = () => { void cancel(); };
  signal.addEventListener("abort", abort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    if (signal.aborted) throw new EntryRequestError("cancelled");
    while (true) {
      const { done, value } = await reader.read();
      if (signal.aborted) throw new EntryRequestError(request.signal.aborted ? "cancelled" : "timeout");
      if (done) break;
      size += value.byteLength;
      if (size > maxBodyBytes) throw new EntryRequestError("payload_too_large");
      chunks.push(value);
    }
    try {
      const input: unknown = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.concat(chunks, size)));
      if (!input || typeof input !== "object" || Array.isArray(input)) throw new EntryRequestError("invalid_request");
      return input;
    } catch { throw new EntryRequestError("invalid_request"); }
  } catch (error) {
    await cancel();
    throw error;
  } finally {
    clearTimeout(timer);
    signal.removeEventListener("abort", abort);
    reader.releaseLock();
  }
}

export async function POST(request: Request) {
  try {
    const session = await requireAppSession();
    assertSameOrigin(request);
    const input = await readInput(request) as Record<string, unknown>;
    const encryption = parseEncryptionInput(input.encryption);
    delete input.encryption;
    const current = await requireAppSession();
    if (current.id !== session.id || current.householdId !== session.householdId || current.memberId !== session.memberId) {
      throw new EntryRequestError("unauthorized");
    }
    if (request.signal.aborted) throw new EntryRequestError("cancelled");
    return await withHouseholdEncryption(encryption, async (authorized) => {
      if (authorized.appSessionId !== session.appSessionId) throw new EntryRequestError("unauthorized");
      if (input.operation === "query") {
        if (Object.keys(input).some((key) => !["operation", "requestId", "resultVersion", "context"].includes(key)) || !z.string().uuid().safeParse(input.requestId).success || !Number.isSafeInteger(input.resultVersion) || Number(input.resultVersion) < 0) throw new EntryRequestError("invalid_request");
        const context = entryContextSchema.parse(input.context);
        return json(await queryNaturalLanguageEntryForSession(String(input.requestId), Number(input.resultVersion), session, context));
      }
      return json(await submitNaturalLanguageEntryForSession(input, session, requireAppSession));
    }, { receiptQuery: input.operation === "query" });
  } catch (error) {
    return failure(error);
  } finally {
    if (request.body && !request.body.locked) await request.body.cancel().catch(() => undefined);
  }
}

export async function GET(request: Request) {
  try {
    const session = await requireAppSession();
    assertSameOrigin(request);
    if ((await getHouseholdEncryptionStatus(session)).mode !== "UNENCRYPTED") throw new EntryRequestError("invalid_request");
    const params = new URL(request.url).searchParams;
    const requestId = params.get("requestId");
    const version = params.get("resultVersion");
    if ([...params.keys()].length !== 2 || !z.string().uuid().safeParse(requestId).success
      || !version || !/^\d+$/.test(version) || !Number.isSafeInteger(Number(version))) {
      throw new EntryRequestError("invalid_request");
    }
    const rawContext = request.headers.get("X-Entry-Context");
    let originalContext;
    try { originalContext = rawContext ? entryContextSchema.parse(JSON.parse(rawContext)) : undefined; }
    catch { throw new EntryRequestError("invalid_request"); }
    return await withHouseholdEncryption(undefined, async () => json(await queryNaturalLanguageEntryForSession(requestId!, Number(version), session, originalContext)), { receiptQuery: true });
  } catch (error) { return failure(error); }
}
