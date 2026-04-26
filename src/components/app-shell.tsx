import type { ReactNode } from "react";
import packageJson from "../../package.json";
import { AppFiltersProvider } from "@/components/app-filters-provider";
import { BottomNav } from "@/components/bottom-nav";
import { DesktopNav } from "@/components/desktop-nav";
import { formatAppVersion } from "@/lib/app-version";

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  const versionLabel = formatAppVersion(packageJson.version);

  return (
    <AppFiltersProvider>
      <div className="mx-auto flex min-h-screen w-full max-w-6xl md:flex-row">
        <DesktopNav versionLabel={versionLabel} />
        <div className="flex min-h-screen flex-1 flex-col">
          <main className="flex-1 px-4 pb-24 pt-6 md:px-8 md:py-8">{children}</main>
          <BottomNav versionLabel={versionLabel} />
        </div>
      </div>
    </AppFiltersProvider>
  );
}
