import type { Route } from "@playwright/test";
import { getToken } from "next-auth/jwt";
import { z } from "zod";
import { loadValidAppSessionUser } from "../../src/lib/auth/app-sessions";
import { admitVoiceRequest, bindVoiceInput } from "../../src/lib/processing/voice-admission";
import { releaseResourceLease } from "../../src/lib/resources/admission";
import { entryContextSchema } from "../../src/lib/transactions/entry-context";
import { validateVoiceWav } from "../../src/lib/voice/wav";

function assertDevelopmentRequest(url: string) {
  const database = new URL(process.env.DATABASE_URL ?? "");
  const target = new URL(url);
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(database.hostname)
    || !/_(?:dev|test)$/.test(database.pathname) || target.origin !== "http://127.0.0.1:2501"
    || target.pathname !== "/api/voice/transcribe" || target.search) {
    throw new Error("Voice admission fixtures require the local E2E server and development/test database");
  }
}

export async function prepareVoiceTranscription(route: Route) {
  const request = route.request();
  assertDevelopmentRequest(request.url());
  const headers = await request.allHeaders();
  if (request.method() !== "POST" || headers["content-type"] !== "audio/wav" || headers.origin !== "http://127.0.0.1:2501") {
    throw new Error("Voice fixture received an invalid transcription request");
  }
  const secret = process.env.AUTH_SECRET;
  if (!secret) throw new Error("Voice fixtures require the configured development auth secret");
  const token = await getToken({ req: { headers }, secret, secureCookie: false });
  if (typeof token?.appSessionId !== "string" || typeof token.sub !== "string") throw new Error("Voice fixture requires an authenticated browser request");
  const session = await loadValidAppSessionUser(token.appSessionId);
  if (!session || session.id !== token.sub) throw new Error("Voice fixture session is no longer valid");
  const context = entryContextSchema.parse(JSON.parse(headers["x-entry-context"] ?? "null"));
  if (context.householdId !== session.householdId || context.memberId !== session.memberId) throw new Error("Voice fixture context does not match its session");
  const requestId = z.string().uuid().parse(headers["x-voice-request-id"]);
  const audio = request.postDataBuffer();
  if (!audio || validateVoiceWav(audio)) throw new Error("Voice fixture requires the production WAV encoder output");
  const admitted = await admitVoiceRequest(session, context, requestId, audio);
  try { await bindVoiceInput(session, admitted.admissionId, audio, admitted.lease); }
  catch (error) { await releaseResourceLease(admitted.lease); throw error; }
  let fulfilled = false;
  return {
    async fulfill(text: string) {
      if (fulfilled) throw new Error("A transcription fixture can only finish once");
      fulfilled = true;
      try {
        // Only ASR text is synthetic; consent, identity, audio binding and continuation remain real.
        await bindVoiceInput(session, admitted.admissionId, audio, admitted.lease, text);
        await route.fulfill({ json: { text, voiceAdmissionId: admitted.admissionId }, headers: { "Cache-Control": "no-store" } });
      } finally { await releaseResourceLease(admitted.lease); }
    },
  };
}

export async function fulfillVoiceTranscription(route: Route, text: string) {
  await (await prepareVoiceTranscription(route)).fulfill(text);
}
