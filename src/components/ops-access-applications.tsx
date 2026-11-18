"use client";

import { useRef, useState } from "react";
import Link from "next/link";
import { useRouter } from "next/navigation";
import { decideAccessApplicationAction, retryAccessApplicationMailAction, type AccessApplicationDecisionResult, type getAccessApplicationsForOps } from "@/app/ops/actions";
import { formatLocaleDateTime, getMessages, type Locale } from "@/lib/i18n";
import { identityButtonClass, identityErrorMessage } from "./identity-form";

type Application = Awaited<ReturnType<typeof getAccessApplicationsForOps>>[number];

export function OpsAccessApplications({ applications, locale, page }: { applications: Application[]; locale: Locale; page: number }) {
  const labels = getMessages(locale).ops.accessApplications;
  const router = useRouter();
  return <section aria-labelledby="access-applications-title" className="ios-panel p-4 sm:p-5">
    <div className="flex flex-wrap items-center justify-between gap-3">
      <h2 className="text-base font-medium" id="access-applications-title">{labels.title}</h2>
      <button className={identityButtonClass} onClick={() => router.refresh()} type="button">{labels.refresh}</button>
    </div>
    <p className="mb-4 mt-2 text-sm leading-6 text-[var(--bb-muted)]">{labels.description}</p>
    {!applications.length ? <p className="text-sm text-[var(--bb-muted)]">{labels.empty}</p> : <ul className="divide-y divide-[var(--bb-warm-line)]">
      {applications.map((application) => <ApplicationRow application={application} key={`${application.id}:${application.status}:${application.mailStatus}:${application.canRetry}`} locale={locale} />)}
    </ul>}
    {page > 1 || applications.length === 100 ? <nav aria-label={labels.pagination} className="mt-5 flex flex-wrap items-center gap-4 border-t border-[var(--bb-warm-line)] pt-4">
      {page > 1 ? <Link className={identityButtonClass} href={`/ops?applicationsPage=${page - 1}`} prefetch={false}>{labels.previous}</Link> : null}
      <span className="text-sm tabular-nums text-[var(--bb-muted)]">{labels.page(page)}</span>
      {applications.length === 100 && page < 1_000 ? <Link className={identityButtonClass} href={`/ops?applicationsPage=${page + 1}`} prefetch={false}>{labels.next}</Link> : null}
    </nav> : null}
  </section>;
}

function ApplicationRow({ application, locale }: { application: Application; locale: Locale }) {
  const messages = getMessages(locale);
  const labels = messages.ops.accessApplications;
  const router = useRouter();
  const [pending, setPending] = useState(false);
  const submitting = useRef(false);
  const [result, setResult] = useState<AccessApplicationDecisionResult | null>(null);
  const status = result?.ok ? result.data.status : application.status;
  const mailStatus = result?.ok ? result.data.mailStatus : application.mailStatus;
  const canRetry = status !== "PENDING" && (result?.ok ? mailStatus === "FAILED" : application.canRetry);

  async function submit(decision?: "APPROVED" | "REJECTED") {
    if (submitting.current) return;
    submitting.current = true;
    setPending(true);
    const form = new FormData();
    form.set("applicationId", application.id);
    if (decision) form.set("decision", decision);
    try {
      const response = await (decision ? decideAccessApplicationAction(form) : retryAccessApplicationMailAction(form));
      setResult(response);
      router.refresh();
    } catch {
      setResult({ ok: false, code: "SERVICE_UNAVAILABLE" });
    } finally {
      submitting.current = false;
      setPending(false);
    }
  }

  return <li aria-busy={pending || undefined} className="space-y-3 py-5 first:pt-2 last:pb-0">
    <div className="flex flex-wrap items-baseline justify-between gap-2">
      <h3 className="min-w-0 break-all text-sm font-medium">{application.email}</h3>
      <p className="text-sm font-medium">{labels.status[status]}</p>
    </div>
    <dl className="grid gap-x-6 gap-y-2 text-xs leading-5 text-[var(--bb-muted)] sm:grid-cols-2">
      <div className="min-w-0 sm:col-span-2"><dt>{labels.note}</dt><dd className="whitespace-pre-wrap break-words text-sm leading-6 text-[var(--bb-ink)] [overflow-wrap:anywhere]">{application.note ?? labels.noteEmpty}</dd></div>
      <div className="min-w-0"><dt>{labels.applicationId}</dt><dd className="break-all">{application.id}</dd></div>
      <div><dt>{labels.createdAt}</dt><dd><time className="tabular-nums">{formatLocaleDateTime(new Date(application.createdAt), locale)}</time></dd></div>
      <div><dt>{labels.verifiedAt}</dt><dd>{application.verifiedAt ? <time className="tabular-nums">{formatLocaleDateTime(new Date(application.verifiedAt), locale)}</time> : labels.awaitingVerification}</dd></div>
      {application.decidedAt ? <div><dt>{labels.decidedAt}</dt><dd><time className="tabular-nums">{formatLocaleDateTime(new Date(application.decidedAt), locale)}</time></dd></div> : null}
    </dl>
    {status !== "PENDING" ? <p className={`text-sm ${mailStatus === "FAILED" ? "text-[var(--ios-red)]" : "text-[var(--bb-muted)]"}`}>{labels.mailStatus[mailStatus]}</p> : null}
    <div className="flex flex-wrap gap-3">
      {status === "PENDING" && application.verifiedAt ? <>
        <button className={identityButtonClass} disabled={pending} onClick={() => void submit("APPROVED")} type="button">{labels.approve}</button>
        <button className={identityButtonClass} disabled={pending} onClick={() => void submit("REJECTED")} type="button">{labels.reject}</button>
      </> : null}
      {canRetry ? <button className={identityButtonClass} disabled={pending} onClick={() => void submit()} type="button">{labels.retry}</button> : null}
    </div>
    {canRetry ? <p className="text-xs leading-6 text-[var(--bb-muted)]">{labels.retryHelp}</p> : null}
    {pending ? <p className="text-sm text-[var(--bb-muted)]" role="status">{messages.identity.working}</p> : result ? <p className={`text-sm leading-6 ${!result.ok || result.data.mailStatus === "FAILED" ? "text-[var(--ios-red)]" : "text-[var(--bb-muted)]"}`} role={!result.ok ? "alert" : "status"}>{!result.ok ? identityErrorMessage(result.code, messages.identity) : result.data.mailStatus === "FAILED" ? labels.failed : labels.saved}</p> : null}
  </li>;
}
