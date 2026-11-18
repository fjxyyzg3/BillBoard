"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect } from "react";
import type { Messages } from "@/lib/i18n";
import { clearEntryBrowserState } from "@/lib/transactions/entry-context";

export function IdentityAccountNav({ labels, hasHousehold }: { labels: Messages["identity"]; hasHousehold: boolean }) {
  const pathname = usePathname();
  useEffect(() => {
    if (hasHousehold) return;
    try {
      clearEntryBrowserState(window.sessionStorage);
      window.sessionStorage.removeItem("billboard:active-entry-context:v1");
    } catch { /* Account-only access never recovers household drafts. */ }
  }, [hasHousehold]);
  return <nav aria-label={labels.title} className="flex gap-5 border-b border-[var(--bb-warm-line)] text-sm">
    {[["/account", labels.account], ["/account/household", labels.household]].map(([href, title]) => <Link aria-current={pathname === href ? "page" : undefined} className={`flex min-h-11 items-center border-b-2 ${pathname === href ? "border-[var(--bb-ink)] font-medium text-[var(--bb-ink)]" : "border-transparent text-[var(--bb-muted)]"}`} href={href} key={href}>{title}</Link>)}
  </nav>;
}
