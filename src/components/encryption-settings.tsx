"use client";

import { useEffect, useRef, useState } from "react";
import { useRouter } from "next/navigation";
import { BottomSheet } from "@/components/bottom-sheet";
import { EncryptionProvider, useEncryption } from "@/components/encryption-provider";
import { forgetEncryptionIdentity } from "@/components/encryption-lifecycle";
import { encryptionClientGeneration } from "@/lib/encryption/client";
import { beginDesktopOperation } from "@/lib/desktop-updater";
import { clearClientEncryptionOperation, loadClientEncryptionOperation, rememberHouseholdCode, saveClientEncryptionOperation, type EncryptionIdentity } from "@/lib/encryption/client-store";
import { openKeyRing, parseHouseholdCode } from "@/lib/encryption/crypto";
import { createEncryptionCandidate, matchesEncryptionReceipt, readRecoveryFile, restoreEncryptionCandidate, type EncryptionCandidate, type EncryptionOperationReceipt } from "@/lib/encryption/client-recovery";
import type { EncryptionStatus } from "@/lib/encryption/types";
import { getEncryptionMessages, type Locale } from "@/lib/i18n";

type Result = { status: EncryptionStatus; operation: EncryptionOperationReceipt | null; unknown?: boolean; done?: boolean; progress?: { completed: number; total: number } };
const secondary = "min-h-11 rounded-xl bg-[var(--bb-warm-surface)] px-4 py-2 text-sm font-medium disabled:opacity-50";

async function post(input: Record<string, unknown>) {
  const response = await fetch("/api/household/encryption", { method: "POST", credentials: "same-origin", cache: "no-store", headers: { "Content-Type": "application/json" }, body: JSON.stringify(input) });
  if (!response.ok) throw new Error("ENCRYPTION_UNAVAILABLE");
  return response.json();
}

function download(text: string, name: string) {
  const finishDesktopOperation = beginDesktopOperation();
  if (!finishDesktopOperation) return;
  try {
    const url = URL.createObjectURL(new Blob([text], { type: "application/json" }));
    const link = document.createElement("a");
    link.href = url;
    link.download = name;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  } finally { finishDesktopOperation(); }
}

async function fileText(file?: File) {
  if (!file || file.size > 8 * 1024 * 1024) throw new Error("INVALID_RECOVERY_FILE");
  return file.text();
}

function SettingsBody({ locale }: { locale: Locale }) {
  const { identity, status: initialStatus, code: remembered, ready, activate } = useEncryption();
  const labels = getEncryptionMessages(locale);
  const router = useRouter();
  const [localStatus, setStatus] = useState(initialStatus);
  const status = localStatus.revision >= initialStatus.revision ? localStatus : initialStatus;
  const [currentCode, setCurrentCode] = useState("");
  const [candidate, setCandidate] = useState<EncryptionCandidate | null>(null);
  const [verified, setVerified] = useState({ code: false, recovery: false, operation: false });
  const verifiedRef = useRef(verified);
  const [confirmed, setConfirmed] = useState(false);
  const [busy, setBusy] = useState(false);
  const [feedback, setFeedback] = useState<"failed" | "pending" | "completed" | "storageUnavailable" | "copiedCode" | "forgetFailed" | null>(null);
  const [showCode, setShowCode] = useState(false);
  const [progress, setProgress] = useState<{ completed: number; total: number }>();
  const [historyCode, setHistoryCode] = useState("");
  const [historyFile, setHistoryFile] = useState<File>();
  const [restoreCode, setRestoreCode] = useState("");
  const [sessionOnly, setSessionOnly] = useState(false);
  const [historyOpen, setHistoryOpen] = useState(false);
  const [restoreOpen, setRestoreOpen] = useState(false);
  const [restored, setRestored] = useState(false);
  const [forgetOpen, setForgetOpen] = useState(false);
  const forgetTrigger = useRef<HTMLButtonElement>(null);
  const forgetCancel = useRef<HTMLButtonElement>(null);
  const forgetting = useRef(false);

  useEffect(() => {
    let active = true;
    void loadClientEncryptionOperation(identity).then((value) => {
      if (!active || !value) return;
      const saved = value as { candidate: EncryptionCandidate; verified: typeof verified };
      if (saved.candidate?.identity.accountId === identity.accountId && saved.candidate.identity.householdId === identity.householdId && saved.candidate.identity.memberId === identity.memberId) {
        setCandidate(saved.candidate);
        verifiedRef.current = saved.verified;
        setVerified(saved.verified);
        setFeedback("pending");
      }
    }).catch(() => undefined).finally(() => { if (active) setRestored(true); });
    return () => { active = false; };
  }, [identity]);

  const activeCode = currentCode.trim() || remembered;
  const backedUp = verified.code && verified.recovery && verified.operation;

  async function saveLocal(value: EncryptionCandidate, proof = verified, token = encryptionClientGeneration()) {
    if (token !== encryptionClientGeneration()) return;
    try { await saveClientEncryptionOperation(identity, { candidate: value, verified: proof }); }
    catch { setFeedback("storageUnavailable"); }
  }

  async function prepare(kind: EncryptionCandidate["kind"]) {
    const finishDesktopOperation = beginDesktopOperation();
    if (!finishDesktopOperation) return;
    const token = encryptionClientGeneration();
    setBusy(true); setFeedback(null);
    try {
      const material = await post({ operation: "materials" }) as { status: EncryptionStatus; sealedKeyRing: string | null; recoveryRequired: boolean };
      setStatus(material.status);
      let previousRing;
      let previousCode: string | null = null;
      if (kind !== "ENABLE") {
        if (!activeCode || !material.sealedKeyRing) throw new Error("ENCRYPTION_REQUIRED");
        previousCode = activeCode;
        previousRing = await openKeyRing(parseHouseholdCode(activeCode), material.sealedKeyRing);
      } else if (material.recoveryRequired) {
        previousCode = historyCode.trim();
        previousRing = await readRecoveryFile(previousCode, await fileText(historyFile));
      }
      const value = await createEncryptionCandidate(identity, kind, material.status.revision, previousCode, previousRing);
      if (token !== encryptionClientGeneration()) return;
      setCandidate(value); verifiedRef.current = { code: false, recovery: false, operation: false }; setVerified(verifiedRef.current); setConfirmed(false);
      await saveLocal(value, { code: false, recovery: false, operation: false }, token);
    } catch { setFeedback("failed"); }
    finally { setBusy(false); finishDesktopOperation(); }
  }

  async function verify(kind: keyof typeof verified, file?: File) {
    if (!candidate) return;
    const finishDesktopOperation = beginDesktopOperation();
    if (!finishDesktopOperation) return;
    const token = encryptionClientGeneration();
    try {
      const text = await fileText(file);
      if (kind === "code" && text.trim() !== candidate.code) throw new Error("INVALID_RECOVERY_FILE");
      if (kind === "recovery") {
        if (text !== candidate.recoveryFile) throw new Error("INVALID_RECOVERY_FILE");
        await readRecoveryFile(candidate.code, text);
      }
      if (kind === "operation") {
        if (text !== candidate.operationFile) throw new Error("INVALID_RECOVERY_FILE");
        await restoreEncryptionCandidate(identity, candidate.code, text);
      }
      const proof = { ...verifiedRef.current, [kind]: true };
      if (token !== encryptionClientGeneration()) return;
      verifiedRef.current = proof;
      setVerified(proof);
      await saveLocal(candidate, proof, token);
    } catch { verifiedRef.current = { ...verifiedRef.current, [kind]: false }; setVerified(verifiedRef.current); setFeedback("failed"); }
    finally { finishDesktopOperation(); }
  }

  async function finish(result: Result, value: EncryptionCandidate, token: number) {
    if (token !== encryptionClientGeneration()) return;
    if (!result.operation || result.unknown || !matchesEncryptionReceipt(value, result.operation)) { setStatus(result.status); setFeedback("pending"); return; }
    if (result.operation.status === "COMMITTED") {
      // Verify the authoritative live package before promoting the candidate.
      const materials = await post({ operation: "materials" }) as { status: EncryptionStatus; sealedKeyRing: string | null };
      if (token !== encryptionClientGeneration()) return;
      let stored = true;
      if (value.kind !== "DISABLE") {
        const parsed = parseHouseholdCode(value.code);
        if (materials.sealedKeyRing !== value.candidateKeyRing || materials.status.generation !== parsed.generation || materials.status.keyVersion !== parsed.keyVersion) throw new Error("ENCRYPTION_CHANGED");
        await openKeyRing(parsed, materials.sealedKeyRing);
        if (token !== encryptionClientGeneration()) return;
        await rememberHouseholdCode(identity, value.code).catch(() => { stored = false; });
      }
      await clearClientEncryptionOperation(identity).catch(() => undefined);
      if (token !== encryptionClientGeneration()) return;
      activate(materials.status, value.kind === "DISABLE" ? null : value.code);
      setStatus(materials.status); setSessionOnly(!stored);
      setCandidate(null); setCurrentCode(""); setHistoryCode(""); setRestoreCode(""); setProgress(undefined); setFeedback("completed");
      router.refresh();
    } else if (result.operation.status === "ABORTED" || result.operation.status === "EXPIRED") {
      setStatus(result.status);
      await clearClientEncryptionOperation(identity).catch(() => undefined);
      setCandidate(null); setProgress(undefined); setFeedback(null); router.refresh();
    } else { setStatus(result.status); setFeedback("pending"); }
  }

  async function query() {
    const id = candidate?.id ?? status.operation?.id;
    if (!id) return;
    const finishDesktopOperation = beginDesktopOperation();
    if (!finishDesktopOperation) return;
    const token = encryptionClientGeneration();
    setBusy(true);
    try {
      const result = await post({ operation: "query", id }) as Result;
      if (candidate) await finish(result, candidate, token);
      else { setStatus(result.status); setFeedback("pending"); }
    } catch { setFeedback("pending"); }
    finally { setBusy(false); finishDesktopOperation(); }
  }

  async function run() {
    if (!candidate || !backedUp || !confirmed || busy) return;
    const finishDesktopOperation = beginDesktopOperation();
    if (!finishDesktopOperation) return;
    const token = encryptionClientGeneration();
    setBusy(true); setFeedback(null);
    let value = candidate;
    try {
      const body = () => ({ id: value.id, kind: value.kind, expectedRevision: value.expectedRevision,
        candidateCode: value.code, candidateKeyRing: value.candidateKeyRing, candidateRecoveryPackage: value.candidateRecoveryPackage,
        recoveryDigest: value.recoveryDigest, candidateBackedUp: true,
        ...(value.previousCode ? { encryption: { code: value.previousCode, revision: value.revision } } : {}),
      });
      // Recover the original receipt first; prepared state never means a new UUID.
      let result: Result;
      if (value.prepared) result = await post({ operation: "query", id: value.id }) as Result;
      else {
        value = { ...value, prepared: true };
        setCandidate(value);
        await saveLocal(value, verified, token);
        if (token !== encryptionClientGeneration()) return;
        result = await post({ operation: "prepare", id: value.id, kind: value.kind, expectedRevision: value.expectedRevision,
          candidateKeyRing: value.candidateKeyRing, candidateRecoveryPackage: value.candidateRecoveryPackage,
          recoveryDigest: value.recoveryDigest, candidateBackedUp: true }) as Result;
      }
      if (!result.operation || result.unknown) { setFeedback("pending"); return; }
      if (!matchesEncryptionReceipt(value, result.operation)) { setFeedback("pending"); return; }
      if (token !== encryptionClientGeneration()) return;
      if (result.operation.status === "COMMITTED" || result.operation.status === "ABORTED" || result.operation.status === "EXPIRED") { await finish(result, value, token); return; }
      value = { ...value, prepared: true, revision: result.status.revision };
      setCandidate(value); setStatus(result.status); await saveLocal(value, verified, token);
      if (value.kind !== "ROTATE") {
        while (!result.done) {
          if (token !== encryptionClientGeneration()) return;
          result = await post({ operation: "batch", ...body() }) as Result;
          if (token !== encryptionClientGeneration()) return;
          if (!result.operation || result.unknown || !matchesEncryptionReceipt(value, result.operation)) { setFeedback("pending"); return; }
          if (result.operation.status === "COMMITTED" || result.operation.status === "ABORTED" || result.operation.status === "EXPIRED") { await finish(result, value, token); return; }
          value = { ...value, revision: result.status.revision };
          setCandidate(value); setStatus(result.status); setProgress(result.progress);
          await saveLocal(value, verified, token);
        }
      }
      result = await post({ operation: "commit", ...body() }) as Result;
      await finish(result, value, token);
    } catch { setFeedback("pending"); }
    finally { setBusy(false); finishDesktopOperation(); }
  }

  async function abort() {
    if (!candidate || busy) return;
    const finishDesktopOperation = beginDesktopOperation();
    if (!finishDesktopOperation) return;
    const token = encryptionClientGeneration();
    setBusy(true);
    try { await finish(await post({ operation: "abort", id: candidate.id }) as Result, candidate, token); }
    catch { setFeedback("pending"); }
    finally { setBusy(false); finishDesktopOperation(); }
  }

  async function forget() {
    if (!forgetOpen || busy || forgetting.current) return;
    const finishDesktopOperation = beginDesktopOperation();
    if (!finishDesktopOperation) return;
    forgetting.current = true;
    setBusy(true);
    try { await forgetEncryptionIdentity(); setCurrentCode(""); setCandidate(null); router.refresh(); }
    catch { setCurrentCode(""); setFeedback("forgetFailed"); }
    finally { forgetting.current = false; setBusy(false); setForgetOpen(false); finishDesktopOperation(); }
  }

  return <section className="ios-panel my-4 space-y-5 p-5 md:p-6"
    data-desktop-update-blocked={!ready || !restored || busy || Boolean(candidate || status.operation) || undefined}
    data-desktop-update-dirty={Boolean(currentCode || historyCode || restoreCode) || undefined} data-testid="household-encryption-settings">
    <header className="space-y-2"><h2 className="text-base font-medium">{labels.title}</h2><p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.description}</p><p className="text-sm font-medium" role="status">{labels[status.mode]}</p></header>
    {ready && remembered && status.mode === "ENCRYPTED" ? <div className="space-y-3">
      <button className={secondary} onClick={() => setShowCode((value) => !value)} type="button">{showCode ? labels.hideCode : labels.showCode}</button>
      {showCode ? <><label className="block space-y-2 text-sm font-medium"><span>{labels.code}</span><textarea autoCapitalize="none" autoComplete="off" className="ios-field min-h-24" readOnly spellCheck={false} value={remembered} /></label><div className="flex flex-wrap gap-3"><button className={secondary} onClick={async () => { try { await navigator.clipboard.writeText(remembered); setFeedback("copiedCode"); } catch { setFeedback("failed"); } }} type="button">{labels.copyCode}</button><button className={secondary} onClick={() => download(remembered, `billboard-unlock-code-${identity.householdId}.json`)} type="button">{labels.saveCurrentCode}</button></div></> : null}
    </div> : null}
    {!status.isOwner ? <p className="text-sm text-[var(--bb-muted)]">{labels.ownerOnly}</p> : <>
      {status.mode !== "UNENCRYPTED" && !candidate ? <label className="block space-y-2 text-sm font-medium"><span>{labels.code}</span><textarea autoCapitalize="none" autoComplete="off" className="ios-field min-h-24" onChange={(event) => setCurrentCode(event.target.value)} placeholder={remembered ? "••••••••" : undefined} spellCheck={false} value={currentCode} /></label> : null}
      {status.mode === "UNENCRYPTED" && !candidate ? <details className="space-y-3" onToggle={(event) => { setHistoryOpen(event.currentTarget.open); if (!event.currentTarget.open) setHistoryCode(""); }} open={historyOpen}><summary className="min-h-11 cursor-pointer text-sm">{labels.recoveryFile}</summary>{historyOpen ? <><p className="text-xs leading-5 text-[var(--bb-muted)]">{labels.recoveryHelp}</p><label className="block space-y-2 text-sm"><span>{labels.recoveryCode}</span><textarea autoCapitalize="none" autoComplete="off" className="ios-field" onChange={(event) => setHistoryCode(event.target.value)} spellCheck={false} value={historyCode} /></label><input accept="application/json,.json" aria-label={labels.recoveryFile} onChange={(event) => setHistoryFile(event.target.files?.[0])} type="file" /></> : null}</details> : null}
      {!candidate && !status.operation ? <div className="flex flex-wrap gap-3">
        {status.mode === "UNENCRYPTED" ? <button className={secondary} disabled={busy || !ready} onClick={() => void prepare("ENABLE")} type="button">{labels.enable}</button> : status.mode === "ENCRYPTED" ? <><button className={secondary} disabled={busy || !ready} onClick={() => void prepare("ROTATE")} type="button">{labels.rotate}</button><button className={secondary} disabled={busy || !ready} onClick={() => void prepare("DISABLE")} type="button">{labels.disable}</button></> : null}
      </div> : null}
      {status.operation ? <p className="text-sm text-[var(--bb-muted)]">{labels.activeOperation}</p> : null}
      {candidate ? <div className="space-y-5 rounded-xl border border-[var(--bb-warm-line)] p-4" data-testid="encryption-candidate">
        {candidate.kind === "DISABLE" ? <p className="text-sm leading-6">{labels.disableHelp}</p> : null}
        <label className="block space-y-2 text-sm font-medium"><span>{candidate.kind === "DISABLE" ? labels.code : labels.newCode}</span><textarea autoCapitalize="none" autoComplete="off" className="ios-field min-h-28" readOnly spellCheck={false} value={candidate.code} /></label>
        <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.backupHelp}</p>
        {(["code", "recovery", "operation"] as const).map((kind) => <div className="space-y-2" key={kind}>
          <button className={secondary} disabled={busy} onClick={() => download(kind === "code" ? candidate.code : kind === "recovery" ? candidate.recoveryFile : candidate.operationFile, `billboard-${kind}-${candidate.id}.json`)} type="button">{kind === "code" ? labels.saveCode : kind === "recovery" ? labels.backup : labels.saveOperation}</button>
          <label className="block space-y-2 text-xs text-[var(--bb-muted)]"><span>{verified[kind] ? labels.backupVerified : labels.verifyBackup}</span><input accept="application/json,.json,text/plain,.txt" disabled={busy} onChange={(event) => void verify(kind, event.target.files?.[0])} type="file" /></label>
        </div>)}
        <label className="flex min-h-11 items-start gap-3 text-sm leading-6"><input checked={confirmed} className="mt-1.5" disabled={busy} onChange={(event) => setConfirmed(event.target.checked)} type="checkbox" />{labels.confirmed}</label>
        <div className="flex flex-wrap gap-3"><button className="min-h-11 rounded-xl bg-[var(--bb-primary)] px-4 py-3 text-sm font-medium text-white disabled:opacity-50" disabled={busy || !backedUp || !confirmed} onClick={() => void run()} type="button">{busy ? labels.working : labels.submit}</button><button className={secondary} disabled={busy} onClick={() => void abort()} type="button">{labels.cancel}</button></div>
      </div> : null}
      <details className="space-y-3" onToggle={(event) => { setRestoreOpen(event.currentTarget.open); if (!event.currentTarget.open) setRestoreCode(""); }} open={restoreOpen}><summary className="min-h-11 cursor-pointer text-sm">{labels.restoreOperation}</summary>{restoreOpen ? <><label className="block space-y-2 text-sm"><span>{labels.newCode}</span><textarea autoCapitalize="none" autoComplete="off" className="ios-field" onChange={(event) => setRestoreCode(event.target.value)} spellCheck={false} value={restoreCode} /></label><input accept="application/json,.json" aria-label={labels.restoreOperation} disabled={busy} onChange={async (event) => {
        const finishDesktopOperation = beginDesktopOperation();
        if (!finishDesktopOperation) return;
        setBusy(true);
        const token = encryptionClientGeneration();
        try { const value = await restoreEncryptionCandidate(identity, restoreCode, await fileText(event.target.files?.[0])); if (token !== encryptionClientGeneration()) return; const recovered = { ...value, prepared: true }; setCandidate(recovered); verifiedRef.current = { code: false, recovery: false, operation: false }; setVerified(verifiedRef.current); setFeedback("pending"); await saveLocal(recovered, verifiedRef.current, token); }
        catch { setFeedback("failed"); }
        finally { setBusy(false); finishDesktopOperation(); }
      }} type="file" /></> : null}</details>
      {candidate?.prepared || status.operation || feedback === "pending" ? <button className={secondary} disabled={busy} onClick={() => void query()} type="button">{labels.query}</button> : null}
    </>}
    {progress ? <p className="text-sm tabular-nums" role="status">{progress.completed} / {progress.total}</p> : null}
    {feedback ? <p className="text-sm leading-6" role={feedback === "failed" ? "alert" : "status"}>{labels[feedback]}</p> : null}
    {feedback === "completed" ? <p className="text-xs leading-5 text-[var(--bb-muted)]">{labels.cleanupOperation}</p> : null}
    {feedback === "completed" && sessionOnly ? <p className="text-sm leading-6 text-[var(--bb-danger)]" role="alert">{labels.keySessionOnly}</p> : null}
    <button className={secondary} disabled={busy} onClick={() => setForgetOpen(true)} ref={forgetTrigger} type="button">{labels.forget}</button>
    <BottomSheet closeLabel={labels.cancel} initialFocusRef={forgetCancel} onClose={() => { if (!busy) setForgetOpen(false); }} open={forgetOpen} returnFocusRef={forgetTrigger} title={labels.forgetTitle}
      footer={<div aria-busy={busy || undefined} className="flex flex-wrap justify-end gap-3">
        <button className={secondary} disabled={busy} onClick={() => setForgetOpen(false)} ref={forgetCancel} type="button">{labels.cancel}</button>
        <button className="min-h-11 rounded-xl bg-[var(--bb-danger)] px-4 py-2 text-sm font-medium text-white hover:opacity-90 disabled:opacity-50" disabled={busy} onClick={forget} type="button">{busy ? labels.working : labels.forgetConfirm}</button>
      </div>}>
      <p className="text-sm leading-7 text-[var(--bb-muted)]">{labels.forgetHelp}</p>
    </BottomSheet>
  </section>;
}

export function EncryptionSettings({ identity, status, locale }: { identity: EncryptionIdentity; status: EncryptionStatus; locale: Locale }) {
  return <EncryptionProvider identity={identity} locale={locale} status={status}><SettingsBody locale={locale} /></EncryptionProvider>;
}
