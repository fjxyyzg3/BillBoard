"use server";

import { after } from "next/server";
import type { IdentityFormResult } from "@/components/identity-types";
import { parseLocale } from "@/lib/i18n";
import { confirmAccessApplication, prepareAccessApplication } from "@/lib/identity/access-applications";
import { IdentityError } from "@/lib/identity/shared";
import { isOpsAdminInstance } from "@/lib/ops/config";

export async function requestAccessApplicationAction(form: FormData): Promise<IdentityFormResult> {
  if (isOpsAdminInstance()) return { ok: false, code: "FORBIDDEN" };
  try {
    const note = form.get("note");
    if (note !== null && typeof note !== "string") throw new IdentityError("INVALID_INPUT");
    const prepared = await prepareAccessApplication({ email: String(form.get("email") ?? ""), locale: parseLocale(form.get("locale")), note });
    after(async () => {
      try { await prepared.deliver(); }
      catch { /* Public acceptance never reveals account, application, or delivery state. */ }
    });
    return { ok: true, data: { message: "accepted" } };
  } catch (error) {
    if (error instanceof IdentityError && error.code === "RATE_LIMITED") return { ok: true, data: { message: "accepted" } };
    return { ok: false, code: error instanceof IdentityError && ["INVALID_INPUT", "APPLICATION_NOTE_TOO_LONG"].includes(error.code) ? error.code : "SERVICE_UNAVAILABLE" };
  }
}

export async function confirmAccessApplicationAction(token: string): Promise<IdentityFormResult> {
  if (isOpsAdminInstance()) return { ok: false, code: "FORBIDDEN" };
  try {
    await confirmAccessApplication(token);
    return { ok: true, data: { message: "saved" } };
  } catch (error) {
    return { ok: false, code: error instanceof IdentityError ? error.code : "SERVICE_UNAVAILABLE" };
  }
}
