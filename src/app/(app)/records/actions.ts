"use server";

import { extractEncryption, withHouseholdEncryption } from "@/lib/encryption/request";

import { AppEventType, TransactionType } from "@prisma/client";
import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { requireAppSession } from "@/lib/auth/session";
import { getMessages, getValidationMessage, parseLocale } from "@/lib/i18n";
import { recordAppEvent } from "@/lib/ops/record-event";
import { deleteTransaction } from "@/lib/transactions/delete-transaction";
import { updateTransaction } from "@/lib/transactions/update-transaction";
import { parseEntryContextFormValue } from "@/lib/transactions/entry-context";

export type RecordEditorActionState = {
  status: "idle" | "error";
  message?: string;
};

const defaultRecordsHref = "/records?mode=month";

function getRecordsHref(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || value.length === 0) {
    return defaultRecordsHref;
  }

  try {
    const url = new URL(value, "https://billboard.local");

    if (url.pathname !== "/records") {
      return defaultRecordsHref;
    }

    url.searchParams.delete("perspective");
    return url.search ? `${url.pathname}${url.search}` : url.pathname;
  } catch {
    return defaultRecordsHref;
  }
}

function removeQueryParam(href: string, key: string) {
  const url = new URL(href, "https://billboard.local");

  url.searchParams.delete(key);

  return url.search ? `${url.pathname}${url.search}` : url.pathname;
}

function toEventTransactionType(type: TransactionType) {
  return type === TransactionType.INCOME ? "income" : "expense";
}

export async function submitRecordUpdate(
  _previousState: RecordEditorActionState,
  formData: FormData,
): Promise<RecordEditorActionState> {
  let started = false;
  try {
    return await withHouseholdEncryption(extractEncryption(formData), async () => {
      started = true;
      const locale = parseLocale(formData.get("locale"));
      const messages = getMessages(locale);
      const returnTo = removeQueryParam(getRecordsHref(formData.get("returnTo")), "record");

      try {
        const user = await requireAppSession();

        const transaction = await updateTransaction(
          String(formData.get("transactionId") ?? ""),
          {
            ...(formData.has("context") ? { context: parseEntryContextFormValue(formData.get("context")) } : {}),
            type: String(formData.get("type") ?? ""),
            amount: String(formData.get("amount") ?? ""),
            categoryId: String(formData.get("categoryId") ?? ""),
            actorMemberId: String(formData.get("actorMemberId") ?? ""),
            occurredAt: String(formData.get("occurredAt") ?? ""),
            note: String(formData.get("note") ?? ""),
            ...(formData.has("targetLedgerId") ? { targetLedgerId: String(formData.get("targetLedgerId") ?? "") } : {}),
          },
          user,
        );
        const transactionType = toEventTransactionType(transaction.type);

        await recordAppEvent({
          eventType: AppEventType.TRANSACTION_UPDATED,
          householdId: user.householdId,
          memberId: user.memberId,
          metadata: { transactionType },
          summary: transactionType === "income" ? "编辑收入记录" : "编辑支出记录",
        }).catch(() => undefined);
      } catch (error) {
        if (error instanceof Error && error.message === "Unauthorized") {
          redirect("/login");
        }

        if (error instanceof ZodError) {
          return {
            status: "error",
            message: error.issues[0]?.path[0] === "context"
              ? messages.ledgers.refreshRequired
              : getValidationMessage(error.issues[0]?.message, locale, "update"),
          };
        }

        return {
          status: "error",
          message:
            error instanceof Error
              ? getValidationMessage(error.message, locale, "update")
              : messages.actions.couldNotUpdate,
        };
      }

      redirect(returnTo);
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
        message: error.issues[0]?.path[0] === "context"
          ? messages.ledgers.refreshRequired
          : getValidationMessage(error.issues[0]?.message, locale, "update"),
      };
    }

    return {
      status: "error",
      message:
        error instanceof Error
          ? getValidationMessage(error.message, locale, "update")
          : messages.actions.couldNotUpdate,
    };
  }
}

export async function submitRecordDelete(
  _previousState: RecordEditorActionState,
  formData: FormData,
): Promise<RecordEditorActionState> {
  let started = false;
  try {
    return await withHouseholdEncryption(extractEncryption(formData), async () => {
      started = true;
      const locale = parseLocale(formData.get("locale"));
      const messages = getMessages(locale);
      const returnTo = removeQueryParam(getRecordsHref(formData.get("returnTo")), "record");

      try {
        const user = await requireAppSession();
        const originalContext = parseEntryContextFormValue(formData.get("context"));
        const transaction = originalContext
          ? await deleteTransaction(String(formData.get("transactionId") ?? ""), user, originalContext)
          : await deleteTransaction(String(formData.get("transactionId") ?? ""), user);
        const transactionType = toEventTransactionType(transaction.type);

        await recordAppEvent({
          eventType: AppEventType.TRANSACTION_DELETED,
          householdId: user.householdId,
          memberId: user.memberId,
          metadata: { transactionType },
          summary: transactionType === "income" ? "删除收入记录" : "删除支出记录",
        }).catch(() => undefined);
      } catch (error) {
        if (error instanceof Error && error.message === "Unauthorized") {
          redirect("/login");
        }

        return {
          status: "error",
          message:
            error instanceof Error
              ? getValidationMessage(error.message, locale, "delete")
              : messages.actions.couldNotDelete,
        };
      }

      redirect(returnTo);
    });
  } catch (error) {
    if (started) throw error;
    const locale = parseLocale(formData.get("locale"));
    const messages = getMessages(locale);
    if (error instanceof Error && error.message === "Unauthorized") {
      redirect("/login");
    }

    return {
      status: "error",
      message:
        error instanceof Error
          ? getValidationMessage(error.message, locale, "delete")
          : messages.actions.couldNotDelete,
    };
  }
}
