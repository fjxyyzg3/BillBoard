export { auth as middleware } from "@/auth";

export const config = {
  matcher: ["/home/:path*", "/add/:path*", "/records/:path*"],
};
