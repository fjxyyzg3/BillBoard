import { AppEventType } from "@prisma/client";
import type { Session } from "next-auth";
import NextAuth, { CredentialsSignin } from "next-auth";
import type { JWT } from "next-auth/jwt";
import Credentials from "next-auth/providers/credentials";
import { authConfig } from "@/auth.config";
import {
  ensureAppSessionForToken,
  loadValidAccountSessionUser,
  type AccountSessionUser,
} from "@/lib/auth/app-sessions";
import { normalizeCredentialEmail } from "@/lib/auth/credentials";
import { verifyLoginCredentials } from "@/lib/auth/login-admission";
import { recordAppEvent } from "@/lib/ops/record-event";
import { revokeVerifiedSignOutSession } from "@/lib/auth/sign-out-event";
import { markAuthStorageUnavailable } from "@/lib/auth/storage-availability";

export type { AppSessionUser } from "@/lib/auth/app-sessions";

type AuthorizedUser = {
  appSessionId: string;
  id: string;
  email: string;
  name: string;
  memberId?: string;
  householdId?: string;
};

const authSecret =
  process.env.AUTH_SECRET ??
  process.env.NEXTAUTH_SECRET ??
  (process.env.NODE_ENV === "production" ? undefined : "development-auth-secret");

type AppToken = JWT & {
  appSessionId?: string;
  appSessionKey?: string;
  memberId?: string;
  householdId?: string;
};

export type AppAuthSession = Session & {
  authError?: "SESSION_INVALID";
};

class LoginRateLimited extends CredentialsSignin {
  code = "rate_limited";
}

async function recordLoginFailedEvent(summary = "登录失败") {
  await recordAppEvent({
    eventType: AppEventType.LOGIN_FAILED,
    summary,
  }).catch(() => undefined);
}

async function recordLoginSuccessEvent(user: Pick<AuthorizedUser, "householdId" | "memberId">) {
  await recordAppEvent({
    eventType: AppEventType.LOGIN_SUCCESS,
    householdId: user.householdId,
    memberId: user.memberId,
    path: "/login",
    summary: "登录成功",
  }).catch(() => undefined);
}

export const { handlers, auth, signIn, signOut } = NextAuth({
  ...authConfig,
  secret: authSecret,
  session: { strategy: "jwt" },
  events: {
    signOut: async (message) => {
      if ("token" in message) await revokeVerifiedSignOutSession(message.token);
    },
  },
  providers: [
    Credentials({
      credentials: {
        email: { label: "Email", type: "email" },
        password: { label: "Password", type: "password" },
      },
      authorize: async (credentials, request) => {
        const email = normalizeCredentialEmail(credentials?.email);
        const password = String(credentials?.password ?? "");

        if (!email) {
          return null;
        }

        const result = await verifyLoginCredentials(email, password);

        if (result.status === "rate_limited") {
          throw new LoginRateLimited();
        }

        if (result.status === "rejected") {
          return null;
        }

        if (result.status === "invalid") {
          await recordLoginFailedEvent();
          return null;
        }

        const user = result.user;
        const appSessionId = await ensureAppSessionForToken({}, {
          appSessionUserAgent: request?.headers.get("user-agent") ?? null,
          id: user.id, email: user.email, passwordHash: user.passwordHash,
          memberId: user.householdMember[0]?.id, householdId: user.householdMember[0]?.householdId,
        });
        if (!appSessionId) {
          await recordLoginFailedEvent();
          return null;
        }
        const authorizedUser = {
          appSessionId,
          id: user.id,
          email: user.email,
          name: user.displayName,
          memberId: user.householdMember[0]?.id,
          householdId: user.householdMember[0]?.householdId,
        } satisfies AuthorizedUser;

        await recordLoginSuccessEvent(authorizedUser);

        return authorizedUser;
      },
    }),
  ],
  callbacks: {
    ...authConfig.callbacks,
    jwt: async ({ token, user }) => {
      if (!user) {
        const appToken = token as AppToken;

        if (!appToken.appSessionId) {
          const appSessionId = await ensureAppSessionForToken(appToken, null).catch(() => { markAuthStorageUnavailable(); return null; });
          // Auth.js refreshes iat when encoding. Never re-sign a rejected legacy token.
          if (!appSessionId) return null;
          appToken.appSessionId = appSessionId;
        }

        return token;
      }

      const authorizedUser = user as AuthorizedUser;
      if (!authorizedUser.appSessionId) return null;
      const appToken = token as AppToken;

      appToken.sub = authorizedUser.id;
      appToken.email = authorizedUser.email;
      appToken.name = authorizedUser.name;
      appToken.memberId = authorizedUser.memberId;
      appToken.householdId = authorizedUser.householdId;
      appToken.appSessionId = authorizedUser.appSessionId;

      return appToken;
    },
    session: async ({ session, token }) => {
      if (!session.user) {
        return session;
      }

      if (
        !token.sub ||
        typeof token.email !== "string" ||
        typeof token.name !== "string"
      ) {
        return markSessionInvalid(session);
      }

      const appToken = token as AppToken;
      const appSessionId =
        typeof appToken.appSessionId === "string" && appToken.appSessionId
          ? appToken.appSessionId
          : await ensureAppSessionForToken(appToken, null).catch(() => { markAuthStorageUnavailable(); return null; });

      if (!appSessionId) {
        return markSessionInvalid(session);
      }

      const appSessionUser = await loadValidAccountSessionUser(appSessionId).catch(() => { throw markAuthStorageUnavailable(); });

      if (!appSessionUser || appSessionUser.id !== token.sub) {
        return markSessionInvalid(session);
      }

      Object.assign(session.user, {
        id: appSessionUser.id,
        email: appSessionUser.email,
        name: appSessionUser.name,
        memberId: appSessionUser.memberId,
        householdId: appSessionUser.householdId,
        role: appSessionUser.role,
        appSessionId: appSessionUser.appSessionId,
      } satisfies AccountSessionUser);

      return session;
    },
  },
});

function markSessionInvalid(session: Session): AppAuthSession {
  const invalidSession = session as AppAuthSession & { user?: unknown };

  invalidSession.authError = "SESSION_INVALID";
  invalidSession.user = undefined;

  return invalidSession;
}
