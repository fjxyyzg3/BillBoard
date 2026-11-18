"use client";

import { Languages } from "lucide-react";
import { useRouter } from "next/navigation";
import { useEffect, useState } from "react";
import { LOCALE_COOKIE_NAME, type Locale } from "@/lib/i18n";

type LanguageToggleProps = {
  labels: {
    switchLanguage: string;
    target: string;
  };
  locale: Locale;
};

const cookieMaxAgeSeconds = 60 * 60 * 24 * 365;

export function LanguageToggle({ labels, locale }: LanguageToggleProps) {
  const router = useRouter();
  const [isHydrated, setIsHydrated] = useState(false);
  const nextLocale: Locale = locale === "zh-CN" ? "en-US" : "zh-CN";

  useEffect(() => {
    const readyTimer = window.setTimeout(() => {
      setIsHydrated(true);
    }, 0);

    return () => {
      window.clearTimeout(readyTimer);
    };
  }, []);

  return (
    <button
      aria-label={labels.switchLanguage}
      className="bb-tap inline-flex min-h-11 items-center justify-center gap-1.5 rounded-xl border border-[var(--bb-warm-line)] bg-white px-3 text-[13px] font-medium text-[var(--bb-ink)] shadow-[var(--bb-shadow-sm)] hover:bg-[var(--bb-warm-surface)] hover:text-[var(--bb-accent-strong)] disabled:cursor-wait disabled:opacity-70"
      disabled={!isHydrated}
      onClick={() => {
        document.cookie = `${LOCALE_COOKIE_NAME}=${encodeURIComponent(nextLocale)}; Path=/; Max-Age=${cookieMaxAgeSeconds}; SameSite=Lax`;
        router.refresh();
      }}
      type="button"
    >
      <Languages aria-hidden="true" className="h-3.5 w-3.5" strokeWidth={2.2} />
      <span>{labels.target}</span>
    </button>
  );
}
