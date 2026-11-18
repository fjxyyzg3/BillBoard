"use client";

import { usePathname } from "next/navigation";
import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { AndroidUpdateContext } from "@/components/android-update-controls";
import { BottomSheet } from "@/components/bottom-sheet";
import { useNaturalLanguageEntry } from "@/components/natural-language-provider";
import { hasApkUpdate, parseUpdaterState, type UpdaterCommand, type UpdaterState } from "@/lib/android-updater";
import { getMessages, type Locale } from "@/lib/i18n";

const checkInterval = 15 * 60 * 1000;

export function AndroidUpdateProvider({ children, locale }: { children: ReactNode; locale: Locale }) {
  const labels = getMessages(locale).appUpdate;
  const { controller } = useNaturalLanguageEntry();
  const pathname = usePathname();
  const [state, setState] = useState<UpdaterState | null>(null);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const autoInstall = useRef(false);
  const installationRequested = useRef(false);
  const lastCheck = useRef(0);
  const latestState = useRef<UpdaterState | null>(null);

  const send = useCallback((command: UpdaterCommand) => {
    window.BillBoardUpdater?.postMessage(JSON.stringify({ command }));
  }, []);

  const requestInstall = useCallback(() => {
    installationRequested.current = true;
    send("install");
  }, [send]);

  const cancelInstallation = useCallback(() => {
    if (installationRequested.current || latestState.current?.status === "installing") send("cancel");
    installationRequested.current = false;
  }, [send]);

  const safeToInstall = useCallback(() => {
    const entry = controller.getSnapshot();
    return !document.hidden && document.hasFocus() && entry.ready && !entry.pending && !entry.reservation
      && !document.querySelector('[data-apk-update-blocked="true"]');
  }, [controller]);

  const receive = useEffectEvent((event: { data: string }) => {
    const next = parseUpdaterState(event.data);
    if (!next) return;
    latestState.current = next;
    if (next.status !== "installing") installationRequested.current = false;
    setState(next);
    if (next.status === "ready" && autoInstall.current) {
      autoInstall.current = false;
      if (open && saved && safeToInstall()) requestInstall();
      else setBlocked(true);
    }
    if (next.status === "error" || next.status === "permission") autoInstall.current = false;
  });

  useEffect(() => {
    const bridge = window.BillBoardUpdater;
    if (!bridge || typeof bridge.postMessage !== "function") return;
    const listener = (event: { data: string }) => receive(event);
    bridge.onmessage = listener;
    function check() {
      if (document.hidden) return;
      const current = latestState.current?.status;
      if (current && ["checking", "downloading", "ready", "permission", "installing"].includes(current)) return;
      if (Date.now() - lastCheck.current < checkInterval) return;
      lastCheck.current = Date.now();
      send("check");
    }
    function blur() { autoInstall.current = false; }
    function visibility() { if (document.hidden) blur(); else check(); }
    send("status");
    check();
    window.addEventListener("focus", check);
    window.addEventListener("blur", blur);
    document.addEventListener("visibilitychange", visibility);
    return () => {
      if (bridge.onmessage === listener) bridge.onmessage = null;
      autoInstall.current = false;
      cancelInstallation();
      if (latestState.current?.status === "downloading") send("cancel");
      window.removeEventListener("focus", check);
      window.removeEventListener("blur", blur);
      document.removeEventListener("visibilitychange", visibility);
    };
  }, [send, cancelInstallation]);

  useEffect(() => {
    autoInstall.current = false;
    cancelInstallation();
    queueMicrotask(() => { setOpen(false); setSaved(false); setBlocked(false); });
  }, [pathname, cancelInstallation]);

  const available = hasApkUpdate(state);
  const close = () => { autoInstall.current = false; cancelInstallation(); setOpen(false); setSaved(false); setBlocked(false); };
  const show = () => {
    setOpen(true);
    setSaved(false);
    setBlocked(false);
    if (!state || ["idle", "available", "error"].includes(state.status)) {
      lastCheck.current = Date.now();
      send("check");
    }
  };
  const begin = () => {
    if (!saved || !safeToInstall()) { setBlocked(true); return; }
    setBlocked(false);
    if (state?.status === "ready" || state?.status === "permission"
      || (state?.status === "error" && (state.error === "install" || state.error === "permission"))) {
      autoInstall.current = false;
      requestInstall();
    } else {
      autoInstall.current = true;
      send("download");
    }
  };
  const working = state && ["checking", "downloading", "installing"].includes(state.status);
  const installReady = state && (["ready", "permission"].includes(state.status)
    || (state.status === "error" && (state.error === "install" || state.error === "permission")));

  return <AndroidUpdateContext.Provider value={state ? { available, title: labels.title, availableLabel: labels.available, open: show } : null}>
    {children}
    <BottomSheet closeLabel={labels.close} onClose={close} open={open} title={labels.title}>
      {state ? <div className="space-y-5 p-5">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-[var(--bb-muted)]">{labels.current}</dt><dd className="text-right tabular-nums">{state.installedVersion}</dd>
          {available && state.release ? <>
            <dt className="text-[var(--bb-muted)]">{labels.latest}</dt><dd className="text-right tabular-nums">{state.release.versionName}</dd>
            <dt className="text-[var(--bb-muted)]">{labels.size}</dt><dd className="text-right tabular-nums">{(state.release.size / (1024 * 1024)).toFixed(1)} MB</dd>
          </> : null}
        </dl>
        {available && state.release ? <p className="whitespace-pre-wrap break-words text-sm leading-6">{state.release.notes[locale]}</p> : null}
        <div aria-live="polite" className="space-y-2 text-sm" role="status">
          {state.status === "checking" ? <p>{labels.checking}</p> : null}
          {state.status === "idle" && state.release && !available ? <p>{labels.upToDate}</p> : null}
          {state.status === "downloading" ? <>
            <p>{labels.downloading} {state.progress}%</p>
            <progress aria-label={labels.downloading} className="w-full accent-[var(--bb-primary)]" max={100} value={state.progress} />
          </> : null}
          {state.status === "ready" ? <p>{labels.ready}</p> : null}
          {state.status === "permission" ? <p>{labels.permission}</p> : null}
          {state.status === "installing" ? <p>{labels.installing}</p> : null}
        </div>
        {state.error ? <p className="text-sm text-red-700" role="alert">{labels.errors[state.error]}</p> : null}
        {blocked ? <p className="text-sm text-amber-800" role="alert">{labels.busy}</p> : null}
        {available ? <div className="space-y-3 rounded-2xl bg-[var(--bb-warm-surface)] p-4">
          <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.saveNotice}</p>
          <label className="flex min-h-11 items-center gap-3 text-sm">
            <input checked={saved} className="h-5 w-5 accent-[var(--bb-primary)]" disabled={Boolean(working)} onChange={(event) => setSaved(event.target.checked)} type="checkbox" />
            {labels.saved}
          </label>
        </div> : null}
        <div className="flex flex-wrap gap-3">
          {available && state.status !== "downloading" ? <button className="min-h-11 flex-1 rounded-xl bg-[var(--bb-primary)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!saved || Boolean(working)} onClick={begin} type="button">{installReady ? labels.install : labels.download}</button> : null}
          {state.status === "downloading" ? <button className="min-h-11 flex-1 rounded-xl border border-[var(--bb-warm-line)] px-4 py-3 text-sm" onClick={() => { autoInstall.current = false; send("cancel"); }} type="button">{labels.cancel}</button> : null}
          <button className="min-h-11 rounded-xl border border-[var(--bb-warm-line)] px-4 py-3 text-sm disabled:opacity-50" disabled={Boolean(working)}
            onClick={() => { autoInstall.current = false; lastCheck.current = Date.now(); setBlocked(false); send("check"); }} type="button">{labels.check}</button>
        </div>
      </div> : null}
    </BottomSheet>
  </AndroidUpdateContext.Provider>;
}
