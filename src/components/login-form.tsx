"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";
import type { Messages } from "@/lib/i18n";

type LoginFormProps = {
  labels: Messages["login"];
};

export function LoginForm({ labels }: LoginFormProps) {
  const [error, setError] = useState("");

  return (
    <form
      className="ios-panel space-y-4 p-5"
      onSubmit={async (event) => {
        event.preventDefault();
        setError("");

        const formData = new FormData(event.currentTarget);
        const result = await signIn("credentials", {
          email: formData.get("email"),
          password: formData.get("password"),
          redirect: false,
        });

        if (result?.error) {
          setError(labels.invalidCredentials);
          return;
        }

        window.location.href = "/home";
      }}
    >
      <label className="block space-y-2">
        <span className="text-sm font-medium text-[var(--ios-text)]">{labels.email}</span>
        <input className="ios-field w-full" name="email" required type="email" />
      </label>
      <label className="block space-y-2">
        <span className="text-sm font-medium text-[var(--ios-text)]">{labels.password}</span>
        <input className="ios-field w-full" name="password" required type="password" />
      </label>
      {error ? <p className="text-sm text-[var(--ios-red)]">{error}</p> : null}
      <button
        className="w-full rounded-2xl bg-[var(--ios-blue)] px-4 py-3 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(0,122,255,0.22)] transition hover:bg-[#006ee6]"
        type="submit"
      >
        {labels.submit}
      </button>
    </form>
  );
}
