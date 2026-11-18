import type { Prisma } from "@prisma/client";

type AuditContext = { householdId: string; memberId: string; ledgerId: string };
type AuditAction = "TRANSACTION_CREATED" | "TRANSACTION_UPDATED" | "TRANSACTION_DELETED" | "IMPORT_CONFIRMED";

export async function recordLedgerAudit(
  transaction: Prisma.TransactionClient,
  input: { context: AuditContext; action: AuditAction; targetId: string | string[] },
) {
  const targets = typeof input.targetId === "string" ? [input.targetId] : input.targetId;
  if (targets.length === 0) return;
  await transaction.ledgerAuditLog.createMany({
    data: targets.map((targetId) => ({
      householdId: input.context.householdId,
      memberId: input.context.memberId,
      ledgerId: input.context.ledgerId,
      action: input.action,
      targetId,
    })),
  });
}
