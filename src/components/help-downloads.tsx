"use client";

import { Download, Monitor, Smartphone } from "lucide-react";
import Link from "next/link";
import { useEffect, useState, useSyncExternalStore } from "react";
import type { DownloadAvailability, DownloadCatalog, DownloadPlatform } from "@/lib/download-types";
import type { Locale, Messages } from "@/lib/i18n";

type Props = {
  labels: Messages["help"]["downloads"];
  locale: Locale;
  metadataUrl: string;
  downloadUrls: Record<DownloadPlatform, string>;
};

type CatalogState = { status: "loading" | "failed" } | { status: "ready"; catalog: DownloadCatalog };

function subscribeToBridge() {
  return () => {};
}

function nativeBridgePresent() {
  return Boolean(window.BillBoardUpdater || window.BillBoardDesktop);
}

function serverBridgeSnapshot() {
  return null;
}

function readAvailability(value: unknown): DownloadAvailability {
  if (!value || typeof value !== "object") return { status: "unavailable" };
  const entry = value as Record<string, unknown>;
  if (entry.status === "busy") return { status: "busy" };
  if (entry.status !== "available" || typeof entry.version !== "string" || entry.version.length > 40
    || !/^\d+\.\d+\.\d+$/.test(entry.version) || typeof entry.size !== "number"
    || !Number.isSafeInteger(entry.size) || entry.size < 1) return { status: "unavailable" };
  return { status: "available", version: entry.version, size: entry.size };
}

export function HelpDownloads({ labels, locale, metadataUrl, downloadUrls }: Props) {
  const [state, setState] = useState<CatalogState>({ status: "loading" });
  const [attempt, setAttempt] = useState(0);
  const isNative = useSyncExternalStore<boolean | null>(subscribeToBridge, nativeBridgePresent, serverBridgeSnapshot);

  useEffect(() => {
    let active = true;
    const controller = new AbortController();
    const timeout = window.setTimeout(() => controller.abort(), 12_000);
    void fetch(metadataUrl, { cache: "no-store", credentials: "omit", signal: controller.signal })
      .then(async (response) => {
        if (!response.ok) throw new Error("Download catalog unavailable");
        const value: unknown = await response.json();
        if (!value || typeof value !== "object") throw new Error("Invalid download catalog");
        const catalog = value as Record<string, unknown>;
        if (active) setState({ status: "ready", catalog: {
          android: readAvailability(catalog.android), windows: readAvailability(catalog.windows),
        } });
      })
      .catch(() => { if (active) setState({ status: "failed" }); })
      .finally(() => window.clearTimeout(timeout));
    return () => { active = false; window.clearTimeout(timeout); controller.abort(); };
  }, [attempt, metadataUrl]);

  const retryAvailable = state.status === "failed" || (state.status === "ready"
    && Object.values(state.catalog).some((entry) => entry.status !== "available"));

  return (
    <section aria-labelledby="downloads-title" className="scroll-mt-6 space-y-5" id="downloads">
      <header className="space-y-2">
        <h2 className="text-xl font-medium tracking-tight" id="downloads-title">{labels.title}</h2>
        <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.description}</p>
      </header>
      {isNative ? <div className="space-y-2 rounded-xl border border-[var(--bb-warm-line)] bg-[var(--bb-warm-surface)] p-4">
        <p className="text-sm leading-6">{labels.nativeNotice}</p>
        <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.nativeBrowser}</p>
        <Link className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--bb-primary)] underline underline-offset-4" href="/home" prefetch={false}>{labels.nativeReturn}</Link>
      </div> : null}
      {state.status !== "ready" ? <p className="text-sm leading-6 text-[var(--bb-muted)]" role="status">
        {state.status === "loading" ? labels.loading : labels.failed}
      </p> : null}
      <div className="grid gap-4 sm:grid-cols-2">
        {(["android", "windows"] as const).map((platform) => {
          const release = state.status === "ready" ? state.catalog[platform] : null;
          const Icon = platform === "android" ? Smartphone : Monitor;
          return <article aria-labelledby={`${platform}-download-title`} className="flex min-w-0 flex-col ios-panel p-5" key={platform}>
            <div className="mb-3 flex items-center gap-3">
              <Icon aria-hidden="true" className="h-5 w-5 shrink-0 text-[var(--bb-primary)]" />
              <h3 className="text-base font-medium" id={`${platform}-download-title`}>{labels[platform]}</h3>
            </div>
            <p className="text-sm leading-6 text-[var(--bb-muted)]">{platform === "android" ? labels.androidDescription : labels.windowsDescription}</p>
            {release?.status === "available" ? <dl className="my-4 grid grid-cols-2 gap-3 text-sm">
              <div><dt className="text-xs text-[var(--bb-muted)]">{labels.version}</dt><dd className="mt-1 font-medium tabular-nums">{release.version}</dd></div>
              <div><dt className="text-xs text-[var(--bb-muted)]">{labels.size}</dt><dd className="mt-1 font-medium tabular-nums">{new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(release.size / 1024 / 1024)} MiB</dd></div>
            </dl> : release ? <p className="my-4 text-sm leading-6 text-[var(--bb-muted)]" role="status">{release.status === "busy" ? labels.busy : labels.unavailable}</p> : <div aria-hidden="true" className="my-4 h-12" />}
            <div className="mt-auto space-y-3">
              {release?.status === "available" && isNative === false ? <a
                className="inline-flex min-h-12 w-full items-center justify-center gap-2 rounded-xl bg-[var(--bb-primary)] px-4 py-3 text-center text-sm font-medium text-white hover:bg-[var(--bb-primary-hover)]"
                download href={downloadUrls[platform]}
              ><Download aria-hidden="true" className="h-4 w-4 shrink-0" />{platform === "android" ? labels.androidDownload : labels.windowsDownload}</a> : null}
              {isNative ? <p className="text-sm font-medium text-[var(--bb-muted)]">{labels.browserOnly}</p> : null}
              <p className="text-xs leading-5 text-[var(--bb-muted)]">{platform === "android" ? labels.androidInstall : labels.windowsInstall}</p>
            </div>
          </article>;
        })}
      </div>
      {retryAvailable ? <button className="inline-flex min-h-11 items-center rounded-xl border border-[var(--bb-line-strong)] bg-white px-4 py-2 text-sm font-medium hover:bg-[var(--bb-warm-surface)]" onClick={() => {
        setState({ status: "loading" }); setAttempt((value) => value + 1);
      }} type="button">{labels.retry}</button> : null}
    </section>
  );
}
