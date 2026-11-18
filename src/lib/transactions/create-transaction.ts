import { CategoryType, Prisma, TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { createTransactionSubmissionSchema } from "@/lib/transactions/schema";
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

const transactionSelection = {
  actorMemberId: true,
  amountFen: true,
  categoryId: true,
  clientRequestId: true,
  id: true,
  ledgerId: true,
  note: true,
  occurredAt: true,
  type: true,
} satisfies Prisma.TransactionSelect;

type SelectedTransaction = Prisma.TransactionGetPayload<{
  select: typeof transactionSelection;
}>;

function matchesRequest(
  transaction: SelectedTransaction,
  request: {
    actorMemberId: string;
    amountFen: number;
    categoryId: string;
    clientRequestId: string;
    note?: string;
    occurredAt: Date;
    type: TransactionType;
  },
) {
  return (
    transaction.actorMemberId === request.actorMemberId &&
    transaction.amountFen === request.amountFen &&
    transaction.categoryId === request.categoryId &&
    transaction.clientRequestId === request.clientRequestId &&
    transaction.note === (request.note ?? null) &&
    transaction.occurredAt.getTime() === request.occurredAt.getTime() &&
    transaction.type === request.type
  );
}

function toResult(transaction: SelectedTransaction, wasCreated: boolean) {
  if (!transaction.clientRequestId) {
    throw new Error("Transaction request ID is missing");
  }

  return {
    amountFen: transaction.amountFen,
    clientRequestId: transaction.clientRequestId,
    id: transaction.id,
    type: transaction.type,
    wasCreated,
  };
}

export async function createTransaction(input: unknown, sessionUser: SessionUser) {
  // Legacy payloads may only confirm a UUID that has already committed.
  const parsed = createTransactionSubmissionSchema.parse(input);
  if (parsed.context && (parsed.context.householdId !== sessionUser.householdId || parsed.context.memberId !== sessionUser.memberId)) throw new Error("Unauthorized");
  return db.$transaction(async (tx) => {
    let context = await resolveHouseholdContext(tx, sessionUser, { lock: true });
    const request = {
      actorMemberId: parsed.actorMemberId,
      amountFen: parsed.amount,
      categoryId: parsed.categoryId,
      clientRequestId: parsed.clientRequestId,
      note: parsed.note,
      occurredAt: parsed.occurredAt,
      type: typeMap[parsed.type],
    };
    const existing = await tx.transaction.findUnique({
      where: { createdByMemberId_clientRequestId: { clientRequestId: parsed.clientRequestId, createdByMemberId: context.memberId } },
      select: transactionSelection,
    });
    if (existing) {
      // Moving a record changes its ledger, while the original UUID still identifies it.
      if (!matchesRequest(existing, request)) throw new Error("Transaction request conflicts with an existing transaction");
      return toResult(existing, false);
    }
    if (!parsed.context) throw new Error("Entry context is required; refresh and select a ledger");
    if (parsed.context.ledgerId !== context.ledgerId) context = await resolveHouseholdContext(tx, sessionUser, { lock: true, ledgerId: parsed.context.ledgerId });
    if (!matchesEntryContext(parsed.context, context)) throw new Error("Unauthorized");
    const [actorMember, category] = await Promise.all([
      tx.householdMember.findFirst({
        where: {
          id: parsed.actorMemberId,
          householdId: context.householdId,
          leftAt: null,
          user: { status: "ACTIVE" },
        },
        select: { id: true },
      }),
      tx.category.findFirst({
        where: { id: parsed.categoryId, isActive: true },
        select: { id: true, type: true },
      }),
    ]);

    if (!actorMember) {
      throw new Error("Actor member must belong to the current household");
    }

    if (!category) {
      throw new Error("Category not found");
    }

    if (category.type !== categoryTypeMap[parsed.type]) {
      throw new Error("Category does not match transaction type");
    }

    const transaction = await tx.transaction.create({
      data: {
        householdId: context.householdId,
        ledgerId: context.ledgerId,
        type: request.type,
        actorMemberId: request.actorMemberId,
        createdByMemberId: context.memberId,
        clientRequestId: request.clientRequestId,
        categoryId: request.categoryId,
        amountFen: request.amountFen,
        occurredAt: request.occurredAt,
        note: request.note,
      },
      select: transactionSelection,
    });

    await recordLedgerAudit(tx, { context, action: "TRANSACTION_CREATED", targetId: transaction.id });
    return toResult(transaction, true);
  }, { maxWait: 10_000, timeout: 15_000 });
}
