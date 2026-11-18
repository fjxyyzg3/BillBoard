export function createContentSecurityPolicy(nonce?: string): string {
  const development = process.env.NODE_ENV === "development";

  return [
    "default-src 'self'",
    `script-src 'self'${nonce ? ` 'nonce-${nonce}' 'strict-dynamic'` : ""}${development ? " 'unsafe-eval'" : ""}`,
    "script-src-attr 'none'",
    // Charts and motion components update inline styles at runtime.
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' blob: data:",
    "font-src 'self'",
    `connect-src 'self'${development ? " ws: wss:" : ""}`,
    "media-src 'self' blob:",
    "object-src 'none'",
    "frame-src 'none'",
    "frame-ancestors 'none'",
    "base-uri 'self'",
    "form-action 'self'",
  ].join("; ");
}
