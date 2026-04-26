"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useAppFilters } from "@/components/app-filters-provider";

const items = [
  { href: "/home", label: "Home" },
  { href: "/add", label: "Add" },
  { href: "/records", label: "Records" },
] as const;

export function BottomNav() {
  const pathname = usePathname();
  const { buildHref, navigateTo } = useAppFilters();

  return (
    <nav className="fixed inset-x-0 bottom-0 border-t border-stone-200 bg-white/95 backdrop-blur md:hidden">
      <ul className="mx-auto grid max-w-6xl grid-cols-3">
        {items.map((item) => {
          const isActive = pathname === item.href;

          return (
            <li key={item.href}>
              <Link
                aria-current={isActive ? "page" : undefined}
                className={`flex justify-center px-4 py-3 text-sm ${
                  isActive ? "font-semibold text-stone-900" : "text-stone-500"
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
                {item.label}
              </Link>
            </li>
          );
        })}
      </ul>
    </nav>
  );
}
