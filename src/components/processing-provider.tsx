"use client";

import { createContext, useCallback, useContext, useEffect, useState, type ReactNode } from "react";
import { BottomSheet } from "@/components/bottom-sheet";
import { ProcessingPreferencesForm } from "@/components/processing-preferences-form";
import { getMessages, type Locale } from "@/lib/i18n";
import type { ProcessingCapability, ProcessingChoices } from "@/lib/processing/types";

const Context = createContext<{ ensure: (capability: ProcessingCapability) => boolean } | null>(null);

export function ProcessingProvider({ children, locale, initialChoices }: { children: ReactNode; locale: Locale; initialChoices?: ProcessingChoices }) {
  const labels = getMessages(locale).safeguards.processing;
  const [choices, setChoices] = useState<ProcessingChoices | null>(initialChoices ?? null);
  const [required, setRequired] = useState<ProcessingCapability | null>(null);
  const refresh = useCallback(async () => {
    try {
      const response = await fetch("/api/account/processing", { cache: "no-store" });
      if (response.ok) setChoices(await response.json());
    } catch { /* New task admission always checks the server-side account choice. */ }
  }, []);
  useEffect(() => {
    // Keep the server snapshot stable while the streamed page hydrates.
    if (!initialChoices) queueMicrotask(() => { void refresh(); });
    window.addEventListener("focus", refresh);
    window.addEventListener("billboard-processing-change", refresh);
    return () => { window.removeEventListener("focus", refresh); window.removeEventListener("billboard-processing-change", refresh); };
  }, [initialChoices, refresh]);
  const ensure = (capability: ProcessingCapability) => {
    if (choices?.ai && (capability === "ai" || choices.voice)) return true;
    setRequired(capability);
    return false;
  };
  return <Context.Provider value={{ ensure }}>
    {children}
    <BottomSheet closeLabel={labels.later} onClose={() => setRequired(null)} open={required !== null} title={labels.title}>
      <p className="text-sm leading-6 text-[var(--bb-muted)]">{required === "voice" ? labels.voiceRequired : labels.required}</p>
      {required ? <ProcessingPreferencesForm embedded locale={locale} onSaved={(saved) => { setChoices(saved); if (saved.ai && (required !== "voice" || saved.voice)) setRequired(null); }} /> : null}
    </BottomSheet>
  </Context.Provider>;
}

export function useProcessingChoice() {
  // Isolated form renders still rely on authoritative server-side admission.
  return useContext(Context) ?? { ensure: () => true };
}
