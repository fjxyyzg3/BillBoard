"use client";

import { BookOpen, CircleHelp, CirclePlus, Home, ListTodo, ScanLine, UserRound, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { VoiceEntryLink } from "@/components/voice-entry-link";
import { AndroidUpdateButton } from "@/components/android-update-controls";
import { DesktopUpdateButton } from "@/components/desktop-update-controls";
import { IosUpdateButton } from "@/components/ios-update-controls";
import { usePathname } from "next/navigation";
import { LanguageToggle } from "@/components/language-toggle";
import { useAppFilters } from "@/components/app-filters-provider";
import { getMessages, type Locale, type Messages } from "@/lib/i18n";

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
  const messages = getMessages(locale);
  const { buildHref, navigateTo, pendingPath } = useAppFilters();
  const items: NavItem[] = [
    { href: "/home", label: labels.nav.home, Icon: Home },
    { href: "/add", label: labels.nav.add, Icon: CirclePlus },
    { href: "/records", label: labels.nav.records, Icon: ListTodo },
  ];

  return (
    <aside className="sticky top-0 hidden h-dvh w-56 max-w-[224px] shrink-0 overflow-y-auto border-r border-[var(--bb-warm-line)] bg-[#f8f7f5] md:flex md:flex-col">
      <div className="px-[min(1.25rem,20px)] pb-5 pt-7">
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="min-w-0">
            <p className="text-base font-medium tracking-tight text-[var(--bb-primary)]">{labels.app.brand}</p>
            <p className="mt-1.5 text-xs text-[var(--bb-muted)]">{labels.app.tagline}</p>
          </div>
          <LanguageToggle labels={labels.language} locale={locale} />
        </div>
      </div>
      <nav className="flex-1 space-y-1 px-[min(0.75rem,12px)] py-3">
        {items.map((item) => {
          const isActive = pathname === item.href || (item.href === "/records" && pathname.startsWith("/records/") && pathname !== "/records/reconcile");
          const isPending = pendingPath === item.href;
          const Icon = item.Icon;
          const EntryLink = item.href === "/add" ? VoiceEntryLink : Link;

          return (
            <EntryLink
              key={item.href}
              aria-busy={isPending || undefined}
              aria-current={isActive ? "page" : undefined}
              className={`bb-tap flex items-center gap-[min(0.75rem,12px)] rounded-xl px-[min(1rem,16px)] py-3 text-sm font-medium ${
                isActive || isPending
                  ? "bg-[var(--bb-accent-soft)] text-[var(--bb-accent-strong)]"
                  : "text-[var(--bb-muted)] hover:bg-[var(--bb-warm-surface)] hover:text-[var(--bb-ink)]"
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
              <Icon
                aria-hidden="true"
                className={`h-5 w-5 shrink-0 ${isPending ? "animate-pulse" : ""}`}
                strokeWidth={1.6}
              />
              <span className="min-w-0 break-words">{item.label}</span>
            </EntryLink>
          );
        })}
        <div className="my-4 border-t border-[var(--bb-warm-line)]" />
        {[{ href: "/ledgers", label: messages.ledgers.title, Icon: BookOpen }, { href: "/records/reconcile", label: messages.billAnalysis.title, Icon: ScanLine }].map(({ href, label, Icon }) => (
          <Link aria-current={pathname === href ? "page" : undefined} className={`bb-tap flex min-h-11 items-center gap-[min(0.75rem,12px)] rounded-xl px-[min(1rem,16px)] py-3 text-sm ${pathname === href ? "bg-[var(--bb-accent-soft)] font-medium text-[var(--bb-accent)]" : "text-[var(--bb-muted)] hover:bg-[var(--bb-warm-surface)] hover:text-[var(--bb-ink)]"}`} href={buildHref(href)} key={href}>
            <Icon aria-hidden="true" className="h-5 w-5 shrink-0" strokeWidth={1.6} /><span className="min-w-0 break-words">{label}</span>
          </Link>
        ))}
      </nav>
      <div className="space-y-1 px-[min(1.75rem,28px)] pb-6">
        <Link aria-current={pathname.startsWith("/account") ? "page" : undefined} className="flex min-h-11 items-center gap-3 text-sm text-[var(--bb-muted)] hover:text-[var(--bb-ink)]" href="/account"><UserRound aria-hidden="true" className="h-4 w-4" strokeWidth={1.6} />{labels.nav.account}</Link>
        <Link className="flex min-h-11 items-center gap-3 text-sm text-[var(--bb-muted)] hover:text-[var(--bb-ink)]" href="/help"><CircleHelp aria-hidden="true" className="h-4 w-4" strokeWidth={1.6} />{labels.nav.help}</Link>
        <AndroidUpdateButton />
        <DesktopUpdateButton />
        <IosUpdateButton />
        <p className="text-xs text-[var(--bb-muted)]">{versionLabel}</p>
      </div>
    </aside>
  );
}
