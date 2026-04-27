"use client";

import { Home, List, PlusCircle, type LucideIcon } from "lucide-react";
import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAppFilters } from "@/components/app-filters-provider";

const items = [
  { href: "/home", label: "Home", Icon: Home },
  { href: "/add", label: "Add", Icon: PlusCircle },
  { href: "/records", label: "Records", Icon: List },
] satisfies ReadonlyArray<{
  href: "/home" | "/add" | "/records";
  label: "Home" | "Add" | "Records";
  Icon: LucideIcon;
}>;

type BottomNavProps = {
  versionLabel: string;
};

export function BottomNav({ versionLabel }: BottomNavProps) {
  const pathname = usePathname();
  const { buildHref, navigateTo } = useAppFilters();

  return (
    <nav className="fixed inset-x-0 bottom-0 z-30 border-t border-black/[0.08] bg-white/90 pb-[env(safe-area-inset-bottom)] shadow-[0_-10px_30px_rgba(0,0,0,0.06)] backdrop-blur-xl md:hidden">
      <p className="border-b border-black/[0.06] px-4 py-1.5 text-center text-[0.625rem] leading-none text-stone-400">
        {versionLabel}
      </p>
      <ul className="mx-auto grid max-w-7xl grid-cols-3 px-3 py-2">
        {items.map((item) => {
          const isActive = pathname === item.href;
          const Icon = item.Icon;

          return (
            <li key={item.href}>
              <Link
                aria-current={isActive ? "page" : undefined}
                className={`flex min-h-14 flex-col items-center justify-center gap-1 rounded-2xl px-3 py-2 text-xs font-medium transition ${
                  isActive
                    ? "bg-[var(--ios-blue-soft)] text-[var(--ios-blue)]"
                    : "text-stone-500 hover:bg-black/[0.04] hover:text-stone-800"
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
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
