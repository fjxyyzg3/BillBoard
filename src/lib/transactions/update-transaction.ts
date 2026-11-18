import { CategoryType, TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { updateTransactionPayloadSchema } from "@/lib/transactions/schema";
import { resolveHouseholdContext, type HouseholdSession } from "@/lib/auth/household-context";
import { matchesEntryContext } from "./entry-context";
import { recordLedgerAudit } from "./audit";

type SessionUser = HouseholdSession;

const typeMap = {
  income: TransactionType.INCOME,
  expense: TransactionType.EXPENSE,
} as const;

const categoryTypeMap = {
  income: CategoryType.INCOME,
  expense: CategoryType.EXPENSE,
} as const;

export async function updateTransaction(
  transactionId: string,
  input: unknown,
  sessionUser: SessionUser,
) {
  const parsed = updateTransactionPayloadSchema.parse(input);
  if (parsed.context.householdId !== sessionUser.householdId || parsed.context.memberId !== sessionUser.memberId) throw new Error("Unauthorized");
  return db.$transaction(async (tx) => {
    const context = await resolveHouseholdContext(tx, sessionUser, { lock: true, ledgerId: parsed.context.ledgerId });
    if (!matchesEntryContext(parsed.context, context)) throw new Error("Unauthorized");
    const target = parsed.targetLedgerId && parsed.targetLedgerId !== context.ledgerId
      ? await resolveHouseholdContext(tx, sessionUser, { lock: true, ledgerId: parsed.targetLedgerId })
      : context;
    const transaction = await tx.transaction.findFirst({
      where: {
        id: transactionId,
        householdId: context.householdId,
        ledgerId: context.ledgerId,
        deletedAt: null,
      },
      select: { id: true, actorMemberId: true, categoryId: true, type: true },
    });
    if (!transaction) throw new Error("Transaction not found");
    const type = parsed.type ?? (transaction.type === TransactionType.INCOME ? "income" : "expense");
    const [actorMember, category] = await Promise.all([
      tx.householdMember.findFirst({
        where: {
          id: parsed.actorMemberId ?? transaction.actorMemberId,
          householdId: sessionUser.householdId,
        },
        select: { id: true, leftAt: true, user: { select: { status: true } } },
      }),
      tx.category.findUnique({
        where: { id: parsed.categoryId ?? transaction.categoryId },
        select: { id: true, type: true },
      }),
    ]);

    if (!actorMember) {
      throw new Error("Actor member must belong to the current household");
    }
    if (actorMember.id !== transaction.actorMemberId && (actorMember.leftAt !== null || actorMember.user.status !== "ACTIVE")) {
      throw new Error("Actor member must belong to the current household");
    }

    if (!category) {
      throw new Error("Category not found");
    }

    if (category.type !== categoryTypeMap[type]) {
      throw new Error("Category does not match transaction type");
    }

    const [updatedTransaction] = await tx.transaction.updateManyAndReturn({
      where: {
        id: transaction.id,
        householdId: sessionUser.householdId,
        ledgerId: context.ledgerId,
        deletedAt: null,
      },
      data: {
        ledgerId: target.ledgerId,
        type: typeMap[type],
        actorMemberId: actorMember.id,
        categoryId: category.id,
        amountFen: parsed.amount,
        occurredAt: parsed.occurredAt,
        note: Object.hasOwn(parsed, "note") ? parsed.note ?? null : undefined,
      },
      select: { id: true, type: true },
    });

    if (!updatedTransaction) {
      throw new Error("Transaction not found");
    }

    if (target.ledgerId !== context.ledgerId) {
      await tx.ledgerAuditLog.create({ data: {
        householdId: context.householdId, memberId: context.memberId, ledgerId: target.ledgerId,
        action: "TRANSACTION_MOVED", targetId: updatedTransaction.id,
      } });
    } else {
      await recordLedgerAudit(tx, { context, action: "TRANSACTION_UPDATED", targetId: updatedTransaction.id });
    }
    return updatedTransaction;
  }, { maxWait: 10_000, timeout: 15_000 });
}
