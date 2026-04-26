import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { createTransactionSchema } from "@/lib/transactions/schema";

const {
  createTransactionMock,
  redirectMock,
  requireAppSessionMock,
} = vi.hoisted(() => ({
  createTransactionMock: vi.fn(),
  redirectMock: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  requireAppSessionMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("@/lib/auth/session", () => ({
  requireAppSession: requireAppSessionMock,
}));

vi.mock("@/lib/transactions/create-transaction", () => ({
  createTransaction: createTransactionMock,
}));

const baseInput = {
  type: "expense",
  amount: "18.60",
  categoryId: "category-1",
  actorMemberId: "member-1",
  note: "",
};

describe("transaction datetime parsing", () => {
  it("stores datetime-local input as Asia/Shanghai wall-clock time", () => {
    const parsed = createTransactionSchema.parse({
      ...baseInput,
      occurredAt: "2026-04-26T08:30",
    });

    expect(parsed.occurredAt.toISOString()).toBe("2026-04-26T00:30:00.000Z");
  });

  it("rejects impossible datetime-local inputs instead of normalizing them", () => {
    const result = createTransactionSchema.safeParse({
      ...baseInput,
      occurredAt: "2026-02-31T10:00",
    });

    expect(result.success).toBe(false);

    if (result.success) {
      throw new Error("Expected invalid datetime-local input to be rejected");
    }

    expect(result.error.issues[0]?.message).toBe("Choose a valid date and time");
  });

  it("uses the Shanghai datetime helper for the form default instead of browser-local time", () => {
    const source = readFileSync(
      path.resolve(process.cwd(), "src/components/transaction-form.tsx"),
      "utf8",
    );

    expect(source).toContain("getCurrentShanghaiDateTimeLocal");
    expect(source).not.toContain("getTimezoneOffset");
  });
});

describe("submitTransaction", () => {
  beforeEach(() => {
    vi.resetModules();
    createTransactionMock.mockReset();
    redirectMock.mockClear();
    requireAppSessionMock.mockReset();
  });

  it("redirects to login when the session has expired before submit", async () => {
    requireAppSessionMock.mockRejectedValue(new Error("Unauthorized"));

    const { initialCreateTransactionState, submitTransaction } = await import(
      "@/app/(app)/add/actions"
    );

    await expect(
      submitTransaction(initialCreateTransactionState, new FormData()),
    ).rejects.toThrow("REDIRECT:/login");

    expect(redirectMock).toHaveBeenCalledWith("/login");
    expect(createTransactionMock).not.toHaveBeenCalled();
  });
});
