import type { ReactNode } from "react";

export function IdentitySection({ title, description, children }: { title: string; description: string; children: ReactNode }) {
  // Keep each settings group on one surface; wide screens place context beside its controls.
  return <section className="ios-panel my-4 grid gap-5 p-5 md:grid-cols-[minmax(0,1fr)_minmax(0,1.9fr)] md:gap-8 md:p-6">
    <div className="min-w-0 space-y-2"><h2 className="text-[15px] font-medium text-[var(--bb-ink)]">{title}</h2><p className="text-sm leading-6 text-[var(--bb-muted)]">{description}</p></div>
    <div className="min-w-0">{children}</div>
  </section>;
}
