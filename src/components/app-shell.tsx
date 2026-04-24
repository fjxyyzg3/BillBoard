import type { ReactNode } from "react";
import { BottomNav } from "@/components/bottom-nav";
import { DesktopNav } from "@/components/desktop-nav";

type AppShellProps = {
  children: ReactNode;
};

export function AppShell({ children }: AppShellProps) {
  return (
    <div className="mx-auto flex min-h-screen w-full max-w-6xl md:flex-row">
      <DesktopNav />
      <div className="flex min-h-screen flex-1 flex-col">
        <main className="flex-1 px-4 pb-24 pt-6 md:px-8 md:py-8">{children}</main>
        <BottomNav />
      </div>
    </div>
  );
}
