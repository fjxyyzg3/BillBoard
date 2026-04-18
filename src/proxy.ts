export { auth as proxy } from "@/auth";

export const config = {
  matcher: ["/home/:path*", "/add/:path*", "/records/:path*"],
};
