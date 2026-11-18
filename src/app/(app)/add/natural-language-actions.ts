"use server";

import { withHouseholdEncryption } from "@/lib/encryption/request";
import type { EncryptionInput } from "@/lib/encryption/types";

import { redirect } from "next/navigation";
import { requireAppSession } from "@/lib/auth/session";
import { queryNaturalLanguageEntryForSession, submitNaturalLanguageEntryForSession } from "@/lib/transactions/natural-language-service";
import { type NaturalLanguageActionResult, type NaturalLanguageEntryInput } from "@/lib/transactions/natural-language-types";
import { entryContextSchema, type EntryContext } from "@/lib/transactions/entry-context";

export async function submitNaturalLanguageEntry(input: NaturalLanguageEntryInput, encryption?: EncryptionInput): Promise<NaturalLanguageActionResult> {
  let started = false;
  try {
    return await withHouseholdEncryption(encryption, async () => {
      started = true;
      try {
        const session = await requireAppSession();
        return await submitNaturalLanguageEntryForSession(input, session, requireAppSession);
      } catch (error) {
        if (error instanceof Error && error.message === "Unauthorized") redirect("/login");
        return { status: "unknown", requestId: typeof input?.requestId === "string" ? input.requestId : "" };
      }
    });
  } catch (error) {
    if (started) throw error;
    if (error instanceof Error && error.message === "Unauthorized") redirect("/login");
    return { status: "unknown", requestId: typeof input?.requestId === "string" ? input.requestId : "" };
  }
}

export async function queryNaturalLanguageEntry(requestId: string, resultVersion?: number, originalContext?: EntryContext, encryption?: EncryptionInput): Promise<NaturalLanguageActionResult> {
  let started = false;
  try {
    return await withHouseholdEncryption(encryption, async () => {
      started = true;
      try {
        const session = await requireAppSession();
        return await queryNaturalLanguageEntryForSession(requestId, resultVersion, session, originalContext ? entryContextSchema.parse(originalContext) : undefined);
      } catch (error) {
        if (error instanceof Error && error.message === "Unauthorized") redirect("/login");
        return { status: "unknown", requestId: typeof requestId === "string" ? requestId : "" };
      }
    }, { receiptQuery: true });
  } catch (error) {
    if (started) throw error;
    if (error instanceof Error && error.message === "Unauthorized") redirect("/login");
    return { status: "unknown", requestId: typeof requestId === "string" ? requestId : "" };
  }
}
