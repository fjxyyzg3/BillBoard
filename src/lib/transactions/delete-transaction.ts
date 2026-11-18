import { db } from "@/lib/db";
import { resolveHouseholdContext, type HouseholdSession } from "@/lib/auth/household-context";
import { entryContextSchema, matchesEntryContext, type EntryContext } from "./entry-context";
import { recordLedgerAudit } from "./audit";

type SessionUser = HouseholdSession;

export async function deleteTransaction(transactionId: string, sessionUser: SessionUser, originalContext?: EntryContext) {
  if (!originalContext) throw new Error("Entry context is required; refresh and select a ledger");
  const parsed = entryContextSchema.safeParse(originalContext);
  if (!parsed.success || parsed.data.householdId !== sessionUser.householdId || parsed.data.memberId !== sessionUser.memberId) throw new Error("Unauthorized");
  return db.$transaction(async (tx) => {
    const context = await resolveHouseholdContext(tx, sessionUser, { lock: true, ledgerId: parsed.data.ledgerId });
    if (!matchesEntryContext(parsed.data, context)) throw new Error("Unauthorized");
    const transaction = await tx.transaction.findFirst({
        where: {
          id: transactionId,
          householdId: sessionUser.householdId,
          ledgerId: context.ledgerId,
          deletedAt: null,
        },
        select: { id: true, type: true },
      });

    if (!transaction) {
      throw new Error("Transaction not found");
    }

    const [deletedTransaction] = await tx.transaction.updateManyAndReturn({
      where: {
        id: transaction.id,
        householdId: sessionUser.householdId,
        ledgerId: context.ledgerId,
        deletedAt: null,
      },
      data: { deletedAt: new Date() },
      select: { id: true, type: true },
    });

    if (!deletedTransaction) {
      throw new Error("Transaction not found");
    }

    await recordLedgerAudit(tx, { context, action: "TRANSACTION_DELETED", targetId: deletedTransaction.id });
    return deletedTransaction;
  }, { maxWait: 10_000, timeout: 15_000 });
}
