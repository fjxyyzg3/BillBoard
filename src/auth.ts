import argon2 from "argon2";
import type { Session } from "next-auth";
import NextAuth from "next-auth";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "@/auth.config";
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
  memberId: string;
  householdId: string;
};

const authSecret =
  process.env.AUTH_SECRET ??
  process.env.NEXTAUTH_SECRET ??
  (process.env.NODE_ENV === "production" ? undefined : "development-auth-secret");

type AppToken = JWT & {
  memberId?: string;
  householdId?: string;
};

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  secret: authSecret,
  session: { strategy: "jwt" },
  providers: [
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
          memberId: user.householdMember.id,
          householdId: user.householdMember.householdId,
        } satisfies AuthorizedUser;
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    jwt: async ({ token, user }) => {
      if (!user) {
        return token;
      }

      const authorizedUser = user as AuthorizedUser;
      const appToken = token as AppToken;

      appToken.sub = authorizedUser.id;
      appToken.email = authorizedUser.email;
      appToken.name = authorizedUser.name;
      appToken.memberId = authorizedUser.memberId;
      appToken.householdId = authorizedUser.householdId;

      return appToken;
    },
    session: async ({ session, token }) => {
      if (!session.user) {
        return session;
      }

      if (
        !token.sub ||
        typeof token.email !== "string" ||
        typeof token.name !== "string" ||
        typeof token.memberId !== "string" ||
        typeof token.householdId !== "string"
      ) {
        return session;
      }

      Object.assign(session.user, {
        id: token.sub,
        email: token.email,
        name: token.name,
        memberId: token.memberId,
        householdId: token.householdId,
      } satisfies AppSessionUser);

      return session;
    },
  },
});
