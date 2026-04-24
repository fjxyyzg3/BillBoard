"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";

const items = [
  { href: "/home", label: "Home" },
  { href: "/add", label: "Add" },
  { href: "/records", label: "Records" },
] as const;

export function DesktopNav() {
  const pathname = usePathname();

  return (
    <aside className="hidden w-64 shrink-0 border-r border-stone-200 bg-white md:flex md:flex-col">
      <div className="border-b border-stone-200 px-6 py-6">
        <p className="text-lg font-semibold text-stone-900">BillBoard</p>
        <p className="mt-1 text-sm text-stone-500">Household accounting</p>
      </div>
      <nav className="space-y-2 px-4 py-6">
        {items.map((item) => {
          const isActive = pathname === item.href;

          return (
            <Link
              key={item.href}
              aria-current={isActive ? "page" : undefined}
              className={`block rounded-2xl px-4 py-3 text-sm ${
                isActive
                  ? "bg-stone-900 text-white"
                  : "text-stone-600 transition hover:bg-stone-100 hover:text-stone-900"
              }`}
              href={item.href}
            >
              {item.label}
            </Link>
          );
        })}
      </nav>
    </aside>
  );
}
