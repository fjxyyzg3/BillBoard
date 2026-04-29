"use client";

import { Home, List, PlusCircle, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { LanguageToggle } from "@/components/language-toggle";
import { useAppFilters } from "@/components/app-filters-provider";
import type { Locale, Messages } from "@/lib/i18n";

type DesktopNavProps = {
  labels: {
    app: Messages["app"];
    language: Messages["language"];
    nav: Messages["nav"];
  };
  locale: Locale;
  versionLabel: string;
};

type NavItem = {
  href: "/home" | "/add" | "/records";
  label: string;
  Icon: LucideIcon;
};

export function DesktopNav({ labels, locale, versionLabel }: DesktopNavProps) {
  const pathname = usePathname();
  const { buildHref, navigateTo } = useAppFilters();
  const items: NavItem[] = [
    { href: "/home", label: labels.nav.home, Icon: Home },
    { href: "/add", label: labels.nav.add, Icon: PlusCircle },
    { href: "/records", label: labels.nav.records, Icon: List },
  ];

  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-black/[0.08] bg-white/70 backdrop-blur-xl md:flex md:flex-col">
      <div className="border-b border-black/[0.06] px-6 py-5">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-base font-semibold text-stone-900">{labels.app.brand}</p>
            <p className="mt-1 text-xs text-stone-500">{labels.app.tagline}</p>
          </div>
          <LanguageToggle labels={labels.language} locale={locale} />
        </div>
      </div>
      <nav className="flex-1 space-y-1 px-4 py-5">
        {items.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.Icon;

          return (
            <Link
              key={item.href}
              aria-current={isActive ? "page" : undefined}
              className={`flex items-center gap-3 rounded-2xl px-4 py-3 text-sm font-medium transition ${
                isActive
                  ? "bg-[var(--ios-blue-soft)] text-[var(--ios-blue)]"
                  : "text-stone-600 hover:bg-black/[0.04] hover:text-stone-900"
              }`}
              href={buildHref(item.href)}
              onClick={(event) => {
                if (
                  event.button !== 0 ||
                  event.altKey ||
                  event.ctrlKey ||
                  event.metaKey ||
                  event.shiftKey
                ) {
                  return;
                }

                event.preventDefault();
                navigateTo(item.href);
              }}
            >
              <Icon aria-hidden="true" className="h-5 w-5" strokeWidth={2.2} />
              <span>{item.label}</span>
            </Link>
          );
        })}
      </nav>
      <p className="px-6 pb-6 text-xs text-stone-400">{versionLabel}</p>
    </aside>
  );
}
