import { randomBytes } from "node:crypto";
import { getToken } from "next-auth/jwt";
import { NextResponse, type NextRequest } from "next/server";
import { authConfig } from "@/auth.config";
import { createContentSecurityPolicy } from "@/lib/content-security-policy";

async function authenticate(request: NextRequest) {
  const url = request.nextUrl.clone();
  const configuredUrl = process.env.AUTH_URL ?? process.env.NEXTAUTH_URL;
  const protocol = request.headers.get("x-forwarded-proto") ?? url.protocol;
  const host = request.headers.get("x-forwarded-host") ?? request.headers.get("host") ?? url.host;
  const origin = new URL(configuredUrl ?? `${protocol.replace(/:$/, "")}://${host}`);
  url.protocol = origin.protocol;
  url.hostname = origin.hostname;
  url.port = origin.port;

  const secret = process.env.AUTH_SECRET ?? process.env.NEXTAUTH_SECRET ??
    (process.env.NODE_ENV === "production" ? undefined : "development-auth-secret");
  const token = secret ? await getToken({
    // Keep this browser entry cookie-only. Final authorization belongs to AppSession.
    req: { headers: new Headers({ cookie: request.headers.get("cookie") ?? "" }) },
    secret,
    secureCookie: url.protocol === "https:",
  }) : null;
  if (typeof token?.sub === "string" && token.sub) return null;

  const signInUrl = url.clone();
  signInUrl.pathname = authConfig.pages.signIn;
  signInUrl.searchParams.set("callbackUrl", url.href);
  return NextResponse.redirect(signInUrl);
}

export async function proxy(request: NextRequest) {
  const nonce = randomBytes(32).toString("base64");
  const policy = createContentSecurityPolicy(nonce);
  const requestHeaders = new Headers(request.headers);
  // Overwrite client values before Next.js derives the script nonce from the CSP.
  requestHeaders.set("x-nonce", nonce);
  requestHeaders.set("Content-Security-Policy", policy);

  const redirect = /^\/(?:home|add|records|account)(?:\/|$)/.test(request.nextUrl.pathname)
    ? await authenticate(request) : null;
  const response = redirect ?? NextResponse.next({ request: { headers: requestHeaders } });
  response.headers.set("Content-Security-Policy", policy);
  // Nonces are unique to one document response and cannot be served from a shared cache.
  response.headers.set("Cache-Control", "no-store");
  return response;
}

export const config = {
  matcher: ["/((?!api(?:/|$)|_next/static(?:/|$)|_next/image(?:/|$)|favicon.ico$).*)"],
};
