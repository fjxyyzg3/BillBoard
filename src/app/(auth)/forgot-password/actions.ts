"use server";

import { requestPasswordReset } from "@/lib/identity/account";
import { IdentityError, takeIdentityRateLimit } from "@/lib/identity/shared";
import { normalizeCredentialEmail } from "@/lib/auth/credentials";
import { after } from "next/server";
import { parseLocale } from "@/lib/i18n";
import type { IdentityFormResult } from "@/components/identity-types";

export async function requestPasswordResetAction(form: FormData): Promise<IdentityFormResult> {
  try {
    const email = normalizeCredentialEmail(form.get("email"));
    if (!email) return { ok: false, code: "INVALID_INPUT" };
    try { await takeIdentityRateLimit("public-mail", email); }
    catch (error) {
      if (error instanceof IdentityError && error.code === "RATE_LIMITED") return { ok: true, data: { message: "accepted" } };
      throw error;
    }
    const locale = parseLocale(form.get("locale"));
    after(async () => {
      try { await requestPasswordReset(email, locale); }
      catch { /* Public acceptance never reveals account or delivery state. */ }
    });
    return { ok: true, data: { message: "accepted" } };
  } catch (error) {
    return { ok: false, code: error instanceof IdentityError ? error.code : "SERVICE_UNAVAILABLE" };
  }
}
