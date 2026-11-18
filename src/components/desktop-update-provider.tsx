"use client";

import { usePathname, useSearchParams } from "next/navigation";
import { useCallback, useEffect, useEffectEvent, useRef, useState, type ReactNode } from "react";
import { BottomSheet } from "@/components/bottom-sheet";
import { DesktopUpdateContext } from "@/components/desktop-update-controls";
import { useOptionalEncryption } from "@/components/encryption-provider";
import { useLedgerSelection } from "@/components/ledger-provider";
import { useNaturalLanguageEntry, useVoiceAccountingQueue } from "@/components/natural-language-provider";
import { DESKTOP_ACTIVITY_EVENT, DesktopInstallGuard, desktopOperationBusy, hasDesktopUpdate, parseDesktopMessage,
  setDesktopInstallFrozen, type DesktopSafety, type DesktopUpdaterState } from "@/lib/desktop-updater";
import { getMessages, type Locale } from "@/lib/i18n";
import { loadClientEncryptionOperation } from "@/lib/encryption/client-store";

const checkInterval = 15 * 60 * 1000;

export function DesktopUpdateProvider({ children, locale }: { children: ReactNode; locale: Locale }) {
  const labels = getMessages(locale).desktopUpdate;
  const { controller } = useNaturalLanguageEntry();
  const { queue } = useVoiceAccountingQueue();
  const ledger = useLedgerSelection();
  const encryption = useOptionalEncryption();
  const identity = encryption ? JSON.stringify([encryption.identity.accountId, encryption.identity.householdId, encryption.identity.memberId]) : "";
  const pathname = usePathname();
  const params = useSearchParams().toString();
  const route = `${pathname}?${params}`;
  const [state, setState] = useState<DesktopUpdaterState | null>(null);
  const [open, setOpen] = useState(false);
  const [saved, setSaved] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const recoveryState = useRef({ scope: "", pending: true });
  const [guard] = useState(() => new DesktopInstallGuard());
  const latestState = useRef<DesktopUpdaterState | null>(null);
  const lastCheck = useRef<number | null>(null);
  const checkAttempt = useRef<number | null>(null);
  const recoveryScope = `${identity}:${route}`;

  useEffect(() => {
    if (!window.BillBoardDesktop || !encryption?.identity) return;
    let active = true;
    let revision = 0;
    const currentIdentity = encryption.identity;
    function loadRecovery() {
      const request = ++revision;
      recoveryState.current = { scope: "", pending: true };
      void loadClientEncryptionOperation(currentIdentity).then((value) => {
        if (active && request === revision) recoveryState.current = { scope: recoveryScope, pending: Boolean(value) };
      }).catch(() => { /* An unreadable recovery state is unknown and keeps installation blocked. */ });
    }
    loadRecovery();
    window.addEventListener(DESKTOP_ACTIVITY_EVENT, loadRecovery);
    return () => { active = false; window.removeEventListener(DESKTOP_ACTIVITY_EVENT, loadRecovery); };
  }, [encryption?.identity, recoveryScope]);

  const post = useCallback((command: string, fields: Record<string, unknown> = {}) => {
    window.BillBoardDesktop?.postMessage(JSON.stringify({ command, locale, ...fields }));
  }, [locale]);

  const check = useCallback(() => {
    const current = latestState.current?.status;
    if (document.hidden || !current || ["checking", "downloading", "ready", "installing"].includes(current)) return;
    const now = Date.now();
    if (lastCheck.current !== null && now - lastCheck.current < checkInterval) return;
    if (checkAttempt.current !== null && now - checkAttempt.current < 1000) return;
    checkAttempt.current = now;
    post("check");
  }, [post]);

  const snapshot = useCallback((): DesktopSafety => {
    const entry = controller.getSnapshot();
    const voice = queue.getSnapshot();
    const recovery = recoveryState.current;
    return {
      ready: Boolean(latestState.current && identity && entry.ready && voice.ready && encryption?.ready && recovery.scope === recoveryScope),
      busy: Boolean(ledger.pending || entry.pending || entry.reservation || voice.tasks.some((task) => task.phase !== "success" && task.phase !== "failed")
        || recovery.pending || encryption?.status.operation || encryption?.status.mode === "ENABLING" || encryption?.status.mode === "DISABLING"
        || desktopOperationBusy() || document.querySelector('[data-apk-update-blocked="true"],[data-desktop-update-blocked="true"],[aria-busy="true"]')),
      dirty: controller.hasUnsavedTextDrafts() || voice.tasks.some((task) => task.phase === "failed" && Boolean(task.text?.trim()))
        || Boolean(document.querySelector('[data-desktop-update-dirty="true"]')),
      identity,
      locale,
    };
  }, [controller, queue, ledger.pending, encryption?.ready, encryption?.status, recoveryScope, identity, locale]);

  const cancelInstall = useCallback(() => {
    const cancelled = guard.invalidate();
    setDesktopInstallFrozen(false);
    if (cancelled) post("cancel");
  }, [guard, post]);

  const receive = useEffectEvent((event: { data: string }) => {
    const message = parseDesktopMessage(event.data);
    if (!message) {
      latestState.current = null;
      cancelInstall();
      return;
    }
    if ("type" in message) {
      if (message.type === "release") {
        guard.release();
        setDesktopInstallFrozen(false);
        return;
      }
      const safety = snapshot();
      const accepted = guard.prepare(safety, !document.hidden && document.hasFocus());
      setDesktopInstallFrozen(accepted);
      post("prepared", { requestId: message.requestId, ...safety, ready: accepted && safety.ready });
      if (!accepted) setBlocked(true);
      return;
    }
    latestState.current = message;
    // A navigation may reject a command sent with the previous private generation.
    // Start the interval only when the native side acknowledges work or its result.
    if (message.status === "checking" || (checkAttempt.current !== null && (message.status === "available"
      || (message.status === "idle" && message.release !== null)
      || (message.status === "error" && message.error !== "cancelled" && message.error !== "busy")))) {
      lastCheck.current = Date.now();
      checkAttempt.current = null;
    }
    setState(message);
    if (message.status !== "installing" && message.status !== "ready") {
      guard.release();
      setDesktopInstallFrozen(false);
    }
    check();
  });

  const heartbeat = useEffectEvent(() => {
    const safety = snapshot();
    if (guard.frozen && (!safety.ready || safety.busy || safety.dirty)) cancelInstall();
    post("safety", safety);
    if (checkAttempt.current !== null) check();
  });

  useEffect(() => {
    const bridge = window.BillBoardDesktop;
    if (!bridge || typeof bridge.postMessage !== "function" || typeof bridge.subscribe !== "function") return;
    const listener = (event: { data: string }) => receive(event);
    const unsubscribe = bridge.subscribe(listener);
    function blur() {
      if (guard.blur()) {
        setDesktopInstallFrozen(false);
        post("cancel");
      }
      if (!guard.frozen) setSaved(false);
    }
    function visibility() {
      if (document.hidden) {
        cancelInstall();
        setSaved(false);
      } else check();
    }
    function blockNewWork(event: Event) {
      if (!guard.frozen || (event.target instanceof Element && event.target.closest(".desktop-update-panel"))) return;
      event.preventDefault();
      event.stopImmediatePropagation();
      setBlocked(true);
    }
    function changed() {
      // React may not have committed its busy marker yet; explicit operation claims are synchronous.
      if (desktopOperationBusy()) cancelInstall();
    }
    post("status");
    heartbeat();
    check();
    const interval = window.setInterval(() => heartbeat(), 1000);
    window.addEventListener("focus", check);
    window.addEventListener("blur", blur);
    window.addEventListener("pagehide", cancelInstall);
    window.addEventListener(DESKTOP_ACTIVITY_EVENT, changed);
    document.addEventListener("visibilitychange", visibility);
    for (const name of ["submit", "click", "pointerdown", "keydown", "beforeinput", "change"]) document.addEventListener(name, blockNewWork, true);
    return () => {
      unsubscribe();
      cancelInstall();
      if (latestState.current?.status === "downloading") post("cancel");
      post("safety", { ready: false, busy: true, dirty: true, identity: "" });
      window.clearInterval(interval);
      window.removeEventListener("focus", check);
      window.removeEventListener("blur", blur);
      window.removeEventListener("pagehide", cancelInstall);
      window.removeEventListener(DESKTOP_ACTIVITY_EVENT, changed);
      document.removeEventListener("visibilitychange", visibility);
      for (const name of ["submit", "click", "pointerdown", "keydown", "beforeinput", "change"]) document.removeEventListener(name, blockNewWork, true);
    };
  }, [post, guard, cancelInstall, check]);

  useEffect(() => {
    cancelInstall();
    queueMicrotask(() => { setOpen(false); setSaved(false); setBlocked(false); });
  }, [route, identity, cancelInstall]);

  const available = hasDesktopUpdate(state);
  const close = () => { cancelInstall(); setOpen(false); setSaved(false); setBlocked(false); };
  const show = () => {
    setOpen(true); setSaved(false); setBlocked(false);
    if (!state || ["idle", "available", "error"].includes(state.status)) {
      checkAttempt.current = Date.now();
      post("check");
    }
  };
  const install = () => {
    if (!guard.request(latestState.current, snapshot(), !document.hidden && document.hasFocus(), saved)) { setBlocked(true); return; }
    setBlocked(false);
    post("install");
  };
  const working = Boolean(state && ["checking", "downloading", "installing"].includes(state.status));

  return <DesktopUpdateContext.Provider value={state ? { available, title: labels.entry, availableLabel: labels.available, open: show } : null}>
    {children}
    <BottomSheet className="desktop-update-panel" closeLabel={labels.close} onClose={close} open={open} title={labels.title}>
      {state ? <div className="space-y-5">
        <dl className="grid grid-cols-[auto_1fr] gap-x-4 gap-y-2 text-sm">
          <dt className="text-[var(--bb-muted)]">{labels.current}</dt><dd className="text-right tabular-nums">{state.installedVersion}</dd>
          {available && state.release ? <><dt className="text-[var(--bb-muted)]">{labels.latest}</dt><dd className="text-right tabular-nums">{state.release.version}</dd>
            <dt className="text-[var(--bb-muted)]">{labels.size}</dt><dd className="text-right tabular-nums">{(state.release.size / (1024 * 1024)).toFixed(1)} MB</dd></> : null}
        </dl>
        {available && state.release ? <p className="whitespace-pre-wrap break-words text-sm leading-6">{state.release.notes[locale]}</p> : null}
        <div aria-live="polite" className="space-y-2 text-sm" role="status">
          {state.status === "checking" ? <p>{labels.checking}</p> : null}
          {state.status === "idle" && !available ? <p>{labels.upToDate}</p> : null}
          {state.status === "downloading" ? <><p>{labels.downloading} {state.progress}%</p><progress aria-label={labels.downloading} className="w-full accent-[var(--bb-primary)]" max={100} value={state.progress} /></> : null}
          {state.status === "ready" ? <p>{labels.ready}</p> : null}
          {state.status === "installing" ? <p>{labels.installing}</p> : null}
        </div>
        {state.error ? <p className="text-sm text-red-700" role="alert">{labels.errors[state.error]}</p> : null}
        {blocked ? <p className="text-sm text-amber-800" role="alert">{labels.busy}</p> : null}
        {available && state.status === "ready" ? <div className="space-y-3 rounded-2xl bg-[var(--bb-warm-surface)] p-4">
          <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.saveNotice}</p>
          <label className="flex min-h-11 items-center gap-3 text-sm"><input checked={saved} className="h-5 w-5 accent-[var(--bb-primary)]" disabled={working}
            onChange={(event) => { if (!event.target.checked) cancelInstall(); setSaved(event.target.checked); }} type="checkbox" />{labels.saved}</label>
        </div> : null}
        <div className="flex flex-wrap gap-3">
          {available && !working && state.status !== "ready" ? <button className="min-h-11 flex-1 rounded-xl bg-[var(--bb-primary)] px-4 py-3 text-sm font-semibold text-white"
            onClick={() => { cancelInstall(); setBlocked(false); post("download"); }} type="button">{labels.download}</button> : null}
          {available && state.status === "ready" ? <button className="min-h-11 flex-1 rounded-xl bg-[var(--bb-primary)] px-4 py-3 text-sm font-semibold text-white disabled:opacity-50"
            disabled={!saved} onClick={install} type="button">{labels.install}</button> : null}
          {state.status === "downloading" ? <button className="min-h-11 flex-1 rounded-xl border border-[var(--bb-warm-line)] px-4 py-3 text-sm" onClick={() => post("cancel")} type="button">{labels.cancel}</button> : null}
          {state.status === "installing" ? <button className="min-h-11 flex-1 rounded-xl border border-[var(--bb-warm-line)] px-4 py-3 text-sm" onClick={cancelInstall} type="button">{labels.cancelInstall}</button> : null}
          <button className="min-h-11 rounded-xl border border-[var(--bb-warm-line)] px-4 py-3 text-sm disabled:opacity-50" disabled={working || state.status === "ready"}
            onClick={() => { cancelInstall(); checkAttempt.current = Date.now(); setBlocked(false); post("check"); }} type="button">{labels.check}</button>
        </div>
      </div> : null}
    </BottomSheet>
  </DesktopUpdateContext.Provider>;
}
