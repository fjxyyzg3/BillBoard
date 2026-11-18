"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import type { IosInstallOffer } from "@/lib/ios-install";
import type { Messages } from "@/lib/i18n";

type LinkGrant = { url: string; expiresAt: number };
type Props = { offer: IosInstallOffer; labels: Messages["help"]["iosInstall"]; grantUrl: string };
const actionClass = "bb-tap inline-flex min-h-11 items-center rounded-xl border border-[var(--bb-warm-line)] px-4 text-sm font-medium text-[var(--bb-primary)] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 disabled:opacity-60";

export function IosInstall({ offer, labels, grantUrl }: Props) {
  const [grant, setGrant] = useState<LinkGrant>();
  const [pending, setPending] = useState(false);
  const [status, setStatus] = useState("");

  useEffect(() => {
    if (!grant) return;
    const expire = () => {
      if (Date.now() < grant.expiresAt) return;
      setGrant(undefined);
      setStatus(labels.expired);
    };
    const timer = window.setTimeout(expire, Math.max(0, grant.expiresAt - Date.now()));
    document.addEventListener("visibilitychange", expire);
    return () => {
      window.clearTimeout(timer);
      document.removeEventListener("visibilitychange", expire);
    };
  }, [grant, labels.expired]);

  async function requestInstall() {
    setPending(true);
    setStatus(labels.preparing);
    try {
      const response = await fetch(grantUrl, { method: "POST", cache: "no-store", credentials: "same-origin", redirect: "error" });
      if (!response.ok) throw new Error("Installation unavailable");
      const result = await response.json() as LinkGrant;
      const url = new URL(result.url);
      if (url.protocol !== "itms-services:" || url.searchParams.get("action") !== "download-manifest"
        || new URL(url.searchParams.get("url") ?? "").origin !== window.location.origin
        || !Number.isFinite(result.expiresAt) || result.expiresAt <= Date.now()) throw new Error("Invalid installation link");
      setGrant(result);
      setStatus(labels.ready);
    } catch {
      setGrant(undefined);
      setStatus(labels.failed);
    } finally {
      setPending(false);
    }
  }

  return <section aria-labelledby="ios-install-title" className="ios-panel my-8 scroll-mt-6 space-y-3 p-5 sm:p-6" id="ios-install">
    <h2 className="text-xl font-medium tracking-tight" id="ios-install-title">{labels.title}</h2>
    <p className="text-sm leading-6 text-[var(--bb-muted)]">{labels.description}</p>
    {offer.status === "sign-in" && <Link className={actionClass} href="/login?intent=ios-install" prefetch={false}>{labels.signIn}</Link>}
    {offer.status === "unavailable" && <p className="text-sm text-[var(--bb-muted)]">{labels.unavailable}</p>}
    {offer.status === "available" && <>
      <p className="text-sm">{labels.version} {offer.version} ({offer.build})</p>
      {grant ? <a className={actionClass} href={grant.url} referrerPolicy="no-referrer"
        onClick={(event) => {
          if (Date.now() < grant.expiresAt) return;
          event.preventDefault();
          setGrant(undefined);
          setStatus(labels.expired);
        }}>{labels.install}</a>
        : <button className={actionClass} disabled={pending} onClick={() => void requestInstall()} type="button">{labels.request}</button>}
      <p className="text-sm text-[var(--bb-muted)]" role="status">{status}</p>
    </>}
  </section>;
}
