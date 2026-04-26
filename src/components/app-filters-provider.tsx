"use client";

import { createContext, useContext, useEffect, useRef, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { buildAppHref } from "@/lib/app-navigation";
import { parsePerspective, type Perspective } from "@/lib/perspective";
import { parseRangePreset } from "@/lib/range-preset";
import type { RangePreset } from "@/lib/time-range";

type AppFiltersContextValue = {
  buildHref: (pathname: string) => string;
  navigateTo: (pathname: string) => void;
  perspective: Perspective;
  rangePreset: RangePreset;
  setPerspective: (perspective: Perspective) => void;
  setRangePreset: (rangePreset: RangePreset) => void;
};

const AppFiltersContext = createContext<AppFiltersContextValue | null>(null);

export function AppFiltersProvider({ children }: { children: ReactNode }) {
  const pathname = usePathname();
  const router = useRouter();
  const searchParams = useSearchParams();
  const currentQuery = searchParams.toString();
  const queryRef = useRef(currentQuery);

  useEffect(() => {
    queryRef.current = currentQuery;
  }, [currentQuery]);

  function updateQuery(nextParams: URLSearchParams) {
    const nextQuery = nextParams.toString();
    const href = nextQuery ? `${pathname}?${nextQuery}` : pathname;

    queryRef.current = nextQuery;
    router.replace(href, { scroll: false });
  }

  function setPerspective(nextPerspective: Perspective) {
    const nextParams = new URLSearchParams(queryRef.current);

    if (nextPerspective === "household") {
      nextParams.delete("perspective");
    } else {
      nextParams.set("perspective", nextPerspective);
    }

    updateQuery(nextParams);
  }

  function setRangePreset(nextRangePreset: RangePreset) {
    const nextParams = new URLSearchParams(queryRef.current);

    nextParams.set("range", nextRangePreset);

    updateQuery(nextParams);
  }

  const currentParams = new URLSearchParams(currentQuery);
  const value: AppFiltersContextValue = {
    buildHref(pathname: string) {
      return buildAppHref(pathname, currentParams);
    },
    navigateTo(nextPathname: string) {
      router.push(buildAppHref(nextPathname, new URLSearchParams(queryRef.current)));
    },
    perspective: parsePerspective(currentParams.get("perspective")),
    rangePreset: parseRangePreset(currentParams.get("range")),
    setPerspective,
    setRangePreset,
  };

  return <AppFiltersContext.Provider value={value}>{children}</AppFiltersContext.Provider>;
}

export function useAppFilters() {
  const value = useContext(AppFiltersContext);

  if (!value) {
    throw new Error("useAppFilters must be used inside AppFiltersProvider");
  }

  return value;
}
