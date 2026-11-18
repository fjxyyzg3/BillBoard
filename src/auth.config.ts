import type { NextAuthConfig } from "next-auth";

export const authConfig = {
  providers: [],
  trustHost: true,
  pages: { signIn: "/login" },
  callbacks: {
    authorized: ({ auth }) => Boolean(auth?.user),
  },
} satisfies NextAuthConfig;
