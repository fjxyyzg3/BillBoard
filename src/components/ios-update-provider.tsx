"use client";

import Link from "next/link";
import { usePathname } from "next/navigation";
import { useEffect, useLayoutEffect, useRef, useState, type ReactNode } from "react";
import { BottomSheet } from "@/components/bottom-sheet";
import { useOptionalEncryption } from "@/components/encryption-provider";
import { IosUpdateContext } from "@/components/ios-update-controls";
import { useLedgerSelection } from "@/components/ledger-provider";
import { useNaturalLanguageEntry, useVoiceAccountingQueue } from "@/components/natural-language-provider";
import { desktopOperationBusy } from "@/lib/desktop-updater";
import { getMessages, type Locale } from "@/lib/i18n";
import { compareIosBuilds, isIosBuild } from "@/lib/ios-release-manifest.mjs";

type Build = { version: string; build: string };
type Command = { command: "version" | "safari" } | { command: "install"; url: string; expiresAt: number; build: string };
type Bridge = { postMessage: (message: Command) => Promise<unknown> };
type Status = "idle" | "checking" | "latest" | "available" | "preparing" | "handedOff" | "blocked" | "auth" | "unavailable" | "offline" | "changed" | "openFailed";
const actionClass = "bb-tap min-h-11 rounded-xl border border-[var(--bb-warm-line)] px-4 py-2 text-sm font-medium disabled:opacity-50";

function updateBridge(): Bridge | undefined {
  const bridge = (window as Window & { webkit?: { messageHandlers?: { billboardUpdate?: Bridge } } })
    .webkit?.messageHandlers?.billboardUpdate;
  return typeof bridge?.postMessage === "function" ? bridge : undefined;
}

function readBuild(data: unknown): Build | null {
  if (!data || typeof data !== "object") return null;
  const { version, build } = data as Partial<Build>;
  return typeof version === "string" && /^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version) && isIosBuild(build) ? { version, build } : null;
}

function requestFailure(status: number): Status {
  if (status === 401) return "auth";
  if (status === 409) return "changed";
  return status === 404 ? "unavailable" : "offline";
}

export function IosUpdateProvider({ children, locale }: { children: ReactNode; locale: Locale }) {
  const labels = getMessages(locale).iosUpdate;
  const { controller } = useNaturalLanguageEntry();
  const { queue } = useVoiceAccountingQueue();
  const ledger = useLedgerSelection();
  const encryption = useOptionalEncryption();
  const pathname = usePathname();
  const [installed, setInstalled] = useState<Build | null>(null);
  const [latest, setLatest] = useState<Build | null>(null);
  const [openPath, setOpenPath] = useState<string | null>(null);
  const [status, setStatus] = useState<Status>("idle");
  if (openPath !== null && openPath !== pathname) setOpenPath(null);
  const operation = useRef<AbortController | null>(null);
  const pageBusy = Boolean(ledger.pending || (encryption && (!encryption.ready || encryption.status.operation
    || encryption.status.mode === "ENABLING" || encryption.status.mode === "DISABLING")));
  const latestPageBusy = useRef(pageBusy);

  useLayoutEffect(() => { latestPageBusy.current = pageBusy; }, [pageBusy]);

  useEffect(() => {
    let current = true;
    const bridge = updateBridge();
    if (bridge) void Promise.resolve().then(() => bridge.postMessage({ command: "version" }))
      .then((value) => { if (current) setInstalled(readBuild(value)); }).catch(() => {});
    return () => { current = false; };
  }, []);

  useEffect(() => () => {
    operation.current?.abort();
    operation.current = null;
  }, [pathname]);

  function canLeave() {
    const entry = controller.getSnapshot();
    const voice = queue.getSnapshot();
    return !document.hidden && entry.ready && voice.ready && !latestPageBusy.current && !desktopOperationBusy()
      && !entry.pending && !entry.reservation && !controller.hasUnsavedTextDrafts()
      && !voice.tasks.some((task) => task.phase !== "success" && (task.phase !== "failed" || Boolean(task.text?.trim())))
      && !document.querySelector('[data-apk-update-blocked="true"],[data-desktop-update-blocked="true"],[data-desktop-update-dirty="true"],[aria-busy="true"]');
  }

  function close() {
    operation.current?.abort();
    operation.current = null;
    setOpenPath(null);
  }

  async function perform(command: "check" | "install" | "safari") {
    const bridge = updateBridge();
    if (!installed || !bridge || operation.current) return;
    if (command !== "check" && !canLeave()) { setStatus("blocked"); return; }
    if (command === "install" && (!latest || compareIosBuilds(latest.build, installed.build) <= 0)) return;
    const request = new AbortController();
    operation.current = request;
    const page = window.location.href;
    let handingOff = command === "safari";
    const isCurrent = () => operation.current === request && !request.signal.aborted && window.location.href === page;
    const timeout = window.setTimeout(() => {
      request.abort();
      if (operation.current === request) {
        operation.current = null;
        setStatus(handingOff ? "openFailed" : "offline");
      }
    }, 15_000);
    setStatus(command === "check" ? "checking" : "preparing");
    if (command === "check") setLatest(null);
    try {
      if (command === "safari") {
        const opened = await bridge.postMessage({ command: "safari" });
        if (isCurrent()) setStatus(opened === true ? "idle" : "openFailed");
        return;
      }
      const targetBuild = latest?.build;
      const response = await fetch("/api/ios/update", {
        cache: "no-store", credentials: "same-origin", redirect: "error", signal: request.signal,
        ...(command === "install" ? { method: "POST", headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ currentBuild: installed.build, targetBuild }) } : {}),
      });
      if (!isCurrent()) return;
      if (!response.ok) {
        setLatest(null);
        setStatus(requestFailure(response.status));
        return;
      }
      const result: unknown = await response.json();
      if (!isCurrent()) return;
      if (command === "check") {
        const release = readBuild(result);
        if (!release) { setStatus("unavailable"); return; }
        setLatest(release);
        setStatus(compareIosBuilds(release.build, installed.build) > 0 ? "available" : "latest");
        return;
      }
      const grant = result as { url?: unknown; expiresAt?: unknown; build?: unknown } | null;
      if (!grant || typeof grant.url !== "string" || typeof grant.expiresAt !== "number"
        || !Number.isSafeInteger(grant.expiresAt) || grant.expiresAt <= Date.now() || !targetBuild || grant.build !== targetBuild) {
        setStatus("changed");
        setLatest(null);
        return;
      }
      if (!canLeave()) { setStatus("blocked"); return; }
      handingOff = true;
      const opened = await bridge.postMessage({ command: "install", url: grant.url, expiresAt: grant.expiresAt, build: targetBuild });
      if (isCurrent()) setStatus(opened === true ? "handedOff" : "openFailed");
    } catch {
      if (isCurrent()) setStatus(handingOff ? "openFailed" : "offline");
    } finally {
      window.clearTimeout(timeout);
      if (operation.current === request) {
        operation.current = null;
        if (window.location.href !== page) setStatus("idle");
      }
    }
  }

  function show() {
    setOpenPath(pathname);
    void perform("check");
  }

  const available = installed && latest && compareIosBuilds(latest.build, installed.build) > 0;
  const pending = status === "checking" || status === "preparing";
  const statusLabel = status === "idle" || status === "available" ? "" : labels[status];
  return <IosUpdateContext.Provider value={installed ? { title: labels.title, open: show } : null}>
    {children}
    {installed ? <BottomSheet closeLabel={labels.close} onClose={close} open={openPath === pathname} title={labels.title}>
      <div className="space-y-4">
        <dl className="grid grid-cols-[1fr_auto] gap-2 text-sm">
          <dt>{labels.current}</dt><dd className="text-right tabular-nums">{installed.version} ({installed.build})</dd>
          {latest ? <><dt>{labels.published}</dt><dd className="text-right tabular-nums">{latest.version} ({latest.build})</dd></> : null}
        </dl>
        <p aria-atomic="true" className="text-sm text-[var(--bb-muted)]" role="status">{statusLabel}</p>
        {status === "auth" ? <Link className={actionClass} href="/login?reason=session-expired" onClick={close}>{labels.signIn}</Link> : null}
        <div className="flex flex-wrap gap-3">
          {available ? <button className={actionClass} disabled={pending} onClick={() => void perform("install")} type="button">{labels.install}</button> : null}
          {available ? <button className={actionClass} disabled={pending} onClick={() => void perform("safari")} type="button">{labels.safari}</button> : null}
          <button className={actionClass} disabled={pending} onClick={() => void perform("check")} type="button">{labels.recheck}</button>
        </div>
      </div>
    </BottomSheet> : null}
  </IosUpdateContext.Provider>;
}
