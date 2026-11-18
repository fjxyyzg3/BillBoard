"use client";

import { forgetEncryptionIdentity } from "@/components/encryption-lifecycle";
import { finishReauthenticationAction } from "@/app/account/actions";
import { createContext, useContext, useEffect, useId, useRef, useState, type ReactNode } from "react";
import { useRouter } from "next/navigation";
import type { Messages } from "@/lib/i18n";
import type { IdentityFormResult } from "./identity-types";

export const identityButtonClass = "bb-tap inline-flex min-h-11 max-w-full items-center justify-center rounded-xl bg-[var(--bb-warm-surface)] px-4 py-2 text-center text-sm font-medium text-[var(--bb-ink)] transition-colors hover:bg-[var(--bb-accent-soft)] disabled:cursor-wait disabled:opacity-60";

const IdentityFieldErrorContext = createContext<{ name: string; id: string; message: string } | null>(null);

export function identityErrorMessage(code: string, labels: Messages["identity"]) {
  const aliases: Record<string, keyof Messages["identity"]["errors"]> = { PASSWORD_INVALID: "INVALID_PASSWORD" };
  const key = aliases[code] ?? code;
  return key in labels.errors ? labels.errors[key as keyof typeof labels.errors] : labels.errors.SERVICE_UNAVAILABLE;
}

export function IdentityField({ name, label, type = "text", autoComplete, minLength, maxLength = 128, defaultValue }: {
  name: string; label: string; type?: "text" | "password" | "email"; autoComplete?: string; minLength?: number; maxLength?: number; defaultValue?: string;
}) {
  const validation = useContext(IdentityFieldErrorContext);
  const error = validation?.name === name ? validation : null;
  return <div className="space-y-2">
    <label className="block space-y-2">
      <span className="text-sm text-[var(--bb-muted)]">{label}</span>
      <input aria-describedby={error?.id} aria-invalid={error ? true : undefined} autoCapitalize={type === "email" ? "none" : undefined} autoComplete={autoComplete} className="ios-field min-h-11 w-full" defaultValue={defaultValue} maxLength={autoComplete === "current-password" ? undefined : maxLength} minLength={minLength} name={name} required type={type} />
    </label>
    {error ? <p className="text-sm leading-6 text-[var(--ios-red)]" id={error.id} role="alert">{error.message}</p> : null}
  </div>;
}

export function IdentityForm({ action, labels, children, submitLabel, confirmation, comparePasswords, refresh = false, successMessage, onSuccess, cooldown }: {
  action: (form: FormData) => Promise<IdentityFormResult>;
  labels: Messages["identity"];
  children?: ReactNode;
  submitLabel: string;
  confirmation?: string;
  comparePasswords?: boolean;
  refresh?: boolean;
  successMessage?: string;
  onSuccess?: () => void;
  cooldown?: { seconds: number; label: (seconds: number) => string };
}) {
  const [pending, setPending] = useState(false);
  const [dirty, setDirty] = useState(false);
  const [feedback, setFeedback] = useState<{ error: boolean; text: string; field?: "confirmPassword" } | null>(null);
  const [cooldownRemaining, setCooldownRemaining] = useState(0);
  const cooldownDeadline = useRef(0);
  const submitting = useRef(false);
  const formRef = useRef<HTMLFormElement>(null);
  const fieldErrorId = useId();
  const router = useRouter();
  const coolingDown = cooldownRemaining > 0;
  useEffect(() => {
    if (feedback?.field === "confirmPassword") formRef.current?.querySelector<HTMLInputElement>('[name="confirmPassword"]')?.focus();
  }, [feedback]);
  useEffect(() => {
    if (!coolingDown) return;
    const timer = window.setInterval(() => {
      setCooldownRemaining(Math.max(0, Math.ceil((cooldownDeadline.current - Date.now()) / 1_000)));
    }, 1_000);
    return () => window.clearInterval(timer);
  }, [coolingDown]);
  return <form aria-busy={pending || undefined} className="space-y-4" data-desktop-update-dirty={dirty || undefined} method="post" ref={formRef}
    onInput={(event) => {
      setDirty(true);
      const name = (event.target as HTMLInputElement).name;
      if (name === "newPassword" || name === "confirmPassword") setFeedback((current) => current?.field ? null : current);
    }} onReset={() => { setDirty(false); setFeedback(null); }} onSubmit={async (event) => {
    event.preventDefault();
    if (submitting.current || Date.now() < cooldownDeadline.current) return;
    const form = event.currentTarget;
    const data = new FormData(form);
    if (confirmation && data.get("confirmed") !== "on") {
      setFeedback({ error: true, text: labels.confirmImpact });
      return;
    }
    if (comparePasswords && data.get("newPassword") !== data.get("confirmPassword")) {
      setFeedback({ error: true, text: labels.passwordMismatch, field: "confirmPassword" });
      return;
    }
    submitting.current = true;
    if (cooldown) {
      cooldownDeadline.current = Date.now() + cooldown.seconds * 1_000;
      setCooldownRemaining(cooldown.seconds);
    }
    setPending(true);
    setFeedback(null);
    try {
      const result = await action(data);
      if (!result.ok) {
        setFeedback({ error: true, text: identityErrorMessage(result.code, labels) });
      } else if (result.data.reauthenticate) {
        await forgetEncryptionIdentity();
        await finishReauthenticationAction();
      } else {
        form.reset();
        setFeedback({ error: false, text: successMessage ?? (result.data.message === "accepted" ? labels.accepted : result.data.message === "sent" ? labels.sent : labels.saved) });
        onSuccess?.();
        if (refresh) router.refresh();
      }
    } catch (error) {
      setFeedback({ error: true, text: identityErrorMessage(error instanceof Error ? error.message : "SERVICE_UNAVAILABLE", labels) });
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }}>
    <fieldset className="min-w-0 space-y-4" disabled={pending}>
      <IdentityFieldErrorContext.Provider value={feedback?.field ? { name: feedback.field, id: fieldErrorId, message: feedback.text } : null}>{children}</IdentityFieldErrorContext.Provider>
      {confirmation ? <label className="flex min-h-11 items-start gap-3 text-sm leading-6 text-[var(--bb-ink)]"><input className="mt-1.5 h-4 w-4 shrink-0" name="confirmed" required type="checkbox" /><span className="min-w-0 break-words">{confirmation}</span></label> : null}
      <button className={identityButtonClass} disabled={pending || coolingDown} type="submit">{pending ? labels.working : coolingDown && cooldown ? cooldown.label(cooldownRemaining) : submitLabel}</button>
    </fieldset>
    {feedback && !feedback.field ? <p className={`text-sm leading-6 ${feedback.error ? "text-[var(--ios-red)]" : "text-[var(--bb-muted)]"}`} role={feedback.error ? "alert" : "status"}>{feedback.text}</p> : null}
  </form>;
}
