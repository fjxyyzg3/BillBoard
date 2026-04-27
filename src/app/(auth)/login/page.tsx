"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

export default function LoginPage() {
  const [error, setError] = useState("");

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-5 py-10">
      <header className="mb-8 space-y-2">
        <p className="text-sm font-medium text-[var(--ios-muted)]">BillBoard</p>
        <h1 className="text-3xl font-semibold tracking-normal text-[var(--ios-text)]">
          Household Accounting
        </h1>
        <p className="text-sm text-[var(--ios-muted)]">
          Sign in to your shared household ledger.
        </p>
      </header>
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
            setError("Invalid email or password");
            return;
          }

          window.location.href = "/home";
        }}
      >
        <label className="block space-y-2">
          <span className="text-sm font-medium text-[var(--ios-text)]">Email</span>
          <input
            className="ios-field w-full"
            name="email"
            required
            type="email"
          />
        </label>
        <label className="block space-y-2">
          <span className="text-sm font-medium text-[var(--ios-text)]">Password</span>
          <input
            className="ios-field w-full"
            name="password"
            required
            type="password"
          />
        </label>
        {error ? <p className="text-sm text-[var(--ios-red)]">{error}</p> : null}
        <button
          className="w-full rounded-2xl bg-[var(--ios-blue)] px-4 py-3 text-sm font-semibold text-white shadow-[0_10px_24px_rgba(0,122,255,0.22)] transition hover:bg-[#006ee6]"
          type="submit"
        >
          Log in
        </button>
      </form>
    </main>
  );
}
