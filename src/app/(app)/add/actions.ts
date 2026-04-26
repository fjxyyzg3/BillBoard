"use server";

import { redirect } from "next/navigation";
import { isRedirectError } from "next/dist/client/components/redirect-error";
import { ZodError } from "zod";
import { requireAppSession } from "@/lib/auth/session";
import { createTransaction } from "@/lib/transactions/create-transaction";

export type CreateTransactionActionState = {
  status: "idle" | "error";
  message?: string;
};

export async function submitTransaction(
  _previousState: CreateTransactionActionState,
  formData: FormData,
): Promise<CreateTransactionActionState> {
  try {
    const user = await requireAppSession();

    const transaction = await createTransaction(
      {
        type: String(formData.get("type") ?? ""),
        amount: String(formData.get("amount") ?? ""),
        categoryId: String(formData.get("categoryId") ?? ""),
        actorMemberId: String(formData.get("actorMemberId") ?? ""),
        occurredAt: String(formData.get("occurredAt") ?? ""),
        note: String(formData.get("note") ?? ""),
      },
      user,
    );

    const params = new URLSearchParams({
      amountFen: String(transaction.amountFen),
      created: "1",
      type: transaction.type === "INCOME" ? "income" : "expense",
    });

    redirect(`/add?${params.toString()}`);
  } catch (error) {
    if (isRedirectError(error)) {
      throw error;
    }

    if (error instanceof Error && error.message === "Unauthorized") {
      redirect("/login");
    }

    if (error instanceof ZodError) {
      return {
        status: "error",
        message: error.issues[0]?.message ?? "Could not save the transaction",
      };
    }

    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not save the transaction",
    };
  }
}
