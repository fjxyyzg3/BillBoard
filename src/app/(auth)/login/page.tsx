import { getPageMetadata } from "@/lib/page-metadata";
import { LanguageToggle } from "@/components/language-toggle";
import { LoginForm } from "@/components/login-form";
import { withAppBasePath } from "@/lib/base-path";
import { getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import { isOpsAdminInstance } from "@/lib/ops/config";
import { redirect } from "next/navigation";
import Link from "next/link";

type LoginPageProps = {
  searchParams?: Promise<Record<string, string | string[] | undefined>>;
};

export function generateMetadata() {
  return getPageMetadata((messages) => messages.login.title);
}

export default async function LoginPage({ searchParams }: LoginPageProps = {}) {
  if (isOpsAdminInstance()) {
    redirect("/ops");
  }

  const locale = await getServerLocale();
  const messages = getMessages(locale);
  const resolvedSearchParams = await searchParams;
  const reason = resolvedSearchParams?.reason;
  const sessionExpired =
    reason === "session-expired" ||
    (Array.isArray(reason) && reason.includes("session-expired"));

  return (
    <main className="mx-auto flex min-h-dvh w-full max-w-[27rem] flex-col justify-center px-5 py-10">
      <header className="mb-7 space-y-3">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <p className="text-base font-medium tracking-tight text-[var(--bb-primary)]">{messages.login.eyebrow}</p>
            <h1 className="text-2xl font-medium tracking-tight text-[var(--ios-text)]">
              {messages.login.title}
            </h1>
          </div>
          <LanguageToggle labels={messages.language} locale={locale} />
        </div>
        <p className="text-sm leading-6 text-[var(--ios-muted)]">{messages.login.description}</p>
      </header>
      {sessionExpired ? (
        <p className="mb-3 rounded-2xl border border-red-100 bg-red-50 px-4 py-3 text-sm text-[var(--ios-red)]">
          {messages.login.sessionExpired}
        </p>
      ) : null}
      <LoginForm authBasePath={withAppBasePath("/api/auth")} labels={messages.login}
        forIosInstall={resolvedSearchParams?.intent === "ios-install"} />
      {reason === "account-updated" ? <p className="mt-3 text-sm text-[var(--bb-muted)]" role="status">{messages.identity.reauthenticate}</p> : null}
      <Link className="mt-3 inline-flex min-h-11 items-center text-sm text-[var(--bb-muted)]" href="/forgot-password">{messages.identity.forgotPassword}</Link>
      <p className="mt-2 text-xs leading-5 text-[var(--bb-muted)]">{messages.identity.invitationOnly}</p>
      <Link className="mt-4 inline-flex min-h-11 items-center text-sm font-medium text-[var(--bb-primary)]" href="/help">{messages.nav.help}</Link>
    </main>
  );
}
