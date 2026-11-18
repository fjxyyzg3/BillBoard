export type IdentityLinkToken = { kind: "invite" | "registration" | "verify" | "reset" | "application"; token: string };

// This runs before hydration. A capability never stays in a URL or browser storage.
export const identityLinkBootstrapScript = `window.__bbIdentityLinkFragment=window.location.hash;history.replaceState(history.state,"",window.location.pathname);`;

export function parseIdentityLinkFragment(fragment: string): IdentityLinkToken | null {
  if (!fragment.startsWith("#")) return null;
  const params = new URLSearchParams(fragment.slice(1));
  const kind = params.get("kind");
  const token = params.get("token");
  if (params.getAll("kind").length !== 1 || params.getAll("token").length !== 1 ||
    !["invite", "registration", "verify", "reset", "application"].includes(kind ?? "") ||
    !token || token.length > 1024 || !/^[A-Za-z0-9_-]+$/.test(token)) return null;
  return { kind: kind as IdentityLinkToken["kind"], token };
}
