import { createHash } from "node:crypto";
import type { Prisma } from "@prisma/client";
import type { AppSessionUser } from "@/lib/auth/app-sessions";
import { resolveHouseholdContext, type HouseholdSession } from "@/lib/auth/household-context";
import { db } from "@/lib/db";
import { acquireResourceLease, assertResourceLease, chargeResourceLease, type ResourceLease } from "@/lib/resources/admission";
import type { EntryContext } from "@/lib/transactions/entry-context";
import { normalizeNaturalLanguageText } from "@/lib/transactions/natural-language-protocol";
import { VoiceTranscriptionError } from "@/lib/voice/transcribe";
import { validateVoiceWav } from "@/lib/voice/wav";
import { requireProcessingConsent } from "./preferences";

const transactionOptions = { maxWait: 5_000, timeout: 10_000 };
export class VoiceAdmissionError extends Error {
  constructor(readonly code: "CONFLICT" | "EXPIRED") { super(code); }
}
const digest = (value: Uint8Array | string) => createHash("sha256").update(value).digest("hex");

export async function reserveVoiceUpload(session: AppSessionUser, context: EntryContext, options: { deferCharge?: boolean } = {}): Promise<ResourceLease> {
  return db.$transaction(async (tx) => {
    await resolveHouseholdContext(tx, session, { lock: true, ledgerId: context.ledgerId, metadataOnly: true });
    await requireProcessingConsent(tx, session, { ai: true, voice: true });
    return acquireResourceLease(tx, session, "voice", { ledgerId: context.ledgerId, deferCharge: options.deferCharge });
  }, transactionOptions);
}

function assertVoiceLeaseIdentity(session: AppSessionUser, lease: ResourceLease) {
  if (lease.kind !== "voice" || lease.householdId !== session.householdId || lease.memberId !== session.memberId) {
    throw new VoiceAdmissionError("CONFLICT");
  }
}

async function assertVoiceLease(tx: Prisma.TransactionClient, session: AppSessionUser, lease: ResourceLease) {
  assertVoiceLeaseIdentity(session, lease);
  await assertResourceLease(tx, lease);
}

export async function admitVoiceRequest(
  session: AppSessionUser, context: EntryContext, requestId: string, audio: Uint8Array, uploadLease?: ResourceLease,
) {
  const audioError = validateVoiceWav(audio);
  if (audioError) throw new VoiceTranscriptionError(audioError);
  return db.$transaction(async (tx) => {
    await resolveHouseholdContext(tx, session, { lock: true, ledgerId: context.ledgerId });
    await requireProcessingConsent(tx, session, { ai: true, voice: true });
    const key = { householdId: session.householdId, memberId: session.memberId, clientRequestId: requestId };
    if (await tx.voiceProcessingAdmission.findUnique({ where: { householdId_memberId_clientRequestId: key } })
      || await tx.naturalLanguageRequest.findUnique({ where: { householdId_createdByMemberId_clientRequestId: {
        householdId: session.householdId, createdByMemberId: session.memberId, clientRequestId: requestId,
      } } })) throw new VoiceAdmissionError("CONFLICT");
    const lease = uploadLease ?? await acquireResourceLease(tx, session, "voice", { ledgerId: context.ledgerId });
    if (uploadLease) {
      assertVoiceLeaseIdentity(session, lease);
      await chargeResourceLease(tx, session, lease);
    }
    await assertVoiceLease(tx, session, lease);
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    await tx.voiceProcessingAdmission.deleteMany({ where: { householdId: session.householdId, expiresAt: { lte: now } } });
    const admission = await tx.voiceProcessingAdmission.create({ data: {
      ...key, userId: session.id, appSessionId: session.appSessionId, ledgerId: context.ledgerId,
      audioHash: digest(audio), expiresAt: new Date(now.getTime() + 180_000),
    } });
    return { admissionId: admission.id, lease };
  }, transactionOptions);
}

export async function bindVoiceInput(
  session: AppSessionUser, admissionId: string, audio: Uint8Array, lease: ResourceLease, text?: string,
) {
  return db.$transaction(async (tx) => {
    const target = await tx.voiceProcessingAdmission.findUnique({ where: { id: admissionId } });
    if (!target || target.appSessionId !== session.appSessionId || target.userId !== session.id
      || target.householdId !== session.householdId || target.memberId !== session.memberId) throw new Error("Unauthorized");
    await resolveHouseholdContext(tx, session, { lock: true, ledgerId: target.ledgerId });
    await assertVoiceLease(tx, session, lease);
    await tx.$queryRaw`SELECT id FROM "VoiceProcessingAdmission" WHERE id = ${admissionId} FOR UPDATE`;
    const admission = await tx.voiceProcessingAdmission.findUniqueOrThrow({ where: { id: admissionId } });
    const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
    if (admission.expiresAt <= now) throw new VoiceAdmissionError("EXPIRED");
    const audioHash = digest(audio);
    if (admission.consumedAt || admission.audioHash !== audioHash) throw new VoiceAdmissionError("CONFLICT");
    const textHash = text === undefined ? undefined : digest(normalizeNaturalLanguageText(text));
    if (admission.textHash && admission.textHash !== textHash) throw new VoiceAdmissionError("CONFLICT");
    if (textHash) await tx.voiceProcessingAdmission.update({ where: { id: admissionId }, data: { textHash } });
  }, transactionOptions);
}

export async function consumeVoiceAdmission(
  tx: Prisma.TransactionClient, session: HouseholdSession & { id: string },
  input: { admissionId: string; requestId: string; text: string; ledgerId: string },
): Promise<Date> {
  await tx.$queryRaw`SELECT id FROM "VoiceProcessingAdmission" WHERE id = ${input.admissionId} FOR UPDATE`;
  const admission = await tx.voiceProcessingAdmission.findUnique({ where: { id: input.admissionId } });
  const [{ now }] = await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS "now"`;
  if (!admission || admission.appSessionId !== session.appSessionId || admission.userId !== session.id
    || admission.householdId !== session.householdId || admission.memberId !== session.memberId
    || admission.ledgerId !== input.ledgerId || admission.clientRequestId !== input.requestId
    || !admission.audioHash || admission.textHash !== digest(normalizeNaturalLanguageText(input.text)) || admission.consumedAt) {
    throw new VoiceAdmissionError("CONFLICT");
  }
  if (admission.expiresAt <= now) throw new VoiceAdmissionError("EXPIRED");
  await tx.voiceProcessingAdmission.update({ where: { id: admission.id }, data: { consumedAt: now } });
  return admission.expiresAt;
}
