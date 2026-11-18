"use client";

import { createContext, useContext, useEffect, useRef, useState, useTransition, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { buildAppHref } from "@/lib/app-navigation";
import type { Locale } from "@/lib/i18n";

type AppFiltersContextValue = {
  buildHref: (pathname: string) => string;
  locale: Locale;
  navigateTo: (pathname: string) => void;
  pendingPath: string | null;
};

const AppFiltersContext = createContext<AppFiltersContextValue | null>(null);

export function AppFiltersProvider({
  children,
  locale,
}: {
  children: ReactNode;
  locale: Locale;
}) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentQuery = searchParams.toString();
  const queryRef = useRef(currentQuery);
  const [pendingPath, setPendingPath] = useState<string | null>(null);
  const [isNavigating, startNavigation] = useTransition();

  useEffect(() => {
    queryRef.current = currentQuery;
  }, [currentQuery]);

  useEffect(() => {
    if (pathname !== "/add") {
      router.prefetch(buildAppHref("/add", new URLSearchParams(currentQuery)));
    }
  }, [currentQuery, pathname, router]);

  const currentParams = new URLSearchParams(currentQuery);
  const value: AppFiltersContextValue = {
    buildHref(pathname: string) {
      return buildAppHref(pathname, currentParams);
    },
    navigateTo(nextPathname: string) {
      setPendingPath(nextPathname);
      startNavigation(() => {
        router.push(buildAppHref(nextPathname, new URLSearchParams(queryRef.current)));
      });
    },
    locale,
    pendingPath: isNavigating && pendingPath !== pathname ? pendingPath : null,
  };

  return (
    <AppFiltersContext.Provider value={value}>
      {children}
    </AppFiltersContext.Provider>
  );
}

export function useAppFilters() {
  const value = useContext(AppFiltersContext);

  if (!value) {
    throw new Error("useAppFilters must be used inside AppFiltersProvider");
  }

  return value;
}
