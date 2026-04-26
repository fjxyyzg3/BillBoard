"use server";

import { redirect } from "next/navigation";
import { ZodError } from "zod";
import { requireAppSession } from "@/lib/auth/session";
import { deleteTransaction } from "@/lib/transactions/delete-transaction";
import { updateTransaction } from "@/lib/transactions/update-transaction";

export type RecordEditorActionState = {
  status: "idle" | "error";
  message?: string;
};

export const initialRecordEditorState: RecordEditorActionState = {
  status: "idle",
};

const defaultRecordsHref = "/records?range=last-30-days";

function getRecordsHref(value: FormDataEntryValue | null) {
  if (typeof value !== "string" || value.length === 0) {
    return defaultRecordsHref;
  }

  try {
    const url = new URL(value, "https://billboard.local");

    if (url.pathname !== "/records") {
      return defaultRecordsHref;
    }

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

export async function submitRecordUpdate(
  _previousState: RecordEditorActionState,
  formData: FormData,
): Promise<RecordEditorActionState> {
  const returnTo = getRecordsHref(formData.get("returnTo"));

  try {
    const user = await requireAppSession();

    await updateTransaction(
      String(formData.get("transactionId") ?? ""),
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
        message: error.issues[0]?.message ?? "Could not update the record",
      };
    }

    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not update the record",
    };
  }

  redirect(returnTo);
}

export async function submitRecordDelete(
  _previousState: RecordEditorActionState,
  formData: FormData,
): Promise<RecordEditorActionState> {
  const returnTo = removeQueryParam(getRecordsHref(formData.get("returnTo")), "record");

  try {
    const user = await requireAppSession();

    await deleteTransaction(String(formData.get("transactionId") ?? ""), user);
  } catch (error) {
    if (error instanceof Error && error.message === "Unauthorized") {
      redirect("/login");
    }

    return {
      status: "error",
      message: error instanceof Error ? error.message : "Could not delete the record",
    };
  }

  redirect(returnTo);
}
