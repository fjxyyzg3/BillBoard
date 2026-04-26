import { db } from "@/lib/db";

type SessionUser = {
  householdId: string;
  memberId: string;
};

export async function deleteTransaction(transactionId: string, sessionUser: SessionUser) {
  const [currentMember, transaction] = await Promise.all([
    db.householdMember.findFirst({
      where: {
        id: sessionUser.memberId,
        householdId: sessionUser.householdId,
      },
      select: { id: true },
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

  return db.transaction.update({
    where: { id: transaction.id },
    data: { deletedAt: new Date() },
    select: { id: true },
  });
}
