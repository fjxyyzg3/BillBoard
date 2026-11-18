"use client";

import { BookOpen, CircleHelp, Ellipsis, UserRound } from "lucide-react";
import { AnimatePresence, motion, useReducedMotion } from "motion/react";
import { usePathname } from "next/navigation";
import Link from "next/link";
import { useEffect, useId, useRef, useState } from "react";
import { AndroidUpdateButton, useAndroidUpdate } from "@/components/android-update-controls";
import { DesktopUpdateButton, useDesktopUpdate } from "@/components/desktop-update-controls";
import { LanguageToggle } from "@/components/language-toggle";
import { useAppFilters } from "@/components/app-filters-provider";
import { getMessages, type Locale } from "@/lib/i18n";

export function MobileUtilities({ locale, versionLabel }: { locale: Locale; versionLabel: string }) {
  const messages = getMessages(locale);
  const { buildHref } = useAppFilters();
  const reduceMotion = useReducedMotion();
  const pathname = usePathname();
  const [menuState, setMenuState] = useState({ pathname, open: false });
  if (menuState.pathname !== pathname) {
    setMenuState({ pathname, open: false });
  }
  const isOpen = menuState.pathname === pathname && menuState.open;
  const panelId = useId();
  const containerRef = useRef<HTMLDivElement>(null);
  const triggerRef = useRef<HTMLButtonElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const update = useAndroidUpdate();
  const desktopUpdate = useDesktopUpdate();
  const availableUpdate = update?.available ? update : desktopUpdate?.available ? desktopUpdate : null;

  useEffect(() => {
    if (!isOpen) return;
    panelRef.current?.querySelector<HTMLElement>("a[href],button:not(:disabled)")?.focus();

    function onPointerDown(event: PointerEvent) {
      if (!containerRef.current?.contains(event.target as Node)) setMenuState({ pathname, open: false });
    }
    function onKeyDown(event: KeyboardEvent) {
      if (event.key === "Escape") {
        setMenuState({ pathname, open: false });
        triggerRef.current?.focus();
      }
    }
    document.addEventListener("pointerdown", onPointerDown);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", onPointerDown);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [isOpen, pathname]);

  return (
    <div className="flex shrink-0 items-center md:hidden">
      <div className="relative z-40" onBlur={(event) => {
        // WebKit may blur to the document while pressing a button inside the panel.
        if (event.relatedTarget && !event.currentTarget.contains(event.relatedTarget)) {
          setMenuState({ pathname, open: false });
        }
      }} ref={containerRef}>
        <button
          aria-controls={panelId}
          aria-expanded={isOpen}
          aria-label={`${messages.ui.moreOptions}${availableUpdate ? ` · ${availableUpdate.availableLabel}` : ""}`}
          className="relative flex h-11 w-11 items-center justify-center rounded-full text-[var(--bb-ink)] transition hover:bg-[var(--bb-accent-soft)]"
          onClick={() => setMenuState({ pathname, open: !isOpen })}
          ref={triggerRef}
          type="button"
        >
          <Ellipsis aria-hidden="true" className="h-5 w-5" strokeWidth={1.6} />
          {update?.available ? <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" data-testid="apk-update-badge" /> : null}
          {desktopUpdate?.available ? <span aria-hidden="true" className="absolute right-1.5 top-1.5 h-2 w-2 rounded-full bg-red-500" data-testid="desktop-update-menu-badge" /> : null}
        </button>
        <AnimatePresence>
        {isOpen ? (
          <motion.div animate={{ opacity: 1, y: 0 }} exit={{ opacity: 0, y: reduceMotion ? 0 : -4 }} initial={{ opacity: reduceMotion ? 1 : 0, y: reduceMotion ? 0 : -4 }} transition={{ duration: reduceMotion ? 0 : 0.16 }} aria-label={messages.ui.moreOptions} className="absolute right-0 top-full w-56 space-y-3 rounded-2xl border border-[var(--bb-warm-line)] bg-[var(--bb-surface)] p-4 shadow-[var(--bb-shadow-lg)]" id={panelId} ref={panelRef} role="group">
            <div className="flex items-center justify-between gap-3">
              <span className="text-sm text-[var(--bb-muted)]">{messages.language.switchLanguage}</span>
              <LanguageToggle labels={messages.language} locale={locale} />
            </div>
            <Link className="flex min-h-11 items-center gap-3 rounded-xl px-2 text-sm text-[var(--bb-ink)] hover:bg-[var(--bb-warm-surface)]" href={buildHref("/ledgers")}><BookOpen aria-hidden="true" className="h-4 w-4 text-[var(--bb-muted)]" strokeWidth={1.6} />{messages.ledgers.manage}</Link>
            <Link className="flex min-h-11 items-center gap-3 rounded-xl px-2 text-sm text-[var(--bb-ink)] hover:bg-[var(--bb-warm-surface)]" href="/account"><UserRound aria-hidden="true" className="h-4 w-4 text-[var(--bb-muted)]" strokeWidth={1.6} />{messages.nav.account}</Link>
            <Link className="flex min-h-11 items-center gap-3 rounded-xl px-2 text-sm text-[var(--bb-ink)] hover:bg-[var(--bb-warm-surface)]" href="/help"><CircleHelp aria-hidden="true" className="h-4 w-4 text-[var(--bb-muted)]" strokeWidth={1.6} />{messages.nav.help}</Link>
            <AndroidUpdateButton onOpen={() => { setMenuState({ pathname, open: false }); triggerRef.current?.focus(); }} />
            <DesktopUpdateButton onOpen={() => { setMenuState({ pathname, open: false }); triggerRef.current?.focus(); }} />
            <p className="border-t border-[var(--bb-warm-line)] pt-3 text-xs text-[var(--bb-muted)]">{versionLabel}</p>
          </motion.div>
        ) : null}
        </AnimatePresence>
      </div>
    </div>
  );
}
