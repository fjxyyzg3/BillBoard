import { getPageMetadata } from "@/lib/page-metadata";
import Link from "next/link";
import { getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";
import { ProcessingPreferencesForm } from "@/components/processing-preferences-form";

export function generateMetadata() {
  return getPageMetadata((messages) => messages.safeguards.privacy.title);
}

export default async function PrivacyPage() {
  const locale = await getServerLocale();
  const labels = getMessages(locale).safeguards.privacy;
  return <article className="max-w-3xl space-y-5 py-6">
    <h1 className="text-2xl font-medium">{labels.title}</h1>
    <div className="ios-panel space-y-4 p-5 md:p-6">{[labels.intro, labels.retained, labels.suppliers].map((text) => <p className="text-sm leading-7 text-[var(--bb-muted)]" key={text}>{text}</p>)}</div>
    <ProcessingPreferencesForm locale={locale} />
    <section className="ios-panel space-y-3 p-5 md:p-6"><h2 className="text-[15px] font-medium">{labels.deletionTitle}</h2><p className="text-sm leading-7 text-[var(--bb-muted)]">{labels.deletion}</p></section>
    <Link className="inline-flex min-h-11 items-center text-sm underline" href="/account">{labels.back}</Link>
  </article>;
}
