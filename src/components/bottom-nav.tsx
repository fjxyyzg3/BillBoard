"use client";

import { Plus, Home, ListTodo, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { VoiceEntryLink } from "@/components/voice-entry-link";
import { usePathname } from "next/navigation";
import { useAppFilters } from "@/components/app-filters-provider";
import type { Messages } from "@/lib/i18n";

type BottomNavProps = {
  labels: Messages["nav"];
  navigationLabel: string;
};

type NavItem = {
  href: "/home" | "/add" | "/records";
  label: string;
  Icon: LucideIcon;
};

export function BottomNav({ labels, navigationLabel }: BottomNavProps) {
  const pathname = usePathname();
  const { buildHref, navigateTo, pendingPath } = useAppFilters();
  const items: NavItem[] = [
    { href: "/home", label: labels.home, Icon: Home },
    { href: "/add", label: labels.add, Icon: Plus },
    { href: "/records", label: labels.records, Icon: ListTodo },
  ];
  const selectionPath = pendingPath ?? pathname;
  const selectedIndex = items.findIndex((item) => selectionPath === item.href
    || (item.href === "/records" && selectionPath.startsWith("/records/")));

  return (
    <nav aria-label={navigationLabel} className="bb-floating-nav fixed inset-x-5 bottom-[max(0.75rem,env(safe-area-inset-bottom))] z-30 mx-auto max-w-sm md:hidden">
      {selectedIndex >= 0 ? (
        <span
          aria-hidden="true"
          className="bb-bottom-nav-selection pointer-events-none absolute inset-y-1.5 left-1.5 rounded-full bg-[var(--bb-accent-soft)]"
          style={{ transform: `translateX(calc(${selectedIndex * 100}% + ${selectedIndex * 0.25}rem))` }}
        />
      ) : null}
      <ul className="relative grid min-h-[3.625rem] grid-cols-3 gap-1 p-1.5">
        {items.map((item, index) => {
          const isActive = pathname === item.href || (item.href === "/records" && pathname.startsWith("/records/"));
          const isPending = pendingPath === item.href;
          const Icon = item.Icon;
          const EntryLink = item.href === "/add" ? VoiceEntryLink : Link;

          return (
            <li key={item.href}>
              <EntryLink
                aria-busy={isPending || undefined}
                aria-current={isActive ? "page" : undefined}
                className={`bb-tap relative flex h-full min-h-11 flex-col items-center justify-center gap-0.5 rounded-full px-2 text-[0.6875rem] font-normal ${
                  index === selectedIndex
                    ? "text-[var(--bb-accent-strong)]"
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
                <span className={`relative inline-flex shrink-0 items-center justify-center ${item.href === "/add" ? "h-6 w-6 rounded-full bg-[var(--bb-primary)] text-white" : "h-6 w-6"}`}>
                  <Icon
                    aria-hidden="true"
                    className={`h-[18px] w-[18px] ${isPending ? "animate-pulse" : ""}`}
                    strokeWidth={1.7}
                  />
                </span>
                <span className="relative">{item.label}</span>
              </EntryLink>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
