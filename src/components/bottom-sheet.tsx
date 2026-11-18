"use client";

import { X } from "lucide-react";
import { animate, useReducedMotion } from "motion/react";
import { lockPageScroll } from "@/lib/ui/page-scroll-lock";
import {
  useEffect,
  useEffectEvent,
  useId,
  useRef,
  type CSSProperties,
  type KeyboardEvent,
  type PointerEvent,
  type ReactNode,
  type RefObject,
} from "react";

type BottomSheetProps = {
  children: ReactNode;
  className?: string;
  closeLabel: string;
  footer?: ReactNode;
  initialFocusRef?: RefObject<HTMLElement | null>;
  returnFocusRef?: RefObject<HTMLElement | null>;
  onAfterClose?: () => void;
  onClose: () => void;
  open: boolean;
  title: string;
};

const sheetViewportStyle = {
  height: "var(--sheet-viewport-height, 100dvh)",
  top: "var(--sheet-viewport-top, 0px)",
} satisfies CSSProperties;

function getTabbableElements(dialog: HTMLDialogElement) {
  const visibleElements = Array.from(dialog.querySelectorAll<HTMLElement>(
    "a[href], button, input, select, textarea, details > summary, [tabindex], [contenteditable]",
  )).filter((element) => {
    const visibility = getComputedStyle(element).visibility;

    return element.tabIndex >= 0
      && !element.matches(":disabled")
      && !element.closest("[hidden], [inert]")
      && element.getClientRects().length > 0
      && visibility !== "hidden"
      && visibility !== "collapse";
  });

  return visibleElements.filter((element) => {
    if (!(element instanceof HTMLInputElement) || element.type !== "radio" || !element.name) {
      return true;
    }

    const group = visibleElements.filter((candidate): candidate is HTMLInputElement =>
      candidate instanceof HTMLInputElement
      && candidate.type === "radio"
      && candidate.name === element.name
      && candidate.form === element.form,
    );

    return element === (group.find((candidate) => candidate.checked) ?? group[0]);
  }).sort((first, second) => {
    if (first.tabIndex === second.tabIndex) return 0;
    if (first.tabIndex === 0) return 1;
    if (second.tabIndex === 0) return -1;
    return first.tabIndex - second.tabIndex;
  });
}

/** Keep the native modal in place so fields and footer retain their form owner. */
export function BottomSheet({
  children,
  className,
  closeLabel,
  footer,
  initialFocusRef,
  returnFocusRef,
  onAfterClose,
  onClose,
  open,
  title,
}: BottomSheetProps) {
  const titleId = useId();
  const reduceMotion = useReducedMotion();
  const dialogRef = useRef<HTMLDialogElement>(null);
  const panelRef = useRef<HTMLDivElement>(null);
  const backdropRef = useRef<HTMLDivElement>(null);
  const closeButtonRef = useRef<HTMLButtonElement>(null);
  const triggerRef = useRef<HTMLElement | null>(null);
  const releaseScrollRef = useRef<(() => void) | undefined>(undefined);
  const backdropPointerRef = useRef(false);
  const afterClose = useEffectEvent(() => onAfterClose?.());

  useEffect(() => {
    const dialog = dialogRef.current;
    const panel = panelRef.current;
    const backdrop = backdropRef.current;

    if (!dialog || !panel || !backdrop) {
      return;
    }

    let cancelled = false;
    const wasOpen = dialog.open;

    function finishClose() {
      dialog!.close();
      releaseScrollRef.current?.();
      releaseScrollRef.current = undefined;

      if (triggerRef.current?.isConnected) {
        triggerRef.current.focus({ preventScroll: true });
      }

      triggerRef.current = null;
      afterClose();
    }

    if (open) {
      if (!wasOpen) {
        // Pointer activation does not focus buttons in every browser.
        triggerRef.current = returnFocusRef?.current ?? (
          document.activeElement instanceof HTMLElement ? document.activeElement : null
        );
        releaseScrollRef.current = lockPageScroll();
        dialog.showModal();
        (initialFocusRef?.current ?? closeButtonRef.current)?.focus({ preventScroll: true });
      }

      if (reduceMotion) {
        panel.style.opacity = "1";
        panel.style.transform = "translateY(0px)";
        backdrop.style.opacity = "1";
        return;
      }
    } else if (!wasOpen) {
      return;
    } else if (reduceMotion) {
      finishClose();
      return;
    }

    const panelAnimation = animate(panel, open ? {
      opacity: wasOpen ? 1 : [0, 1],
      y: wasOpen ? 0 : [24, 0],
    } : { opacity: 0, y: 24 }, {
      duration: open ? 0.26 : 0.2,
      ease: [0.22, 1, 0.36, 1],
    });
    const backdropAnimation = animate(backdrop, {
      opacity: open ? (wasOpen ? 1 : [0, 1]) : 0,
    }, {
      duration: open ? 0.26 : 0.2,
      ease: [0.22, 1, 0.36, 1],
    });

    if (!open) {
      Promise.all([panelAnimation, backdropAnimation]).then(() => {
        if (!cancelled) {
          finishClose();
        }
      });
    }

    return () => {
      cancelled = true;
      panelAnimation.stop();
      backdropAnimation.stop();
    };
  }, [initialFocusRef, open, reduceMotion, returnFocusRef]);

  useEffect(() => {
    const dialog = dialogRef.current;

    if (!dialog || !open) {
      return;
    }

    const viewport = window.visualViewport;

    function updateViewport() {
      dialog!.style.setProperty("--sheet-viewport-height", `${viewport?.height ?? window.innerHeight}px`);
      dialog!.style.setProperty("--sheet-viewport-top", `${viewport?.offsetTop ?? 0}px`);
    }

    updateViewport();
    viewport?.addEventListener("resize", updateViewport);
    viewport?.addEventListener("scroll", updateViewport);
    window.addEventListener("resize", updateViewport);

    return () => {
      viewport?.removeEventListener("resize", updateViewport);
      viewport?.removeEventListener("scroll", updateViewport);
      window.removeEventListener("resize", updateViewport);
    };
  }, [open]);

  useEffect(() => {
    const dialog = dialogRef.current;

    return () => {
      dialog?.close();
      releaseScrollRef.current?.();
      releaseScrollRef.current = undefined;
    };
  }, []);

  function handleBackdropPointerDown(event: PointerEvent<HTMLDialogElement>) {
    backdropPointerRef.current = !panelRef.current?.contains(event.target as Node);
  }

  function handleTabBoundary(event: KeyboardEvent<HTMLDialogElement>) {
    if (event.key !== "Tab" || event.defaultPrevented || !event.currentTarget.open) {
      return;
    }

    const elements = getTabbableElements(event.currentTarget);
    const first = elements[0];
    const last = elements.at(-1);
    const activeElement = document.activeElement;

    // Native dialogs can hand the boundary Tab to browser chrome before wrapping.
    if (!first || !last) {
      event.preventDefault();
      event.currentTarget.focus();
    } else if (event.shiftKey && activeElement === first) {
      event.preventDefault();
      last.focus();
    } else if (!event.shiftKey && activeElement === last) {
      event.preventDefault();
      first.focus();
    } else if (!elements.some((element) => element === activeElement)) {
      event.preventDefault();
      (event.shiftKey ? last : first).focus();
    }
  }

  return (
    <dialog
      aria-labelledby={titleId}
      aria-modal="true"
      className="fixed left-0 m-0 w-full max-w-none max-h-none overflow-hidden border-0 bg-transparent p-0 text-[var(--bb-ink)] [&::backdrop]:bg-transparent"
      onCancel={(event) => {
        event.preventDefault();
        if (open) {
          onClose();
        }
      }}
      onClick={(event) => {
        if (open && backdropPointerRef.current && !panelRef.current?.contains(event.target as Node)) {
          onClose();
        }
      }}
      onKeyDown={handleTabBoundary}
      onPointerDown={handleBackdropPointerDown}
      ref={dialogRef}
      style={sheetViewportStyle}
    >
      <div aria-hidden="true" className="absolute inset-0 bg-[#303138]/25" ref={backdropRef} />
      <div className="pointer-events-none relative flex h-full w-full items-end justify-center md:items-center md:p-6">
        <div
          className={`pointer-events-auto relative flex max-h-[calc(var(--sheet-viewport-height,100dvh)-12px)] w-full min-w-0 flex-col overflow-hidden rounded-t-[1.75rem] border border-[var(--bb-warm-line)] bg-[var(--bb-surface)] shadow-[var(--bb-shadow-lg)] md:max-h-[calc(var(--sheet-viewport-height,100dvh)-48px)] md:max-w-lg md:rounded-3xl ${className ?? ""}`}
          ref={panelRef}
        >
          <div aria-hidden="true" className="mx-auto mt-2 h-1 w-9 shrink-0 rounded-full bg-[var(--bb-line-strong)] md:hidden" />
          <header className="flex shrink-0 items-center justify-between gap-3 px-5 py-3 md:px-6">
            <h2 className="min-w-0 text-xl font-medium leading-snug tracking-tight" id={titleId}>{title}</h2>
            <button
              aria-label={closeLabel}
              className="inline-flex min-h-11 min-w-11 shrink-0 items-center justify-center rounded-full bg-[var(--bb-warm-surface)] text-[var(--bb-muted)] transition-colors duration-100 hover:bg-[var(--bb-accent-soft)] hover:text-[var(--bb-accent-ink)] active:scale-95 motion-reduce:transform-none motion-reduce:transition-none"
              onClick={() => {
                if (open) {
                  onClose();
                }
              }}
              ref={closeButtonRef}
              type="button"
            >
              <X aria-hidden="true" className="h-4 w-4" strokeWidth={1.6} />
            </button>
          </header>
          <div className="min-h-0 overflow-x-hidden overflow-y-auto overscroll-contain px-5 pb-5 [scrollbar-gutter:stable] md:px-6">
            {children}
          </div>
          {footer ? (
            <footer className="shrink-0 border-t border-[var(--bb-warm-line)] bg-[var(--bb-surface)] px-4 pt-3 pb-[max(1rem,env(safe-area-inset-bottom))] md:px-5">
              {footer}
            </footer>
          ) : (
            <div aria-hidden="true" className="shrink-0 pb-[env(safe-area-inset-bottom)]" />
          )}
        </div>
      </div>
    </dialog>
  );
}
