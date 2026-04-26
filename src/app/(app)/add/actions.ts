"use server";

import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { requireAppSession } from "@/lib/auth/session";
import { createTransaction } from "@/lib/transactions/create-transaction";

export type CreateTransactionActionState = {
  status: "idle" | "error";
  message?: string;
};

export const initialCreateTransactionState: CreateTransactionActionState = {
  status: "idle",
};

export async function submitTransaction(
  _previousState: CreateTransactionActionState,
  formData: FormData,
): Promise<CreateTransactionActionState> {
  try {
    const user = await requireAppSession();

    await createTransaction(
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
  } catch (error) {
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

  redirect("/add?created=1");
}
