import { beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptionRequestError } from "@/lib/encryption/types";

const { guard, create } = vi.hoisted(() => ({ guard: vi.fn(), create: vi.fn() }));
vi.mock("@/lib/encryption/request", () => ({ withHouseholdEncryption: guard, extractEncryption: (form: FormData) => { form.delete("__householdEncryption"); return undefined; } }));
vi.mock("next/navigation", () => ({ redirect: (path: string) => { throw new Error(`REDIRECT:${path}`); } }));
vi.mock("next/cache", () => ({ revalidatePath: vi.fn() }));
vi.mock("@/lib/auth/session", () => ({ requireAppSession: vi.fn() }));
vi.mock("@/lib/transactions/create-transaction", () => ({ createTransaction: create }));
vi.mock("@/lib/transactions/natural-language-service", () => ({ queryNaturalLanguageEntryForSession: vi.fn(), submitNaturalLanguageEntryForSession: vi.fn() }));
vi.mock("@/lib/ops/record-event", () => ({ recordAppEvent: vi.fn() }));

describe("encrypted action entry failures", () => {
  beforeEach(() => { vi.clearAllMocks(); });
  it("preserves the login redirect when the request guard rejects authentication", async () => {
    guard.mockRejectedValue(new Error("Unauthorized"));
    const { submitTransaction } = await import("@/app/(app)/add/actions");
    await expect(submitTransaction({ status: "idle" }, new FormData())).rejects.toThrow("REDIRECT:/login");
    expect(create).not.toHaveBeenCalled();
  });
  it("returns a localized failure without exposing internal encryption error details", async () => {
    guard.mockRejectedValue(new EncryptionRequestError("ENCRYPTION_INVALID"));
    const { submitTransaction } = await import("@/app/(app)/add/actions");
    const form = new FormData(); form.set("locale", "zh-CN");
    const result = await submitTransaction({ status: "idle" }, form);
    expect(result).toMatchObject({ status: "error" });
    expect(JSON.stringify(result)).not.toContain("ENCRYPTION_INVALID");
    expect(create).not.toHaveBeenCalled();
  });
  it("retains the original UUID when a query cannot establish a request context", async () => {
    guard.mockRejectedValue(new EncryptionRequestError("ENCRYPTION_CHANGED"));
    const { queryNaturalLanguageEntry } = await import("@/app/(app)/add/natural-language-actions");
    expect(await queryNaturalLanguageEntry("original-request-uuid", 1)).toEqual({ status: "unknown", requestId: "original-request-uuid" });
  });
});
