"use client";

import { requestAccessApplicationAction } from "@/app/help/actions";
import { getMessages, type Locale } from "@/lib/i18n";
import { IdentityField, IdentityForm } from "./identity-form";

export function AccessApplication({ locale }: { locale: Locale }) {
  const messages = getMessages(locale);
  const labels = messages.accessApplication;
  return <section aria-labelledby="access-application-title" className="mt-8 scroll-mt-6 ios-panel p-5 sm:p-6" id="apply">
    <div className="grid items-start gap-6 md:grid-cols-2 md:gap-10">
      <div className="space-y-3">
        <h2 className="text-base font-medium" id="access-application-title">{labels.title}</h2>
        <p className="text-sm leading-7 text-[var(--bb-muted)]">{labels.description}</p>
        <p className="text-xs leading-6 text-[var(--bb-muted)]">{labels.help}</p>
      </div>
      <IdentityForm action={requestAccessApplicationAction} cooldown={{ seconds: 60, label: labels.retryIn }} labels={messages.identity} submitLabel={labels.submit} successMessage={labels.accepted}>
        <input name="locale" type="hidden" value={locale} />
        <IdentityField autoComplete="email" label={labels.email} maxLength={254} name="email" type="email" />
        <div className="space-y-2">
          <label className="block space-y-2">
            <span className="text-sm font-medium text-[var(--bb-ink)]">{labels.note}</span>
            <textarea aria-describedby="access-application-note-help" className="ios-field min-h-24 w-full resize-y" maxLength={80} name="note" rows={3} />
          </label>
          <p className="text-xs leading-6 text-[var(--bb-muted)]" id="access-application-note-help">{labels.noteHelp}</p>
        </div>
      </IdentityForm>
    </div>
  </section>;
}
