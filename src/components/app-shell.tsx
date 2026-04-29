import type { ReactNode } from "react";
import packageJson from "../../package.json";
import { AppFiltersProvider } from "@/components/app-filters-provider";
import { BottomNav } from "@/components/bottom-nav";
import { DesktopNav } from "@/components/desktop-nav";
import { formatAppVersion } from "@/lib/app-version";
import { getMessages } from "@/lib/i18n";
import { getServerLocale } from "@/lib/i18n-server";

type AppShellProps = {
  children: ReactNode;
};

export async function AppShell({ children }: AppShellProps) {
  const locale = await getServerLocale();
  const messages = getMessages(locale);
  const versionLabel = formatAppVersion(packageJson.version);

  return (
    <AppFiltersProvider>
      <div className="mx-auto flex min-h-screen w-full max-w-7xl bg-[var(--ios-bg)] md:flex-row">
        <DesktopNav
          labels={{ app: messages.app, language: messages.language, nav: messages.nav }}
          locale={locale}
          versionLabel={versionLabel}
        />
        <div className="flex min-h-screen min-w-0 flex-1 flex-col">
          <main className="min-w-0 flex-1 px-4 pb-[calc(8.75rem+env(safe-area-inset-bottom))] pt-5 sm:px-6 md:px-8 md:py-8">
            {children}
          </main>
          <BottomNav
            labels={{ language: messages.language, nav: messages.nav }}
            locale={locale}
            versionLabel={versionLabel}
          />
        </div>
      </div>
    </AppFiltersProvider>
  );
}
