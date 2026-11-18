import { requireAppSession } from "@/lib/auth/session";
import { parseRecordExportInput, RecordExportError, type RecordExportErrorCode } from "@/lib/exports/input";
import { generateRecordExport, recordExportError } from "@/lib/exports/service";
import { parseEncryptionInput } from "@/lib/encryption/request";
import { withHouseholdEncryptionResponse } from "@/lib/encryption/response";

export const runtime = "nodejs";

const privateHeaders = {
  "Cache-Control": "no-store",
  "Pragma": "no-cache",
  "X-Content-Type-Options": "nosniff",
  "Referrer-Policy": "no-referrer",
  "X-Robots-Tag": "noindex, nofollow, noarchive",
};
const statuses: Record<RecordExportErrorCode, number> = {
  unauthorized: 401, forbidden: 403, invalid_input: 400, busy: 429,
  too_large: 413, timeout: 504, cancelled: 499, unavailable: 503,
};

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") ?? new URL(request.url).host;
  const forwardedHost = request.headers.get("x-forwarded-host");
  const protocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.slice(0, -1);
  const site = request.headers.get("sec-fetch-site");
  if (!origin || (forwardedHost && forwardedHost !== host) || (site && site !== "same-origin") || !["https", "http"].includes(protocol)) {
    throw new RecordExportError("forbidden");
  }
  try {
    if (new URL(origin).origin !== origin || origin !== new URL(`${protocol}://${host}`).origin) throw new RecordExportError("forbidden");
  } catch { throw new RecordExportError("forbidden"); }
}

async function readInput(request: Request) {
  const declared = request.headers.get("content-length");
  if (new URL(request.url).search || request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase() !== "application/json"
    || (request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity")
    || (declared && (!/^\d+$/.test(declared) || Number(declared) > 4096)) || !request.body) throw new RecordExportError("invalid_input");
  const reader = request.body.getReader();
  const deadline = AbortSignal.timeout(10_000);
  const signal = AbortSignal.any([request.signal, deadline]);
  let stopping: Promise<void> | undefined;
  const cancel = () => { stopping ??= reader.cancel().catch(() => undefined); return stopping; };
  const onAbort = () => { void cancel(); };
  signal.addEventListener("abort", onAbort, { once: true });
  const chunks: Uint8Array[] = [];
  let size = 0;
  try {
    while (true) {
      if (signal.aborted) throw new RecordExportError(request.signal.aborted ? "cancelled" : "timeout");
      const next = await reader.read();
      if (next.done) break;
      size += next.value.byteLength;
      if (size > 4096) throw new RecordExportError("invalid_input");
      chunks.push(next.value);
    }
    if (signal.aborted) throw new RecordExportError(request.signal.aborted ? "cancelled" : "timeout");
    try {
      const parsed = JSON.parse(Buffer.concat(chunks).toString("utf8"));
      const encryption = parseEncryptionInput(parsed.encryption);
      delete parsed.encryption;
      return { input: parseRecordExportInput(parsed), encryption };
    }
    catch { throw new RecordExportError("invalid_input"); }
  } finally {
    signal.removeEventListener("abort", onAbort);
    await cancel();
    reader.releaseLock();
  }
}

async function session() {
  try { return await requireAppSession(); }
  catch { throw new RecordExportError("unauthorized"); }
}

export async function POST(request: Request) {
  let artifact: Awaited<ReturnType<typeof generateRecordExport>> | undefined;
  try {
    const original = await session();
    assertSameOrigin(request);
    const { input, encryption } = await readInput(request);
    return await withHouseholdEncryptionResponse(encryption, async (authorized) => {
      if (authorized.appSessionId !== original.appSessionId || authorized.memberId !== original.memberId) throw new RecordExportError("unauthorized");
      artifact = await generateRecordExport(original, input, { signal: request.signal });
      const current = await session();
      const download = await artifact.claim(current);
      return new Response(download.body, { headers: {
      ...privateHeaders,
      "Content-Type": "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "Content-Disposition": `attachment; filename="${artifact.filename}"`,
      "Content-Length": String(download.byteLength),
      } });
    });
  } catch (error) {
    await artifact?.dispose().catch(() => undefined);
    const mapped = request.signal.aborted ? new RecordExportError("cancelled") : recordExportError(error);
    return Response.json({ error: mapped.code }, {
      status: statuses[mapped.code], headers: { ...privateHeaders, ...(mapped.code === "busy" ? { "Retry-After": "2" } : {}) },
    });
  } finally {
    if (request.body && !request.body.locked) await request.body.cancel().catch(() => undefined);
  }
}
