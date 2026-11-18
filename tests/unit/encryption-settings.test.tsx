import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptionSettings } from "@/components/encryption-settings";
import { getEncryptionMessages } from "@/lib/i18n";

const harness = vi.hoisted(() => ({ owner: false, code: "BBK1.synthetic-client-only-code" as string | null }));
const identity = { accountId: "account", householdId: "household", memberId: "member" };
const status = { mode: "ENCRYPTED" as const, revision: 1, generation: "generation", keyVersion: 1, isOwner: false, operation: null };
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/encryption-provider", () => ({
  EncryptionProvider: ({ children }: { children: ReactNode }) => children,
  useEncryption: () => ({ identity, status: { ...status, isOwner: harness.owner }, code: harness.code, ready: true }),
}));

describe("encryption settings member access", () => {
  beforeEach(() => { harness.owner = false; harness.code = "BBK1.synthetic-client-only-code"; });

  it.each(["zh-CN", "en-US"] as const)("offers explicit access to the existing code without exposing it initially in %s", (locale) => {
    const labels = getEncryptionMessages(locale);
    const markup = renderToStaticMarkup(<EncryptionSettings identity={identity} locale={locale} status={status} />);
    expect(markup).toContain(labels.showCode);
    expect(markup).toContain(labels.ownerOnly);
    expect(markup).not.toContain(harness.code);
    expect(markup).not.toContain(labels.rotate);
    expect(markup).not.toContain(labels.disable);
    expect(markup).not.toContain(labels.enable);
  });

  it("keeps an unavailable code hidden and leaves account settings usable", () => {
    harness.code = null;
    const labels = getEncryptionMessages("zh-CN");
    const markup = renderToStaticMarkup(<EncryptionSettings identity={identity} locale="zh-CN" status={status} />);
    expect(markup).not.toContain(labels.showCode);
    expect(markup).toContain(labels.forget);
  });
});
