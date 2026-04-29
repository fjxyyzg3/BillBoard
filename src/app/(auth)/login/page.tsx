import { LanguageToggle } from "@/components/language-toggle";
import { LoginForm } from "@/components/login-form";
import { getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";

export default async function LoginPage() {
  const locale = await getServerLocale();
  const messages = getMessages(locale);

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10">
      <header className="mb-8 space-y-2">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-2">
            <p className="text-sm font-medium text-[var(--ios-muted)]">{messages.login.eyebrow}</p>
            <h1 className="text-3xl font-semibold tracking-normal text-[var(--ios-text)]">
              {messages.login.title}
            </h1>
          </div>
          <LanguageToggle labels={messages.language} locale={locale} />
        </div>
        <p className="text-sm text-[var(--ios-muted)]">{messages.login.description}</p>
      </header>
      <LoginForm labels={messages.login} />
    </main>
  );
}
