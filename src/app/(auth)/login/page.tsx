"use client";

import { signIn } from "next-auth/react";
import { useState } from "react";

export default function LoginPage() {
  const [error, setError] = useState("");

  return (
    <main className="mx-auto flex min-h-screen max-w-md flex-col justify-center px-6">
      <h1 className="text-3xl font-semibold">Household Accounting</h1>
      <form
        className="mt-8 space-y-4 rounded-2xl bg-white p-6 shadow-sm"
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
        <input name="email" type="email" required className="w-full rounded-xl border px-3 py-2" />
        <input name="password" type="password" required className="w-full rounded-xl border px-3 py-2" />
        {error ? <p className="text-sm text-red-600">{error}</p> : null}
        <button className="w-full rounded-xl bg-stone-900 px-4 py-3 text-white" type="submit">
          Log in
        </button>
      </form>
    </main>
  );
}
