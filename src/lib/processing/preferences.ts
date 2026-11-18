import type { Prisma } from "@prisma/client";
import { z } from "zod";
import type { AccountSessionUser } from "@/lib/auth/app-sessions";
import { resolveHouseholdContext, type HouseholdSession } from "@/lib/auth/household-context";
import { db } from "@/lib/db";
import { requireLockedAccount } from "@/lib/identity/shared";
import type { ProcessingChoices } from "./types";

export class ProcessingConsentError extends Error {
  readonly code = "CONSENT_REQUIRED";
  constructor() { super("Processing choice is required"); }
}

const choicesSchema = z.object({ ai: z.boolean(), voice: z.boolean() }).strict();
const transactionOptions = { maxWait: 5_000, timeout: 10_000 };

export function processingServices(): ProcessingChoices["services"] {
  return { primary: "wheelmaker", speechConfigured: Boolean(process.env.VOLCENGINE_ASR_API_KEY?.trim()) };
}

export async function getProcessingPreferences(session: AccountSessionUser): Promise<ProcessingChoices> {
  return db.$transaction(async (tx) => {
    const user = await requireLockedAccount(tx, session);
    return { ai: user.aiProcessingEnabled, voice: user.voiceProcessingEnabled, services: processingServices() };
  }, transactionOptions);
}

export async function setProcessingPreferences(session: AccountSessionUser, input: unknown, signal?: AbortSignal): Promise<ProcessingChoices> {
  signal?.throwIfAborted();
  const choices = choicesSchema.parse(input);
  return db.$transaction(async (tx) => {
    const user = await requireLockedAccount(tx, session);
    signal?.throwIfAborted();
    const changes = [
      ["AI", user.aiProcessingEnabled, choices.ai], ["VOICE", user.voiceProcessingEnabled, choices.voice],
    ] as const;
    await tx.user.update({ where: { id: user.id }, data: { aiProcessingEnabled: choices.ai, voiceProcessingEnabled: choices.voice } });
    for (const [capability, before, after] of changes) {
      if (before !== after) await tx.identityAuditLog.create({ data: {
        action: `${capability}_PROCESSING_${after ? "ENABLED" : "DISABLED"}`, actorUserId: user.id, targetId: user.id,
      } });
    }
    signal?.throwIfAborted();
    return { ...choices, services: processingServices() };
  }, transactionOptions);
}

export async function requireProcessingConsent(
  tx: Prisma.TransactionClient, session: HouseholdSession, capabilities: { ai: boolean; voice?: boolean },
): Promise<void> {
  const context = await resolveHouseholdContext(tx, session, { lock: true, metadataOnly: true });
  const user = await tx.user.findUnique({ where: { id: context.userId }, select: { aiProcessingEnabled: true, voiceProcessingEnabled: true } });
  if (!user || (capabilities.ai && !user.aiProcessingEnabled) || (capabilities.voice && !user.voiceProcessingEnabled)) {
    throw new ProcessingConsentError();
  }
}
