import { AppEventType } from "@prisma/client";
import { revalidatePath } from "next/cache";
import type { AppSessionUser } from "@/lib/auth/app-sessions";
import { recordAppEvent } from "@/lib/ops/record-event";
import { createNaturalLanguageEntry, getNaturalLanguageEntry } from "./natural-language-entry";
import { NATURAL_LANGUAGE_RESULT_VERSION, type NaturalLanguageActionResult } from "./natural-language-types";
import type { EntryContext } from "./entry-context";

type SessionUser = Pick<AppSessionUser, "id" | "householdId" | "memberId"> & { appSessionId?: string };

async function refreshSavedPages() {
  for (const path of ["/home", "/records"]) {
    try { revalidatePath(path); }
    catch { /* Cache invalidation cannot change an already committed outcome. */ }
  }
}

export async function submitNaturalLanguageEntryForSession(
  input: unknown, session: SessionUser, recheckSession: () => Promise<SessionUser>,
): Promise<NaturalLanguageActionResult> {
  if (!input || typeof input !== "object" || !("resultVersion" in input) || input.resultVersion !== NATURAL_LANGUAGE_RESULT_VERSION) {
    return { status: "unknown", requestId: input && typeof input === "object" && "requestId" in input && typeof input.requestId === "string" ? input.requestId : "" };
  }
  const outcome = await createNaturalLanguageEntry(input, session, recheckSession);
  if (outcome.result.status === "success") {
    if (outcome.wasCreated) {
      for (const [transactionType, count, summary] of [
        ["income", outcome.result.incomeCount, "新增收入记录"],
        ["expense", outcome.result.expenseCount, "新增支出记录"],
      ] as const) {
        if (count > 0) await recordAppEvent({
          eventType: AppEventType.TRANSACTION_CREATED, householdId: session.householdId, memberId: session.memberId,
          summary, metadata: { transactionType, count },
        }).catch(() => undefined);
      }
    }
    await refreshSavedPages();
  }
  return outcome.result;
}

export async function queryNaturalLanguageEntryForSession(
  requestId: string, resultVersion: number | undefined, session: SessionUser, originalContext?: EntryContext,
): Promise<NaturalLanguageActionResult> {
  if (resultVersion !== NATURAL_LANGUAGE_RESULT_VERSION) return { status: "unknown", requestId: typeof requestId === "string" ? requestId : "" };
  const result = await getNaturalLanguageEntry(requestId, session, originalContext);
  if (result.status === "success") await refreshSavedPages();
  return result;
}
