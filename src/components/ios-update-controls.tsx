"use client";

import { Download } from "lucide-react";
import { createContext, useContext } from "react";

export const IosUpdateContext = createContext<{ title: string; open: () => void } | null>(null);

export function IosUpdateButton({ onOpen }: { onOpen?: () => void }) {
  const update = useContext(IosUpdateContext);
  if (!update) return null;
  return <button className="flex min-h-11 w-full items-center gap-2 rounded-xl px-2 text-sm font-medium text-[var(--bb-ink)] hover:bg-[var(--bb-warm-surface)]"
    onClick={() => { onOpen?.(); update.open(); }} type="button">
    <Download aria-hidden="true" className="h-4 w-4" />{update.title}
  </button>;
}
