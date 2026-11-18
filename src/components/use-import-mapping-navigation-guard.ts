"use client";

import { useEffect, useRef, type RefObject } from "react";
import { registerImportMappingNavigationGuard } from "@/components/import-review-history-guard";
import { getMessages, type Locale } from "@/lib/i18n";

const historyIndexKey = "__billboardMappingHistoryIndex";
function nativeHistoryIndex() {
  return (window as Window & { navigation?: { currentEntry?: { index: number } } }).navigation?.currentEntry?.index;
}
function markedHistoryIndex() {
  const index: unknown = window.history.state?.[historyIndexKey];
  return typeof index === "number" && Number.isSafeInteger(index) ? index : undefined;
}
function historyIndex() { return nativeHistoryIndex() ?? markedHistoryIndex(); }

export function useImportMappingNavigationGuard({ dirty, pending, formRef, locale, onDiscard }: {
  dirty: boolean;
  pending: boolean;
  formRef: RefObject<HTMLFormElement | null>;
  locale: Locale;
  onDiscard: () => void;
}) {
  const latest = useRef({ dirty, pending, onDiscard });
  const current = useRef<{ href: string; index?: number } | null>(null);
  const restoring = useRef<{ href: string; index?: number; untracked: boolean } | null>(null);
  const message = getMessages(locale).import.unsavedMappingsConfirm;
  useEffect(() => { latest.current = { dirty, pending, onDiscard }; }, [dirty, pending, onDiscard]);

  useEffect(() => {
    let active = true;
    let restoreHistoryMethods: (() => void) | undefined;
    if (nativeHistoryIndex() === undefined) {
      History.prototype.replaceState.call(window.history, { ...window.history.state, [historyIndexKey]: markedHistoryIndex() ?? 0 }, "");
      queueMicrotask(() => {
        if (!active) return;
        const originalPush = window.history.pushState;
        const originalReplace = window.history.replaceState;
        const push: History["pushState"] = (state, unused, url) => {
          originalPush.call(window.history, active ? { ...state, [historyIndexKey]: (markedHistoryIndex() ?? 0) + 1 } : state, unused, url);
        };
        const replace: History["replaceState"] = (state, unused, url) => {
          originalReplace.call(window.history, active ? { ...state, [historyIndexKey]: markedHistoryIndex() ?? 0 } : state, unused, url);
        };
        window.history.pushState = push;
        window.history.replaceState = replace;
        restoreHistoryMethods = () => {
          if (window.history.pushState === push) window.history.pushState = originalPush;
          if (window.history.replaceState === replace) window.history.replaceState = originalReplace;
        };
      });
    }
    current.current = { href: window.location.href, index: historyIndex() };

    function confirm() {
      if (!latest.current.dirty) return true;
      if (latest.current.pending) return false;
      if (!window.confirm(message)) return false;
      latest.current.dirty = false;
      latest.current.onDiscard();
      return true;
    }
    const unregister = registerImportMappingNavigationGuard({
      confirm,
      popState(event) {
        if (restoring.current) {
          event.stopImmediatePropagation();
          const target = restoring.current;
          if (window.location.href === target.href && historyIndex() === target.index) restoring.current = null;
          else if (target.untracked) window.history.forward();
          return true;
        }
        const previous = current.current!;
        const destination = new URL(window.location.href);
        const origin = new URL(previous.href);
        if ((destination.pathname === origin.pathname && destination.search === origin.search) || confirm()) {
          current.current = { href: destination.href, index: historyIndex() };
          return false;
        }
        event.stopImmediatePropagation();
        const targetIndex = historyIndex();
        const distance = previous.index !== undefined && targetIndex !== undefined ? previous.index - targetIndex : 1;
        restoring.current = { ...previous, untracked: targetIndex === undefined };
        window.history.go(distance || 1);
        return true;
      },
    });
    const warnBeforeUnload = (event: BeforeUnloadEvent) => {
      if (latest.current.dirty || latest.current.pending) event.preventDefault();
    };
    const guardLink = (event: MouseEvent) => {
      if (event.defaultPrevented || event.button !== 0 || event.ctrlKey || event.metaKey || event.shiftKey || event.altKey) return;
      const anchor = event.target instanceof Element ? event.target.closest("a") : null;
      if (!anchor || (anchor.target && anchor.target !== "_self") || anchor.hasAttribute("download")) return;
      const target = new URL(anchor.href);
      if (!["http:", "https:"].includes(target.protocol) || (target.origin === window.location.origin && target.pathname === window.location.pathname && target.search === window.location.search)) return;
      if (!confirm()) { event.preventDefault(); event.stopImmediatePropagation(); }
    };
    const guardOtherSubmit = (event: SubmitEvent) => {
      if (event.target instanceof HTMLFormElement && event.target !== formRef.current && !confirm()) {
        event.preventDefault();
        event.stopImmediatePropagation();
      }
    };
    // Capture before the review panel can auto-save its separate row decisions.
    window.addEventListener("click", guardLink, true);
    window.addEventListener("submit", guardOtherSubmit, true);
    window.addEventListener("beforeunload", warnBeforeUnload);
    return () => {
      active = false;
      restoreHistoryMethods?.();
      unregister();
      window.removeEventListener("click", guardLink, true);
      window.removeEventListener("submit", guardOtherSubmit, true);
      window.removeEventListener("beforeunload", warnBeforeUnload);
    };
  }, [formRef, message]);

  useEffect(() => {
    if (!restoring.current) current.current = { href: window.location.href, index: historyIndex() };
  });
}
