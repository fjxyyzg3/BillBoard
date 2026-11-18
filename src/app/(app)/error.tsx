"use client";

import { useAppFilters } from "@/components/app-filters-provider";
import { getMessages } from "@/lib/i18n";

type AppRouteErrorProps = {
  retry: () => void;
};

export default function AppRouteError({ retry }: AppRouteErrorProps) {
  const { locale } = useAppFilters();
  const messages = getMessages(locale);

  return (
    <main className="mx-auto flex min-h-[50vh] max-w-lg flex-col items-center justify-center text-center">
      <h2 className="text-xl font-semibold text-stone-900">{messages.common.routeErrorTitle}</h2>
      <button
        className="mt-5 rounded-2xl bg-stone-900 px-5 py-3 text-sm font-semibold text-white"
        onClick={retry}
        type="button"
      >
        {messages.common.routeErrorRetry}
      </button>
    </main>
  );
}
