
import type { ReactNode } from "react";
import packageJson from "../../package.json";
import { AppFiltersProvider } from "@/components/app-filters-provider";
import { AndroidUpdateProvider } from "@/components/android-update-provider";
import { DesktopUpdateProvider } from "@/components/desktop-update-provider";
import { NaturalLanguageProvider } from "@/components/natural-language-provider";
import { BillAnalysisProvider } from "@/components/bill-analysis-provider";
import { LedgerProvider, type LedgerCatalog } from "@/components/ledger-provider";
import { LedgerSwitcher } from "@/components/ledger-switcher";
import { ProcessingProvider } from "@/components/processing-provider";
import type { ProcessingChoices } from "@/lib/processing/types";
import { VoiceAccountingProvider } from "@/components/voice-accounting-provider";
import { BottomNav } from "@/components/bottom-nav";
import { DesktopNav } from "@/components/desktop-nav";
import { MobileUtilities } from "@/components/mobile-utilities";
import { formatAppVersion } from "@/lib/app-version";
import { getMessages } from "@/lib/i18n";

export type AppShellViewProps = {
  locale: import("@/lib/i18n").Locale;
  children: ReactNode;
  currentMemberId: string;
  catalog: LedgerCatalog;
  initialPreference?: string;
  initialProcessing?: ProcessingChoices;
};

export function AppShellView({ children, currentMemberId, catalog, initialPreference, initialProcessing, locale }: AppShellViewProps) {
  const messages = getMessages(locale);
  const versionLabel = formatAppVersion(packageJson.version);

  return (
    <AppFiltersProvider locale={locale}>
      <LedgerProvider catalog={catalog} initialPreference={initialPreference}>
      <ProcessingProvider initialChoices={initialProcessing} locale={locale} key={`processing:${catalog.identity.householdId}:${currentMemberId}`}>
      <BillAnalysisProvider identity={catalog.identity} locale={locale} key={`analysis:${catalog.identity.householdId}:${currentMemberId}`}>
      <NaturalLanguageProvider currentMemberId={currentMemberId} locale={locale} key={`${catalog.identity.householdId}:${currentMemberId}`}>
        <VoiceAccountingProvider locale={locale}>
          <AndroidUpdateProvider locale={locale}>
          <DesktopUpdateProvider locale={locale}>
          <div className="mx-auto flex min-h-dvh w-full max-w-[1440px] md:flex-row">
            <a className="sr-only rounded-lg bg-[var(--bb-surface)] px-4 py-3 text-sm font-medium text-[var(--bb-ink)] shadow-[var(--bb-shadow-lg)] focus:not-sr-only focus:fixed focus:left-4 focus:top-[calc(1rem+env(safe-area-inset-top))] focus:z-[100]" href="#main-content">
              {messages.ui.skipToContent}
            </a>
            <DesktopNav
              labels={{ app: messages.app, language: messages.language, nav: messages.nav }}
              locale={locale}
              versionLabel={versionLabel}
            />
            <div className="flex min-h-dvh min-w-0 flex-1 flex-col">
              <div className="flex min-w-0 items-center justify-between gap-3 px-5 pt-[calc(0.75rem+env(safe-area-inset-top))] sm:px-6 md:px-[min(2.25rem,36px)] md:pt-6">
                <LedgerSwitcher locale={locale} />
                <MobileUtilities locale={locale} versionLabel={versionLabel} />
              </div>
              <main className="min-w-0 flex-1 px-5 pb-[calc(var(--bb-mobile-nav-height)+1.5rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 md:px-[min(2.25rem,36px)] md:pb-9 md:pt-7" id="main-content" tabIndex={-1}>
                {children}
              </main>
              <BottomNav
                labels={messages.nav}
                navigationLabel={messages.ui.mainNavigation}
              />
            </div>
          </div>
          </DesktopUpdateProvider>
          </AndroidUpdateProvider>
        </VoiceAccountingProvider>
      </NaturalLanguageProvider>
      </BillAnalysisProvider>
      </ProcessingProvider>
      </LedgerProvider>
    </AppFiltersProvider>
  );
}
