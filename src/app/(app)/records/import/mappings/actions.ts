"use server";

import { withHouseholdEncryption } from "@/lib/encryption/request";
import type { EncryptionInput } from "@/lib/encryption/types";

import { requireAppSession } from "@/lib/auth/session";
import {
  ImportCategoryMappingConflictError,
  saveManagedImportCategoryMappings,
} from "@/lib/imports/category-mapping-management";
import type { ManagedImportCategoryMappingChange } from "@/lib/imports/category-mapping-management";

type SaveResult =
  | { status: "saved"; mappings: Array<{ id: string; categoryId: string | null; updatedAt: string }> }
  | { status: "failed" | "conflict" };

export async function saveManagedImportMappings(
  changes: ManagedImportCategoryMappingChange[], encryption?: EncryptionInput
): Promise<SaveResult> {
  let started = false;
  try {
    return await withHouseholdEncryption(encryption, async () => {
      started = true;
      try {
        const sessionUser = await requireAppSession();
        if (!Array.isArray(changes) || changes.some((change) =>
          !change || typeof change !== "object" ||
          typeof change.id !== "string" || !change.id.trim() ||
          (change.categoryId !== null &&
            (typeof change.categoryId !== "string" || !change.categoryId.trim())) ||
          typeof change.expectedUpdatedAt !== "string" || !change.expectedUpdatedAt.trim(),
        )) {
          return { status: "failed" };
        }

        const mappings = await saveManagedImportCategoryMappings(changes, sessionUser);
        return { status: "saved", mappings };
      } catch (error) {
        return { status: error instanceof ImportCategoryMappingConflictError ? "conflict" : "failed" };
      }
    });
  } catch (error) {
    if (started) throw error;
    return { status: error instanceof ImportCategoryMappingConflictError ? "conflict" : "failed" };
  }
}
