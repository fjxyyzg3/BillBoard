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

type DesktopNavProps = {
  versionLabel: string;
};

export function DesktopNav({ versionLabel }: DesktopNavProps) {
  const pathname = usePathname();
  const { buildHref, navigateTo } = useAppFilters();

  return (
    <aside className="sticky top-0 hidden h-screen w-64 shrink-0 border-r border-black/[0.08] bg-white/70 backdrop-blur-xl md:flex md:flex-col">
      <div className="border-b border-black/[0.06] px-6 py-5">
        <p className="text-base font-semibold text-stone-900">BillBoard</p>
        <p className="mt-1 text-xs text-stone-500">Household accounting</p>
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
