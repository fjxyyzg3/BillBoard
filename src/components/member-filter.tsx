"use client";

import { useId, useTransition } from "react";
import { IosSelect } from "@/components/ios-select";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { getMessages, type Locale } from "@/lib/i18n";
import type { MemberFilterOption } from "@/lib/records/member-filter";

export function buildMemberFilterHref(pathname: string, query: string, memberId: string) {
  const params = new URLSearchParams(query);
  if (memberId) params.set("member", memberId);
  else params.delete("member");
  for (const key of ["page", "record", "perspective"]) params.delete(key);
  return `${pathname}${params.size ? `?${params}` : ""}`;
}

export function MemberFilter({ members, actorMemberId, locale, compact = false }: { members: MemberFilterOption[]; actorMemberId?: string; locale: Locale; compact?: boolean }) {
  const labels = getMessages(locale).memberFilter;
  const pathname = usePathname();
  const params = useSearchParams();
  const router = useRouter();
  const id = useId();
  const [pending, startTransition] = useTransition();
  return <label className={compact ? "min-w-0" : "block min-w-0 space-y-1.5 sm:max-w-xs"} htmlFor={id}>
    <span className={compact ? "sr-only" : "block text-xs text-[var(--bb-muted)]"}>{labels.label}</span>
    <IosSelect aria-label={labels.label} disabled={pending} id={id} value={actorMemberId ?? ""}
      onChange={(event) => {
        const href = buildMemberFilterHref(pathname, params.toString(), event.currentTarget.value);
        startTransition(() => router.replace(href, { scroll: false }));
      }}
      options={[{ value: "", label: labels.all }, ...members.map((member) => ({ value: member.id, label: member.label }))]}
      variant={compact ? "compact" : "field"} />
  </label>;
}
