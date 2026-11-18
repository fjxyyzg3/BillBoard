"use client";

import { useRouter } from "next/navigation";
import { SessionProvider, signIn } from "next-auth/react";
import { useRef, useState, useSyncExternalStore } from "react";
import type { Messages } from "@/lib/i18n";

type LoginFormProps = {
  authBasePath: string;
  labels: Messages["login"];
  forIosInstall?: boolean;
};

function subscribeToHydration() {
  return () => {};
}

function getHydratedSnapshot() {
  return true;
}

function getServerHydrationSnapshot() {
  return false;
}

export function LoginForm({ authBasePath, labels, forIosInstall }: LoginFormProps) {
  const [error, setError] = useState("");
  const [pending, setPending] = useState(false);
  const submittingRef = useRef(false);
  const isHydrated = useSyncExternalStore(
    subscribeToHydration,
    getHydratedSnapshot,
    getServerHydrationSnapshot,
  );
  const router = useRouter();

  return (
    <SessionProvider basePath={authBasePath} session={null}>
      <form
        aria-busy={pending || undefined}
        className="ios-panel space-y-5 p-5 sm:p-6"
        method="post"
        onSubmit={async (event) => {
          event.preventDefault();
          if (submittingRef.current) return;
          submittingRef.current = true;
          setPending(true);
          setError("");

          const formData = new FormData(event.currentTarget);
          const login = () => signIn("credentials", {
            email: formData.get("email"),
            password: formData.get("password"),
            redirect: false,
          });
          try {
            let result = await login();
            // Initialization can replace the CSRF cookie before the first callback.
            // Refresh through Auth.js once; credential failures are never retried.
            if (result?.error === "MissingCSRF") result = await login();

            if (result?.error) {
              setError(
                result.code === "rate_limited" ? labels.rateLimited : labels.invalidCredentials,
              );
              return;
            }

            if (forIosInstall) router.replace("/help#ios-install");
            else router.replace("/home");
          } catch {
            setError(labels.unavailable);
          } finally {
            submittingRef.current = false;
            setPending(false);
          }
        }}
      >
        <label className="block space-y-2">
          <span className="text-sm text-[var(--ios-muted)]">{labels.email}</span>
          <input autoComplete="username" autoCapitalize="none" className="ios-field w-full" name="email" required type="email" />
        </label>
        <label className="block space-y-2">
          <span className="text-sm text-[var(--ios-muted)]">{labels.password}</span>
          <input autoComplete="current-password" className="ios-field w-full" name="password" required type="password" />
        </label>
        {error ? <p className="text-sm text-[var(--ios-red)]" role="alert">{error}</p> : null}
        <button
          className="bb-tap min-h-12 w-full rounded-xl bg-[var(--bb-primary)] px-4 py-3 text-sm font-medium text-white hover:bg-[var(--bb-primary-hover)] disabled:cursor-wait disabled:opacity-60"
          disabled={!isHydrated || pending}
          type="submit"
        >
          {pending ? labels.submitting : labels.submit}
        </button>
      </form>
    </SessionProvider>
  );
}
