"use server";

import { extractEncryption, withHouseholdEncryption } from "@/lib/encryption/request";

import { AppEventType, TransactionType } from "@prisma/client";
import { revalidatePath } from "next/cache";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { requireAppSession } from "@/lib/auth/session";
import { getMessages, getValidationMessage, parseLocale } from "@/lib/i18n";
import { recordAppEvent } from "@/lib/ops/record-event";
import { createTransaction } from "@/lib/transactions/create-transaction";
import { parseEntryContextFormValue } from "@/lib/transactions/entry-context";

export type CreateTransactionActionState =
  | { status: "idle" }
  | { status: "error"; message: string; conflict?: boolean }
  | {
    status: "success";
    transactionId: string;
    clientRequestId: string;
    amountFen: number;
    type: "income" | "expense";
  };

function toEventTransactionType(type: TransactionType) {
  return type === TransactionType.INCOME ? "income" : "expense";
}

export async function submitTransaction(
  _previousState: CreateTransactionActionState,
  formData: FormData,
): Promise<CreateTransactionActionState> {
  let started = false;
  try {
    return await withHouseholdEncryption(extractEncryption(formData), async () => {
      started = true;
      const locale = parseLocale(formData.get("locale"));
      const messages = getMessages(locale);
      let user: Awaited<ReturnType<typeof requireAppSession>>;
      let transaction: Awaited<ReturnType<typeof createTransaction>>;

      try {
        user = await requireAppSession();

        transaction = await createTransaction(
          {
            ...(formData.has("context") ? { context: parseEntryContextFormValue(formData.get("context")) } : {}),
            type: String(formData.get("type") ?? ""),
            amount: String(formData.get("amount") ?? ""),
            categoryId: String(formData.get("categoryId") ?? ""),
            actorMemberId: String(formData.get("actorMemberId") ?? ""),
            clientRequestId: String(formData.get("clientRequestId") ?? ""),
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
            message: getValidationMessage(error.issues[0]?.message, locale, "save"),
          };
        }

        return {
          status: "error",
          ...(error instanceof Error && error.message === "Transaction request conflicts with an existing transaction" ? { conflict: true } : {}),
          message:
            error instanceof Error
              ? getValidationMessage(error.message, locale, "save")
              : messages.actions.couldNotSave,
        };
      }

      const transactionType = toEventTransactionType(transaction.type);

      if (transaction.wasCreated) {
        await recordAppEvent({
          eventType: AppEventType.TRANSACTION_CREATED,
          householdId: user.householdId,
          memberId: user.memberId,
          metadata: { transactionType },
          summary: transactionType === "income" ? "新增收入记录" : "新增支出记录",
        }).catch(() => undefined);
      }

      for (const path of ["/home", "/records"]) {
        try {
          revalidatePath(path);
        } catch {
          // The transaction is already committed, so cache refresh failures must not report a save error.
        }
      }

      return {
        status: "success",
        transactionId: transaction.id,
        clientRequestId: transaction.clientRequestId,
        amountFen: transaction.amountFen,
        type: transactionType,
      };
    });
  } catch (error) {
    if (started) throw error;
    const locale = parseLocale(formData.get("locale"));
    const messages = getMessages(locale);
    if (error instanceof Error && error.message === "Unauthorized") {
      redirect("/login");
    }

    if (error instanceof ZodError) {
      return {
        status: "error",
        message: getValidationMessage(error.issues[0]?.message, locale, "save"),
      };
    }

    return {
      status: "error",
      ...(error instanceof Error && error.message === "Transaction request conflicts with an existing transaction" ? { conflict: true } : {}),
      message:
        error instanceof Error
          ? getValidationMessage(error.message, locale, "save")
          : messages.actions.couldNotSave,
    };
  }
}
