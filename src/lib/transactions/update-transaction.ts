import { CategoryType, TransactionType } from "@prisma/client";
import { db } from "@/lib/db";
import { createTransactionSchema } from "@/lib/transactions/schema";

type SessionUser = {
  householdId: string;
  memberId: string;
};

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
  const parsed = createTransactionSchema.parse(input);

  const [currentMember, actorMember, category, transaction] = await Promise.all([
    db.householdMember.findFirst({
      where: {
        id: sessionUser.memberId,
        householdId: sessionUser.householdId,
      },
      select: { id: true },
    }),
    db.householdMember.findFirst({
      where: {
        id: parsed.actorMemberId,
        householdId: sessionUser.householdId,
      },
      select: { id: true },
    }),
    db.category.findUnique({
      where: { id: parsed.categoryId },
      select: { id: true, type: true },
    }),
    db.transaction.findFirst({
      where: {
        id: transactionId,
        householdId: sessionUser.householdId,
        deletedAt: null,
      },
      select: { id: true },
    }),
  ]);

  if (!currentMember) {
    throw new Error("Unauthorized");
  }

  if (!transaction) {
    throw new Error("Transaction not found");
  }

  if (!actorMember) {
    throw new Error("Actor member must belong to the current household");
  }

  if (!category) {
    throw new Error("Category not found");
  }

  if (category.type !== categoryTypeMap[parsed.type]) {
    throw new Error("Category does not match transaction type");
  }

  return db.transaction.update({
    where: { id: transaction.id },
    data: {
      type: typeMap[parsed.type],
      actorMemberId: actorMember.id,
      categoryId: category.id,
      amountFen: parsed.amount,
      occurredAt: parsed.occurredAt,
      note: parsed.note ?? null,
    },
    select: { id: true },
  });
}
