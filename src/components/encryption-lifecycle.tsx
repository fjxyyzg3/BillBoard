"use client";

import { usePathname } from "next/navigation";
import { useEffect, useState, type ComponentProps } from "react";
import { clearUsableEncryption, forgetClientEncryption } from "@/lib/encryption/client";
import { getEncryptionMessages, type Locale } from "@/lib/i18n";
import { clearReconciliationApplicationPointers } from "@/lib/reports/bill-reconciliation-controller";

function clearReconciliationPointer() {
  try { clearReconciliationApplicationPointers(window.localStorage); }
  catch { /* Identity-bound metadata cannot grant access when browser storage is unavailable. */ }
}

export function EncryptionLifecycle() {
  const pathname = usePathname();
  useEffect(() => {
    if (pathname === "/login" || pathname === "/account-link") clearUsableEncryption();
  }, [pathname]);
  useEffect(() => {
    if (typeof BroadcastChannel === "undefined") return;
    const channel = new BroadcastChannel("billboard-household-encryption");
    channel.onmessage = (event) => { if (event.data === "forget") {
      clearReconciliationPointer();
      void forgetClientEncryption().catch(() => undefined);
    } };
    return () => channel.close();
  }, []);
  return null;
}

export async function forgetEncryptionIdentity() {
  await forgetClientEncryption();
  clearReconciliationPointer();
  if (typeof BroadcastChannel !== "undefined") {
    const channel = new BroadcastChannel("billboard-household-encryption");
    channel.postMessage("forget");
    channel.close();
  }
}

export function EncryptionLogoutForm({ action, locale = "zh-CN", children, ...props }: Omit<ComponentProps<"form">, "action"> & { action: () => Promise<void>; locale?: Locale }) {
  const [failed, setFailed] = useState(false);
  return <form {...props} action={async () => {
    setFailed(false);
    try { await forgetEncryptionIdentity(); }
    catch { setFailed(true); return; }
    await action();
  }}>{children}{failed ? <p className="text-sm leading-6 text-[var(--bb-danger)]" role="alert">{getEncryptionMessages(locale).forgetFailed}</p> : null}</form>;
}
