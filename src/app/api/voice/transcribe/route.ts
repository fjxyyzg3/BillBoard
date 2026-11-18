import { requireAppSession } from "@/lib/auth/session";
import { resolveHouseholdContext } from "@/lib/auth/household-context";
import { db } from "@/lib/db";
import { entryContextSchema } from "@/lib/transactions/entry-context";
import { readVoiceBody, transcribeVoiceAudio, VoiceTranscriptionError, type VoiceTranscriptionErrorCode } from "@/lib/voice/transcribe";
import { MAX_VOICE_AUDIO_BYTES, validateVoiceWav } from "@/lib/voice/wav";
import { z } from "zod";
import { ProcessingConsentError } from "@/lib/processing/preferences";
import { admitVoiceRequest, bindVoiceInput, reserveVoiceUpload } from "@/lib/processing/voice-admission";
import { releaseResourceLease, ResourceBusyError, ResourceExpiredError, type ResourceLease } from "@/lib/resources/admission";
import { readEncryptionBody } from "@/lib/encryption/body";
import { extractEncryption, withHouseholdEncryption } from "@/lib/encryption/request";
import { EncryptionRequestError } from "@/lib/encryption/types";
import type { AppSessionUser } from "@/auth";

export const runtime = "nodejs";

const errorStatuses: Record<VoiceTranscriptionErrorCode, number> = {
  unauthorized: 401, forbidden: 403, context_required: 400, invalid_audio: 400, audio_too_large: 413,
  audio_too_long: 400, no_speech: 422, text_too_long: 422, rate_limited: 429,
  unavailable: 503, timeout: 504, cancelled: 499, consent_required: 403,
};

function assertSameOrigin(request: Request) {
  const origin = request.headers.get("origin");
  const host = request.headers.get("host") ?? new URL(request.url).host;
  const forwardedHost = request.headers.get("x-forwarded-host");
  const protocol = request.headers.get("x-forwarded-proto") ?? new URL(request.url).protocol.slice(0, -1);
  const site = request.headers.get("sec-fetch-site");
  // The ingress must preserve the public origin. Reject ambiguous forwarded hosts.
  if (!origin || (forwardedHost && forwardedHost !== host) || (site && site !== "same-origin")
    || !["https", "http"].includes(protocol)) throw new VoiceTranscriptionError("forbidden");
  try {
    if (new URL(origin).origin !== origin || origin !== new URL(`${protocol}://${host}`).origin) {
      throw new VoiceTranscriptionError("forbidden");
    }
  } catch { throw new VoiceTranscriptionError("forbidden"); }
}

async function session() {
  try { return await requireAppSession(); }
  catch { throw new VoiceTranscriptionError("unauthorized"); }
}

async function encryptedMultipart(request: Request, original: AppSessionUser, retain: (lease: ResourceLease) => void) {
  // Upload occupancy depends only on the authenticated family, not its financial key.
  const defaultTarget = await resolveHouseholdContext(db, original, { metadataOnly: true });
  const uploadContext = { householdId: original.householdId, memberId: original.memberId, ledgerId: defaultTarget.ledgerId };
  const lease = await reserveVoiceUpload(original, uploadContext, { deferCharge: true });
  retain(lease);
  const body = await readEncryptionBody(request, MAX_VOICE_AUDIO_BYTES + 16 * 1024, AbortSignal.any([request.signal, lease.signal])).catch((error) => {
    if (error instanceof EncryptionRequestError && error.code === "ENCRYPTION_BUDGET") throw new VoiceTranscriptionError("audio_too_large");
    if (error instanceof EncryptionRequestError && error.code === "ENCRYPTION_EXPIRED") throw new VoiceTranscriptionError("timeout");
    throw error;
  });
  const form = await new Response(new Uint8Array(body), { headers: { "Content-Type": request.headers.get("content-type")! } }).formData();
  for (const key of form.keys()) if (!["audio", "locale", "requestId", "context", "__householdEncryption"].includes(key) || form.getAll(key).length !== 1) throw new VoiceTranscriptionError("invalid_audio");
  const encryption = extractEncryption(form), file = form.get("audio"), requestId = form.get("requestId");
  if (!(file instanceof File) || file.size > MAX_VOICE_AUDIO_BYTES || file.type !== "audio/wav") throw new VoiceTranscriptionError(file instanceof File && file.size > MAX_VOICE_AUDIO_BYTES ? "audio_too_large" : "invalid_audio");
  if (!z.string().uuid().safeParse(requestId).success) throw new VoiceTranscriptionError("context_required");
  let context;
  try { context = entryContextSchema.parse(JSON.parse(String(form.get("context")))); }
  catch { throw new VoiceTranscriptionError("context_required"); }
  if (context.householdId !== original.householdId || context.memberId !== original.memberId) throw new VoiceTranscriptionError("unauthorized");
  const audio = new Uint8Array(await file.arrayBuffer()), audioError = validateVoiceWav(audio);
  if (audioError) throw new VoiceTranscriptionError(audioError);
  return withHouseholdEncryption(encryption, async (authorized) => {
    if (authorized.appSessionId !== original.appSessionId || authorized.memberId !== original.memberId) throw new VoiceTranscriptionError("unauthorized");
    const admitted = await admitVoiceRequest(original, context, String(requestId), audio, lease);
    const recheck = async () => {
      const current = await session();
      if (current.appSessionId !== original.appSessionId || current.memberId !== original.memberId) throw new VoiceTranscriptionError("unauthorized");
      await resolveHouseholdContext(db, current, { ledgerId: context.ledgerId });
    };
    await recheck();
    const text = await transcribeVoiceAudio(audio, AbortSignal.any([request.signal, lease.signal]));
    await recheck();
    if (request.signal.aborted) throw new VoiceTranscriptionError("cancelled");
    await bindVoiceInput(original, admitted.admissionId, audio, lease, text);
    return Response.json({ text, voiceAdmissionId: admitted.admissionId }, { headers: { "Cache-Control": "no-store" } });
  });
}

export async function POST(request: Request) {
  let lease: ResourceLease | undefined;
  let uploadTimer: ReturnType<typeof setTimeout> | undefined;
  const uploadTimeout = new AbortController();
  try {
    const original = await session();
    assertSameOrigin(request);
    if (request.headers.get("content-type")?.toLowerCase().startsWith("multipart/form-data;")) {
      if (new URL(request.url).search || (request.headers.get("content-encoding") && request.headers.get("content-encoding") !== "identity")) throw new VoiceTranscriptionError("invalid_audio");
      return await encryptedMultipart(request, original, (value) => { lease = value; });
    }
    return await withHouseholdEncryption(undefined, async () => {
    const rawContext = request.headers.get("X-Entry-Context");
    let originalContext;
    try { originalContext = rawContext ? entryContextSchema.parse(JSON.parse(rawContext)) : undefined; }
    catch { throw new VoiceTranscriptionError("unauthorized"); }
    if (!originalContext) throw new VoiceTranscriptionError("context_required");
    if (originalContext && (originalContext.householdId !== original.householdId || originalContext.memberId !== original.memberId)) throw new VoiceTranscriptionError("unauthorized");
    const target = await resolveHouseholdContext(db, original, { ledgerId: originalContext.ledgerId });
    if (request.signal.aborted) throw new VoiceTranscriptionError("cancelled");
    const contentType = request.headers.get("content-type")?.split(";", 1)[0].trim().toLowerCase();
    const encoding = request.headers.get("content-encoding");
    if (contentType !== "audio/wav" || (encoding && encoding !== "identity") || new URL(request.url).search) {
      throw new VoiceTranscriptionError("invalid_audio");
    }
    const contentLength = request.headers.get("content-length");
    if (contentLength && (!/^\d+$/.test(contentLength) || !Number.isSafeInteger(Number(contentLength)))) {
      throw new VoiceTranscriptionError("invalid_audio");
    }
    if (Number(contentLength) > MAX_VOICE_AUDIO_BYTES) throw new VoiceTranscriptionError("audio_too_large");
    const requestId = request.headers.get("X-Voice-Request-Id");
    if (!z.string().uuid().safeParse(requestId).success) throw new VoiceTranscriptionError("context_required");
    lease = await reserveVoiceUpload(original, originalContext);
    uploadTimer = setTimeout(() => uploadTimeout.abort(), 30_000);
    const audio = await readVoiceBody(request.body, MAX_VOICE_AUDIO_BYTES,
      AbortSignal.any([request.signal, uploadTimeout.signal, lease.signal]), "audio_too_large");
    clearTimeout(uploadTimer);
    const audioError = validateVoiceWav(audio);
    if (audioError) throw new VoiceTranscriptionError(audioError);
    // Upload occupancy does not accept an unfinished task or preserve an old choice.
    const admitted = await admitVoiceRequest(original, originalContext, requestId!, audio, lease);

    const recheck = async () => {
      const current = await session();
      if (current.id !== original.id || current.householdId !== original.householdId || current.memberId !== original.memberId) {
        throw new VoiceTranscriptionError("unauthorized");
      }
      try { await resolveHouseholdContext(db, current, { ledgerId: target.ledgerId }); }
      catch { throw new VoiceTranscriptionError("unauthorized"); }
    };
    await recheck();
    const text = await transcribeVoiceAudio(audio, AbortSignal.any([request.signal, lease.signal]));
    await recheck();
    if (request.signal.aborted) throw new VoiceTranscriptionError("cancelled");
    await bindVoiceInput(original, admitted.admissionId, audio, lease, text);
    return Response.json({ text, voiceAdmissionId: admitted.admissionId }, { headers: { "Cache-Control": "no-store" } });
    });
  } catch (error) {
    const code = request.signal.aborted ? "cancelled" : uploadTimeout.signal.aborted ? "timeout"
      : error instanceof ProcessingConsentError ? "consent_required" : error instanceof ResourceBusyError ? "rate_limited"
        : error instanceof ResourceExpiredError || lease?.signal.aborted ? "timeout"
          : error instanceof Error && error.message === "Unauthorized" ? "unauthorized"
            : error instanceof VoiceTranscriptionError ? error.code : "unavailable";
    return Response.json({ error: code }, { status: errorStatuses[code], headers: { "Cache-Control": "no-store" } });
  } finally {
    clearTimeout(uploadTimer);
    if (request.body && !request.body.locked) await request.body.cancel().catch(() => undefined);
    if (lease) await releaseResourceLease(lease).catch(() => undefined);
  }
}
