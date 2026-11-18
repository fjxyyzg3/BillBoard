"use client";

import Link from "next/link";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { lazy, Suspense, useEffect, useState, type ReactNode } from "react";
import { AppShellView, type AppShellViewProps } from "@/components/app-shell-view";
import { EncryptionProvider, useEncryption } from "@/components/encryption-provider";
import { EncryptionCodeScanner } from "@/components/encryption-code-scanner";
import { clearUsableEncryption, encryptionClientGeneration, encryptedJsonFetch } from "@/lib/encryption/client";
import { decodeViewData, householdPages, type HouseholdPage } from "@/lib/encryption/view-data";
import { encryptionIdentityKey, type EncryptionIdentity } from "@/lib/encryption/client-store";
import type { EncryptionStatus } from "@/lib/encryption/types";
import { getEncryptionMessages, type Locale } from "@/lib/i18n";

type Model = { shell: Omit<AppShellViewProps, "children">; page: HouseholdPage; data: unknown };

const HomeView = lazy(() => import("@/app/(app)/home/view").then((module) => ({ default: module.HomeView })));
const AddView = lazy(() => import("@/app/(app)/add/view").then((module) => ({ default: module.AddView })));
const RecordsView = lazy(() => import("@/app/(app)/records/view").then((module) => ({ default: module.RecordsView })));
const ReconciliationView = lazy(() => import("@/app/(app)/records/reconcile/view").then((module) => ({ default: module.ReconciliationView })));
const ImportView = lazy(() => import("@/app/(app)/records/import/view").then((module) => ({ default: module.ImportView })));
const MappingsView = lazy(() => import("@/app/(app)/records/import/mappings/view").then((module) => ({ default: module.MappingsView })));
const LedgersView = lazy(() => import("@/app/(app)/ledgers/view").then((module) => ({ default: module.LedgersView })));

function PageView({ model }: { model: Model }): ReactNode {
  switch (model.page) {
    case "home": return <HomeView data={model.data as Parameters<typeof HomeView>[0]["data"]} />;
    case "add": return <AddView data={model.data as Parameters<typeof AddView>[0]["data"]} />;
    case "records": return <RecordsView data={model.data as Parameters<typeof RecordsView>[0]["data"]} />;
    case "reconciliation": return <ReconciliationView data={model.data as Parameters<typeof ReconciliationView>[0]["data"]} />;
    case "import": return <ImportView data={model.data as Parameters<typeof ImportView>[0]["data"]} />;
    case "mappings": return <MappingsView data={model.data as Parameters<typeof MappingsView>[0]["data"]} />;
    case "ledgers": return <LedgersView data={model.data as Parameters<typeof LedgersView>[0]["data"]} />;
  }
}

function GateBody({ locale }: { locale: Locale }) {
  const { identity, status, code, ready, supply } = useEncryption();
  const path = usePathname();
  const router = useRouter();
  const params = useSearchParams().toString();
  const labels = getEncryptionMessages(locale);
  const [input, setInput] = useState("");
  const [remember, setRemember] = useState(true);
  const [retry, setRetry] = useState(0);
  const [state, setState] = useState<{ key: string; context?: string; model?: Model; error?: boolean; storageUnavailable?: boolean }>({ key: "" });
  const page = householdPages[path];
  const context = `${encryptionIdentityKey(identity)}:${status.revision}`;
  const key = `${path}?${params}:${status.revision}:${retry}`;
  const needsCode = status.mode === "ENCRYPTED" || status.mode === "DISABLING";

  useEffect(() => {
    if (!ready || (needsCode && !code) || !page) return;
    const controller = new AbortController();
    const generation = encryptionClientGeneration();
    void (async () => {
      try {
        const response = await encryptedJsonFetch("/api/household/view", { page, search: params }, controller.signal);
        if (!response.ok) {
          const failure = await response.json().catch(() => null);
          if (["ENCRYPTION_INVALID", "ENCRYPTION_REQUIRED"].includes(failure?.error)) {
            if (!controller.signal.aborted && generation === encryptionClientGeneration()) {
              setState({ key, error: true });
              clearUsableEncryption();
            }
            return;
          }
          throw new Error("VIEW_UNAVAILABLE");
        }
        const result = await response.json();
        if (!controller.signal.aborted && generation === encryptionClientGeneration()) setState({ key, context, model: decodeViewData(result) as Model });
      } catch {
        if (!controller.signal.aborted && generation === encryptionClientGeneration()) setState({ key, error: true });
      }
    })();
    return () => controller.abort();
  }, [ready, needsCode, code, page, params, key, context, identity, status]);

  if (ready && (!needsCode || code) && state.context === context && state.model) {
    const loading = <p className="text-sm text-[var(--bb-muted)]" role="status">{labels.loading}</p>;
    return <AppShellView {...state.model.shell}><Suspense fallback={loading}>{state.key === key ? <PageView model={state.model} /> : loading}</Suspense></AppShellView>;
  }
  return <main className="mx-auto max-w-lg space-y-5 px-4 py-8" data-testid="household-encryption-gate">
    <h1 className="text-2xl font-semibold text-[var(--bb-ink)]">{labels.unlock}</h1>
    <p className="text-sm leading-6 text-[var(--bb-muted)]">{needsCode ? labels.locked : labels.loading}</p>
    {ready && needsCode && !code ? <form className="space-y-4" onSubmit={async (event) => {
      event.preventDefault();
      try { await supply(input, remember); setInput(""); setRetry((value) => value + 1); }
      catch (error) { setState({ key, error: true, storageUnavailable: error instanceof Error && error.message === "LOCAL_KEY_STORAGE_UNAVAILABLE" }); }
    }}>
      <label className="block space-y-2 text-sm font-medium"><span>{labels.code}</span><textarea autoCapitalize="none" autoComplete="off" className="ios-field min-h-28" onChange={(event) => setInput(event.target.value)} required spellCheck={false} value={input} /></label>
      <EncryptionCodeScanner locale={locale} onCode={setInput} />
      <label className="flex min-h-11 items-center gap-3 text-sm"><input checked={remember} onChange={(event) => setRemember(event.target.checked)} type="checkbox" />{labels.remember}</label>
      <button className="min-h-11 w-full rounded-xl bg-[var(--bb-primary)] px-4 py-3 font-semibold text-white" type="submit">{labels.importCode}</button>
    </form> : null}
    {state.error && state.key === key ? <div className="space-y-3" role="alert"><p className="text-sm text-[var(--bb-danger)]">{state.storageUnavailable ? labels.deviceStorageUnavailable : labels.failed}</p><button className="min-h-11 rounded-xl border border-[var(--bb-line-strong)] px-4" onClick={() => { router.refresh(); setRetry((value) => value + 1); }} type="button">{labels.retry}</button></div> : null}
    <Link className="inline-flex min-h-11 items-center text-sm font-medium text-[var(--bb-ink)]" href="/account">{labels.account}</Link>
  </main>;
}

export function EncryptionGate({ identity, status, locale }: { identity: EncryptionIdentity; status: EncryptionStatus; locale: Locale }) {
  return <EncryptionProvider identity={identity} locale={locale} status={status}><GateBody locale={locale} /></EncryptionProvider>;
}
