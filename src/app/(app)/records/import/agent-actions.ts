"use server";

import { withHouseholdEncryption } from "@/lib/encryption/request";
import type { EncryptionInput } from "@/lib/encryption/types";

import { requireAppSession } from "@/lib/auth/session";
import { getImportAgentSuggestions, type ImportAgentSuggestionResult } from "@/lib/imports/agent-suggestions";

export type { ImportAgentSuggestionResult } from "@/lib/imports/agent-suggestions";

export async function recommendImportMappings(
  draftId: string,
  mappingKeys: string[], encryption?: EncryptionInput
): Promise<ImportAgentSuggestionResult> {
  let started = false;
  try {
    return await withHouseholdEncryption(encryption, async () => {
      started = true;
      try {
        const sessionUser = await requireAppSession();
        const result = await getImportAgentSuggestions(draftId, mappingKeys, sessionUser);
        if (result.success) {
          const currentUser = await requireAppSession();
          if (currentUser.householdId !== sessionUser.householdId || currentUser.memberId !== sessionUser.memberId) {
            return { success: false, error: "STALE" };
          }
        }
        return result;
      } catch {
        return { success: false, error: "INVALID" };
      }
    });
  } catch (error) {
    if (started) throw error;
    return { success: false, error: "INVALID" };
  }
}
