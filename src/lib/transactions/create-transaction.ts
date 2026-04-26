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

export async function createTransaction(input: unknown, sessionUser: SessionUser) {
  const parsed = createTransactionSchema.parse(input);

  const [createdByMember, actorMember, category] = await Promise.all([
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
  ]);

  if (!createdByMember) {
    throw new Error("Unauthorized");
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

  const transaction = await db.transaction.create({
    data: {
      householdId: sessionUser.householdId,
      type: typeMap[parsed.type],
      actorMemberId: actorMember.id,
      createdByMemberId: createdByMember.id,
      categoryId: category.id,
      amountFen: parsed.amount,
      occurredAt: parsed.occurredAt,
      note: parsed.note,
    },
    select: { amountFen: true, id: true, type: true },
  });

  return transaction;
}
