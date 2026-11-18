import { getPageMetadata } from "@/lib/page-metadata";
import Link from "next/link";
import { redirect } from "next/navigation";
import { IdentityField, IdentityForm } from "@/components/identity-form";
import { LanguageToggle } from "@/components/language-toggle";
import { getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import { isOpsAdminInstance } from "@/lib/ops/config";
import { requestPasswordResetAction } from "./actions";

export function generateMetadata() {
  return getPageMetadata((messages) => messages.identity.forgotTitle);
}

export default async function ForgotPasswordPage() {
  if (isOpsAdminInstance()) redirect("/ops");
  const locale = await getServerLocale();
  const messages = getMessages(locale);
  const labels = messages.identity;
  return <main className="mx-auto flex min-h-dvh w-full max-w-[27rem] flex-col justify-center space-y-6 px-5 py-10">
    <div className="flex items-center justify-between gap-3"><p className="text-base font-medium text-[var(--bb-primary)]">{messages.app.brand}</p><LanguageToggle labels={messages.language} locale={locale} /></div>
    <header className="space-y-2"><h1 className="text-2xl font-medium text-[var(--bb-ink)]">{labels.forgotTitle}</h1><p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.forgotDescription}</p></header>
    <section className="ios-panel p-5"><IdentityForm action={requestPasswordResetAction} labels={labels} submitLabel={labels.requestReset}><input name="locale" type="hidden" value={locale} /><IdentityField autoComplete="email" label={labels.email} maxLength={254} name="email" type="email" /></IdentityForm></section>
    <Link className="inline-flex min-h-11 items-center text-sm text-[var(--bb-muted)]" href="/login">{labels.backToLogin}</Link>
  </main>;
}
