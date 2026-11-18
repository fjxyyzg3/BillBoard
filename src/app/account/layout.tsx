import type { ReactNode } from "react";
import Link from "next/link";
import { redirect } from "next/navigation";
import { IdentityAccountNav } from "@/components/identity-account-nav";
import { LanguageToggle } from "@/components/language-toggle";
import { requireAccountSession } from "@/lib/auth/session";
import { getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import { isOpsAdminInstance } from "@/lib/ops/config";
import { signOutAccountAction } from "./actions";
import { EncryptionLogoutForm } from "@/components/encryption-lifecycle";
import { DesktopAccountSafety } from "@/components/desktop-account-safety";

export default async function AccountLayout({ children }: { children: ReactNode }) {
  if (isOpsAdminInstance()) redirect("/ops");
  const session = await requireAccountSession().catch((error) => {
    if (error instanceof Error && error.message === "Unauthorized") redirect("/login?reason=session-expired");
    throw error;
  });
  const locale = await getServerLocale();
  const messages = getMessages(locale);
  return <main className="mx-auto min-h-dvh w-full max-w-5xl px-4 py-5 sm:px-6 md:py-8">
    <DesktopAccountSafety identity={JSON.stringify([session.id, session.householdId ?? "", session.memberId ?? ""])} locale={locale} />
    <header className="mb-5 flex flex-wrap items-center justify-between gap-3">
      <Link className="flex min-h-11 items-center text-lg font-semibold text-[var(--bb-primary)]" href="/home">{messages.app.brand}</Link>
      <div className="flex items-center gap-4"><LanguageToggle labels={messages.language} locale={locale} /><EncryptionLogoutForm action={signOutAccountAction} locale={locale}><button className="min-h-11 text-sm text-[var(--bb-muted)]" type="submit">{messages.identity.logout}</button></EncryptionLogoutForm></div>
    </header>
    <IdentityAccountNav hasHousehold={Boolean(session.householdId && session.memberId)} labels={messages.identity} />
    {children}
  </main>;
}
