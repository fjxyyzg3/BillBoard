import { randomUUID } from "node:crypto";
import { Prisma, type AppEventType } from "@prisma/client";
import { physicalDb } from "@/lib/db";
import { encryptRow } from "@/lib/encryption/protected-models";
import { assertEncryptionContext, getEncryptionContext, type EncryptionRequestContext } from "@/lib/encryption/request-context";
import {
  canExposeAppEventBusiness,
  sanitizeAppEventMetadata,
  sanitizeAppEventPath,
  sanitizeAppEventSummary,
  type AppEventMetadataInput,
} from "@/lib/ops/event-metadata";

const appEventRetentionDays = 90;
const appEventRetentionMs = appEventRetentionDays * 24 * 60 * 60 * 1000;

function liveContext(context: EncryptionRequestContext) {
  try { assertEncryptionContext(context); return true; }
  catch { return false; }
}

async function currentSession(transaction: Prisma.TransactionClient, context: EncryptionRequestContext) {
  const appNow = new Date();
  const sessions = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT id FROM "AppSession"
    WHERE id=${context.session.appSessionId} AND user_id=${context.session.id} AND member_id=${context.session.memberId}
      AND revoked_at IS NULL AND expires_at>GREATEST(clock_timestamp(), ${appNow})
  `;
  return sessions.length > 0 && liveContext(context);
}

async function deleteExpiredEvents(transaction: Prisma.TransactionClient, cutoff: Date) {
  // Do not wait on another family's conversion or invert the household lock order.
  const households = await transaction.$queryRaw<Array<{ id: string }>>`
    SELECT h.id FROM "Household" h
    WHERE EXISTS (SELECT 1 FROM "AppEvent" e WHERE e.household_id = h.id AND e.created_at < ${cutoff})
    ORDER BY h.id FOR UPDATE OF h SKIP LOCKED
  `;
  const ids = households.map((household) => household.id);
  const operations = ids.length ? await transaction.householdEncryption.findMany({
    where: { householdId: { in: ids }, activeOperationId: { not: null } },
    select: { householdId: true },
  }) : [];
  const active = new Set(operations.map((operation) => operation.householdId));
  await transaction.appEvent.deleteMany({
    where: { createdAt: { lt: cutoff }, OR: [{ householdId: null }, { householdId: { in: ids.filter((id) => !active.has(id)) } }] },
  });
}

export type RecordAppEventInput = {
  eventType: AppEventType;
  householdId?: string | null;
  memberId?: string | null;
  metadata?: AppEventMetadataInput | null;
  now?: Date;
  path?: string | null;
  summary?: string | null;
};

export async function recordAppEvent(input: RecordAppEventInput) {
  try {
    const createdAt = input.now ?? new Date();
    const cutoff = new Date(createdAt.getTime() - appEventRetentionMs);
    const metadata = sanitizeAppEventMetadata(input.metadata);
    const path = sanitizeAppEventPath(input.path);
    const summary = sanitizeAppEventSummary(input.summary);
    let context: EncryptionRequestContext | undefined;
    let invalidContext = false;
    try { context = getEncryptionContext(); }
    catch { invalidContext = true; }

    await physicalDb.$transaction(async (transaction) => {
      const householdId = input.householdId ?? null;
      const memberId = householdId ? input.memberId ?? null : null;
      if (householdId) await transaction.$queryRaw`SELECT id FROM "Household" WHERE id = ${householdId} FOR UPDATE`;
      const config = householdId ? await transaction.householdEncryption.findUnique({ where: { householdId } }) : null;
      const matchesContext = !!context && !invalidContext && liveContext(context)
        && context.session.householdId === householdId && context.session.memberId === memberId;
      if (matchesContext) {
        await transaction.$queryRaw`
          SELECT m.id FROM "HouseholdMember" m JOIN "User" u ON u.id = m.user_id
          WHERE m.id = ${memberId} AND m.household_id = ${householdId} FOR UPDATE OF m, u
        `;
        await transaction.$queryRaw`SELECT id FROM "AppSession" WHERE id = ${context!.session.appSessionId} FOR SHARE`;
      }
      const member = memberId ? await transaction.householdMember.findFirst({
        where: { id: memberId, householdId: householdId! },
        select: { userId: true, leftAt: true, user: { select: { status: true } }, household: { select: { closedAt: true } } },
      }) : null;
      if (memberId && !member) return;
      const authorizedContext = matchesContext && member?.userId === context!.session.id
        && member.leftAt === null && member.user.status === "ACTIVE" && member.household.closedAt === null
        && await currentSession(transaction, context!);
      const sameConfig = authorizedContext && context!.revision === (config?.revision ?? 0)
        && context!.configMode === (config?.mode ?? "UNENCRYPTED");
      const canWritePlaintext = canExposeAppEventBusiness(config) && !invalidContext
        && (!context || (sameConfig && context.mode === "UNENCRYPTED" && liveContext(context)));
      let data: Prisma.AppEventUncheckedCreateInput = {
        id: randomUUID(), createdAt, eventType: input.eventType, householdId, memberId, path,
        summary: canWritePlaintext ? summary : null,
        metadata: canWritePlaintext ? metadata ?? Prisma.DbNull : Prisma.DbNull,
      };
      if (sameConfig && config?.mode === "ENCRYPTED" && !config.activeOperationId
        && context!.mode === "ENCRYPTED" && context!.ring?.householdId === householdId
        && context!.ring.generation === config.generation && context!.ring.currentKeyVersion === config.keyVersion
        && liveContext(context!)) {
        try {
          const protectedRow = await encryptRow("appEvent", { ...data, summary, metadata: metadata ?? null }, context!.ring, householdId!, "");
          if (liveContext(context!)) data = { ...data, encryptedPayload: String(protectedRow.encryptedPayload), encryptionRevision: String(protectedRow.encryptionRevision) };
        } catch {
          // Auditing cannot require a new key upload or retry an already successful business operation.
        }
      }
      await transaction.appEvent.create({ data });
      await deleteExpiredEvents(transaction, cutoff);
      if (context && (canWritePlaintext || data.encryptedPayload) && !await currentSession(transaction, context)) {
        // A late audit keeps its generic receipt without retaining an expired request's business content.
        await transaction.appEvent.update({ where: { id: data.id }, data: {
          summary: null, metadata: Prisma.DbNull, encryptedPayload: null, encryptionRevision: null,
        } });
      }
    }, { timeout: 5000, maxWait: 3000 });
  } catch {
    return undefined;
  }
}
