import { describe, expect, it } from "vitest";
import { parseIdentityLinkFragment, identityLinkBootstrapScript } from "@/components/identity-link-token";

describe("identity email link handoff", () => {
  it("accepts an access application confirmation without treating it as registration", () => {
    expect(parseIdentityLinkFragment("#kind=application&token=opaque_token-123")).toEqual({ kind: "application", token: "opaque_token-123" });
  });

  it("accepts only one supported purpose and a bounded raw token from the fragment", () => {
    expect(parseIdentityLinkFragment("#kind=invite&token=opaque_token-123")).toEqual({ kind: "invite", token: "opaque_token-123" });
    expect(parseIdentityLinkFragment("#kind=reset&token=opaque_token-123")).toEqual({ kind: "reset", token: "opaque_token-123" });
    for (const fragment of ["", "?kind=reset&token=secret", "#kind=other&token=secret", "#kind=reset&kind=invite&token=secret", "#kind=reset&token=a&token=b", "#kind=reset&token=", "#kind=reset&token=" + "a".repeat(1025)]) {
      expect(parseIdentityLinkFragment(fragment)).toBeNull();
    }
  });

  it("removes the capability URL before hydration and keeps it only in memory", () => {
    const calls: unknown[][] = [];
    const location = { pathname: "/account-link", search: "?token=query-must-be-ignored", hash: "#kind=verify&token=fragment-secret" };
    const browser: { location: typeof location; __bbIdentityLinkFragment?: string } = { location };
    const history = { state: null, replaceState: (...args: unknown[]) => calls.push(args) };
    const runBootstrap = new Function("window", "history", identityLinkBootstrapScript);
    runBootstrap(browser, history);
    expect(browser.__bbIdentityLinkFragment).toBe(location.hash);
    expect(calls).toEqual([[null, "", "/account-link"]]);
    expect(identityLinkBootstrapScript).not.toMatch(/localStorage|sessionStorage|fetch|XMLHttpRequest/);
  });
});
