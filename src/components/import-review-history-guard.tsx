"use client";

import { useLayoutEffect } from "react";

type ReviewHistoryGuard = (event: PopStateEvent) => void;
let activeReviewGuard: ReviewHistoryGuard | null = null;
type MappingNavigationGuard = { confirm: () => boolean; popState: (event: PopStateEvent) => boolean };
let activeMappingGuard: MappingNavigationGuard | null = null;

export function registerImportMappingNavigationGuard(guard: MappingNavigationGuard) {
  activeMappingGuard = guard;
  return () => {
    if (activeMappingGuard === guard) activeMappingGuard = null;
  };
}

export function confirmImportMappingNavigation() {
  return activeMappingGuard?.confirm() ?? true;
}

export function registerImportReviewHistoryGuard(guard: ReviewHistoryGuard) {
  activeReviewGuard = guard;
  return () => {
    if (activeReviewGuard === guard) activeReviewGuard = null;
  };
}

export function ImportReviewHistoryGuard() {
  useLayoutEffect(() => {
    // Window invokes popstate listeners in registration order, including capture listeners.
    // Register before the app router so a failed save can keep the active review mounted.
    const guard = (event: PopStateEvent) => {
      if (!activeMappingGuard?.popState(event)) activeReviewGuard?.(event);
    };
    window.addEventListener("popstate", guard);
    return () => window.removeEventListener("popstate", guard);
  }, []);

  return null;
}
