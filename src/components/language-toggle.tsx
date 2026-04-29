"use client";

import { Languages } from "lucide-react";
import { useRouter } from "next/navigation";
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
  const nextLocale: Locale = locale === "zh-CN" ? "en-US" : "zh-CN";

  return (
    <button
      aria-label={labels.switchLanguage}
      className="inline-flex min-h-9 items-center justify-center gap-1.5 rounded-full border border-black/[0.08] bg-white/80 px-3 text-xs font-semibold text-stone-700 shadow-sm transition hover:bg-white hover:text-stone-950"
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
