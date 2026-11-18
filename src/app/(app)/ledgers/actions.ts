"use server";

import { extractEncryption, withHouseholdEncryption } from "@/lib/encryption/request";

import { revalidatePath } from "next/cache";
import { ZodError } from "zod";
import { requireAppSession } from "@/lib/auth/session";
import { archiveLedger, createLedger, renameLedger, restoreLedger, setDefaultLedger } from "@/lib/ledgers/service";

export type LedgerActionResult = { ok: true } | { ok: false; code: "INVALID_INPUT" | "UNAVAILABLE" | "FORBIDDEN" | "DEFAULT_REQUIRED" | "UNAUTHORIZED" | "FAILED" };

export async function manageLedgerAction(form: FormData): Promise<LedgerActionResult> {
  let started = false;
  try {
    return await withHouseholdEncryption(extractEncryption(form), async () => {
      started = true;
      try {
        const session = await requireAppSession();
        const ledgerId = String(form.get("ledgerId") ?? "");
        const name = String(form.get("name") ?? "");
        switch (form.get("operation")) {
          case "create": await createLedger({ name }, session); break;
          case "rename": await renameLedger({ ledgerId, name }, session); break;
          case "default": await setDefaultLedger({ ledgerId }, session); break;
          case "archive": await archiveLedger({ ledgerId }, session); break;
          case "restore": await restoreLedger({ ledgerId }, session); break;
          default: return { ok: false, code: "INVALID_INPUT" };
        }
        revalidatePath("/", "layout");
        return { ok: true };
      } catch (error) {
        if (error instanceof ZodError) return { ok: false, code: "INVALID_INPUT" };
        const message = error instanceof Error ? error.message : "";
        return {
          ok: false, code: message === "Unauthorized" ? "UNAUTHORIZED" : message === "Forbidden" ? "FORBIDDEN"
            : message === "Cannot archive the default ledger" ? "DEFAULT_REQUIRED" : message === "Ledger is unavailable" ? "UNAVAILABLE" : "FAILED"
        };
      }
    });
  } catch (error) {
    if (started) throw error;
    if (error instanceof ZodError) return { ok: false, code: "INVALID_INPUT" };
    const message = error instanceof Error ? error.message : "";
    return {
      ok: false, code: message === "Unauthorized" ? "UNAUTHORIZED" : message === "Forbidden" ? "FORBIDDEN"
        : message === "Cannot archive the default ledger" ? "DEFAULT_REQUIRED" : message === "Ledger is unavailable" ? "UNAVAILABLE" : "FAILED"
    };
  }
}
