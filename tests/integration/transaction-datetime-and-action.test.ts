import { readFileSync } from "node:fs";
import path from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { ZodError } from "zod";
import { createTransactionSchema } from "@/lib/transactions/schema";

const {
  createTransactionMock,
  recordAppEventMock,
  revalidatePathMock,
  redirectMock,
  requireAppSessionMock,
} = vi.hoisted(() => ({
  createTransactionMock: vi.fn(),
  recordAppEventMock: vi.fn(),
  revalidatePathMock: vi.fn(),
  redirectMock: vi.fn((path: string) => {
    throw new Error(`REDIRECT:${path}`);
  }),
  requireAppSessionMock: vi.fn(),
}));

vi.mock("next/navigation", () => ({
  redirect: redirectMock,
}));

vi.mock("next/cache", () => ({
  revalidatePath: revalidatePathMock,
}));

vi.mock("@/lib/auth/session", () => ({
  requireAppSession: requireAppSessionMock,
}));

vi.mock("@/lib/transactions/create-transaction", () => ({
  createTransaction: createTransactionMock,
}));

vi.mock("@/lib/ops/record-event", () => ({
  recordAppEvent: recordAppEventMock,
}));

const baseInput = {
  context: { householdId: "household-1", memberId: "member-1", ledgerId: "ledger-1" },
  type: "expense",
  amount: "18.60",
  categoryId: "category-1",
  actorMemberId: "member-1",
  clientRequestId: "2fa6e82e-10a5-4c2d-9dff-56679048b772",
  note: "",
};

const initialCreateTransactionState = { status: "idle" as const };

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
    recordAppEventMock.mockReset();
    recordAppEventMock.mockResolvedValue(undefined);
    revalidatePathMock.mockReset();
    redirectMock.mockClear();
    requireAppSessionMock.mockReset();
  });

  it("redirects to login when the session has expired before submit", async () => {
    requireAppSessionMock.mockRejectedValue(new Error("Unauthorized"));

    const { submitTransaction } = await import("@/app/(app)/add/actions");

    await expect(
      submitTransaction(initialCreateTransactionState, new FormData()),
    ).rejects.toThrow("REDIRECT:/login");

    expect(redirectMock).toHaveBeenCalledWith("/login");
    expect(createTransactionMock).not.toHaveBeenCalled();
  });

  it("localizes validation messages from the submitted locale", async () => {
    requireAppSessionMock.mockResolvedValue({
      householdId: "household-1",
      id: "user-1",
      memberId: "member-1",
    });
    createTransactionMock.mockRejectedValue(
      new ZodError([
        { code: "custom", message: "Enter a valid amount with up to two decimals", path: ["amount"] },
      ]),
    );

    const { submitTransaction } = await import("@/app/(app)/add/actions");
    const formData = new FormData();
    formData.set("locale", "zh-CN");

    await expect(submitTransaction(initialCreateTransactionState, formData)).resolves.toEqual({
      status: "error",
      message: "请输入有效金额",
    });
  });

  it("uses the localized save fallback for unknown thrown values", async () => {
    requireAppSessionMock.mockResolvedValue({
      householdId: "household-1",
      id: "user-1",
      memberId: "member-1",
    });
    createTransactionMock.mockRejectedValue("database unavailable");

    const { submitTransaction } = await import("@/app/(app)/add/actions");
    const formData = new FormData();
    formData.set("locale", "zh-CN");

    await expect(submitTransaction(initialCreateTransactionState, formData)).resolves.toEqual({
      status: "error",
      message: "无法保存记录",
    });
  });

  it("returns a structured success without redirecting and revalidates report pages", async () => {
    requireAppSessionMock.mockResolvedValue({
      householdId: "household-1",
      id: "user-1",
      memberId: "member-1",
    });
    createTransactionMock.mockResolvedValue({
      amountFen: 1860,
      clientRequestId: baseInput.clientRequestId,
      id: "transaction-1",
      type: "EXPENSE",
      wasCreated: true,
    });

    const { submitTransaction } = await import("@/app/(app)/add/actions");
    const formData = new FormData();

    for (const [key, value] of Object.entries({
      ...baseInput,
      occurredAt: "2026-04-26T08:30",
    })) {
      formData.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }

    await expect(
      submitTransaction(initialCreateTransactionState, formData),
    ).resolves.toEqual({
      status: "success",
      transactionId: "transaction-1",
      clientRequestId: baseInput.clientRequestId,
      amountFen: 1860,
      type: "expense",
    });

    expect(redirectMock).not.toHaveBeenCalled();
    expect(revalidatePathMock.mock.calls).toEqual([["/home"], ["/records"]]);
    expect(revalidatePathMock).not.toHaveBeenCalledWith("/add");
    expect(createTransactionMock).toHaveBeenCalledWith(
      expect.objectContaining({ clientRequestId: baseInput.clientRequestId }),
      expect.objectContaining({ householdId: "household-1", memberId: "member-1" }),
    );
  });

  it("keeps the committed result successful when cache revalidation fails", async () => {
    requireAppSessionMock.mockResolvedValue({
      householdId: "household-1",
      id: "user-1",
      memberId: "member-1",
    });
    createTransactionMock.mockResolvedValue({
      amountFen: 1860,
      clientRequestId: baseInput.clientRequestId,
      id: "transaction-1",
      type: "EXPENSE",
      wasCreated: true,
    });
    revalidatePathMock.mockImplementationOnce(() => {
      throw new Error("cache unavailable");
    });

    const { submitTransaction } = await import("@/app/(app)/add/actions");
    const formData = new FormData();

    for (const [key, value] of Object.entries({
      ...baseInput,
      occurredAt: "2026-04-26T08:30",
    })) {
      formData.set(key, typeof value === "string" ? value : JSON.stringify(value));
    }

    await expect(
      submitTransaction(initialCreateTransactionState, formData),
    ).resolves.toMatchObject({
      status: "success",
      transactionId: "transaction-1",
      clientRequestId: baseInput.clientRequestId,
    });
    expect(revalidatePathMock.mock.calls).toEqual([["/home"], ["/records"]]);
  });
});

vi.mock("@/lib/encryption/request", () => ({
  withHouseholdEncryption: async (_input: unknown, work: () => Promise<unknown>) => work(),
  extractEncryption: (form: FormData) => { form.delete("__householdEncryption"); return undefined; },
}));
