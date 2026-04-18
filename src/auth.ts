import { PrismaAdapter } from "@auth/prisma-adapter";
import argon2 from "argon2";
import type { Session } from "next-auth";
import NextAuth from "next-auth";
import Credentials from "next-auth/providers/credentials";
import GitHub from "next-auth/providers/github";
import { db } from "@/lib/db";

export type AppSessionUser = NonNullable<Session["user"]> & {
  id: string;
  memberId: string;
  householdId: string;
};

type AuthorizedUser = {
  id: string;
  email: string;
  name: string;
};

const authSecret =
  process.env.AUTH_SECRET ??
  process.env.NEXTAUTH_SECRET ??
  (process.env.NODE_ENV === "production" ? undefined : "development-auth-secret");

export const { handlers, auth, signIn, signOut } = NextAuth({
  adapter: PrismaAdapter(db),
  secret: authSecret,
  session: { strategy: "database" },
  pages: { signIn: "/login" },
  providers: [
    GitHub({
      clientId: process.env.AUTH_GITHUB_ID ?? "unused-client-id",
      clientSecret: process.env.AUTH_GITHUB_SECRET ?? "unused-client-secret",
    }),
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials) => {
        const email = String(credentials?.email ?? "")
          .trim()
          .toLowerCase();
        const password = String(credentials?.password ?? "");
        const user = await db.user.findUnique({
          where: { email },
          include: { householdMember: true },
        });

        if (!user || !user.householdMember || user.status !== "ACTIVE") {
          return null;
        }

        const valid = await argon2.verify(user.passwordHash, password);

        if (!valid) {
          return null;
        }

        return {
          id: user.id,
          email: user.email,
          name: user.displayName,
        } satisfies AuthorizedUser;
      },
    }),
  ],
  callbacks: {
    authorized: ({ auth }) => Boolean(auth?.user),
    session: async ({ session, user }) => {
      if (!session.user) {
        return session;
      }

      const member = await db.householdMember.findUnique({
        where: { userId: user.id },
      });

      if (!member) {
        return session;
      }

      const databaseUser = user as typeof user & { displayName?: string };
      const sessionUser = session.user as AppSessionUser;

      sessionUser.id = user.id;
      sessionUser.email = user.email;
      sessionUser.name = databaseUser.displayName ?? user.name;
      sessionUser.memberId = member.id;
      sessionUser.householdId = member.householdId;

      return session;
    },
  },
});
