"use client";

import { useEffect } from "react";
import { usePathname } from "next/navigation";
import { DESKTOP_ACTIVITY_EVENT, desktopOperationBusy, parseDesktopMessage } from "@/lib/desktop-updater";
import { loadClientEncryptionOperation } from "@/lib/encryption/client-store";
import type { Locale } from "@/lib/i18n";

/** Account pages have no updater UI, but still report work for the native close guard. */
export function DesktopAccountSafety({ identity, locale }: { identity: string; locale: Locale }) {
  const pathname = usePathname();
  useEffect(() => {
    const bridge = window.BillBoardDesktop;
    if (!bridge || typeof bridge.postMessage !== "function" || typeof bridge.subscribe !== "function") return;
    let active = true;
    let recoveryReady = false;
    let recoveryPending = false;
    let revision = 0;
    const [accountId, householdId, memberId] = JSON.parse(identity) as string[];
    function loadRecovery() {
      if (!accountId || !householdId || !memberId) { recoveryReady = true; return; }
      const request = ++revision;
      recoveryReady = false;
      void loadClientEncryptionOperation({ accountId, householdId, memberId }).then((value) => {
        if (active && request === revision) { recoveryReady = true; recoveryPending = Boolean(value); }
      }).catch(() => { /* Keep an unreadable recovery state blocked. */ });
    }
    loadRecovery();
    window.addEventListener(DESKTOP_ACTIVITY_EVENT, loadRecovery);
    function safety() {
      return { ready: recoveryReady, busy: recoveryPending || desktopOperationBusy() || Boolean(document.querySelector('[aria-busy="true"],[data-desktop-update-blocked="true"]')),
        dirty: Boolean(document.querySelector('[data-desktop-update-dirty="true"]')), identity, locale };
    }
    const listener = (event: { data: string }) => {
      const message = parseDesktopMessage(event.data);
      // A previous page's installation intent never carries into account management.
      if (message && "type" in message && message.type === "prepare") {
        bridge!.postMessage(JSON.stringify({ command: "prepared", ...safety(), ready: false, requestId: message.requestId }));
      }
    };
    const unsubscribe = bridge.subscribe(listener);
    function heartbeat() { bridge!.postMessage(JSON.stringify({ command: "safety", ...safety() })); }
    heartbeat();
    const timer = window.setInterval(heartbeat, 1000);
    return () => {
      active = false;
      window.removeEventListener(DESKTOP_ACTIVITY_EVENT, loadRecovery);
      window.clearInterval(timer);
      unsubscribe();
      bridge.postMessage(JSON.stringify({ command: "safety", ready: false, busy: true, dirty: true, identity: "", locale }));
    };
  }, [pathname, identity, locale]);
  return null;
}
