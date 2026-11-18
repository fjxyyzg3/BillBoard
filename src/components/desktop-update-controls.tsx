"use client";

import { Download } from "lucide-react";
import { createContext, useContext } from "react";

type Controls = { available: boolean; title: string; availableLabel: string; open: () => void };
export const DesktopUpdateContext = createContext<Controls | null>(null);
export function useDesktopUpdate() { return useContext(DesktopUpdateContext); }

export function DesktopUpdateButton({ onOpen }: { onOpen?: () => void }) {
  const update = useDesktopUpdate();
  if (!update) return null;
  return <button className="flex min-h-11 w-full items-center gap-2 rounded-xl px-2 text-sm font-medium text-[var(--bb-ink)] hover:bg-[var(--bb-warm-surface)]"
    onClick={() => { onOpen?.(); update.open(); }} type="button">
    <Download aria-hidden="true" className="h-4 w-4" />{update.title}
    {update.available ? <><span aria-hidden="true" className="h-2 w-2 rounded-full bg-red-500" data-testid="desktop-update-badge" /><span className="sr-only">{update.availableLabel}</span></> : null}
  </button>;
}
