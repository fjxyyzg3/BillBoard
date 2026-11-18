import { describe, expect, it } from "vitest";
import {
  getTransactionDraftStorageKey,
  parseTransactionDraft,
  serializeTransactionDraft,
  type TransactionDraftV1,
} from "@/lib/transactions/draft";

const clientRequestId = "2fa6e82e-10a5-4c2d-9dff-56679048b772";
const draft: TransactionDraftV1 = {
  version: 1,
  memberId: "member-1",
  payload: {
    type: "expense",
    amount: "18.60",
    categoryId: "expense-1",
    actorMemberId: "member-2",
    occurredAt: "2026-07-17T08:30",
    note: "Breakfast",
  },
  clientRequestId,
  status: "awaiting-confirmation",
  savedAt: "2026-07-17T00:30:00.000Z",
};

const options = {
  currentMemberId: "member-1",
  categories: [
    { id: "expense-1", type: "expense" as const },
    { id: "expense-default", type: "expense" as const },
    { id: "income-default", type: "income" as const },
  ],
  defaultCategoryIds: {
    expense: "expense-default",
    income: "income-default",
  },
  fallbackOccurredAt: "2026-07-17T09:00",
  householdMemberIds: ["member-1", "member-2"],
};

describe("transaction draft", () => {
  it("uses a versioned storage key scoped to the current member", () => {
    expect(getTransactionDraftStorageKey("member-1")).toBe(
      "billboard:transaction-draft:v1:member-1",
    );
    expect(getTransactionDraftStorageKey("member-2")).not.toBe(
      getTransactionDraftStorageKey("member-1"),
    );
  });

  it("round-trips a valid awaiting-confirmation draft", () => {
    expect(parseTransactionDraft(serializeTransactionDraft(draft), options)).toEqual(draft);
  });

  it("ignores damaged, unknown-version, and cross-member drafts", () => {
    expect(parseTransactionDraft("not-json", options)).toBeNull();
    expect(
      parseTransactionDraft(JSON.stringify({ ...draft, version: 2 }), options),
    ).toBeNull();
    expect(
      parseTransactionDraft(JSON.stringify({ ...draft, memberId: "member-2" }), options),
    ).toBeNull();
  });

  it("falls back invalid references in an editable draft", () => {
    const restored = parseTransactionDraft(
      JSON.stringify({
        ...draft,
        status: "draft",
        payload: {
          ...draft.payload,
          categoryId: "disabled-category",
          actorMemberId: "former-member",
        },
      }),
      options,
    );

    expect(restored).toMatchObject({
      clientRequestId: null,
      status: "draft",
      payload: {
        categoryId: "expense-default",
        actorMemberId: "member-1",
      },
    });
  });

  it("falls back an invalid Shanghai datetime in an editable draft", () => {
    const restored = parseTransactionDraft(
      JSON.stringify({
        ...draft,
        status: "draft",
        payload: { ...draft.payload, occurredAt: "2026-02-31T10:00" },
      }),
      options,
    );

    expect(restored?.payload.occurredAt).toBe(options.fallbackOccurredAt);
    expect(restored?.clientRequestId).toBeNull();
    expect(restored?.status).toBe("draft");
  });

  it("preserves a pending UUID and its exact payload after actor or category changes", () => {
    const pending = { ...draft, payload: { ...draft.payload, categoryId: "disabled-category", actorMemberId: "former-member" } };
    expect(parseTransactionDraft(JSON.stringify(pending), options)).toEqual(pending);
  });

  it("migrates a legacy pending draft only into its original member's default ledger", () => {
    const context = { householdId: "household-1", memberId: "member-1", ledgerId: "ledger-1" };
    const migrated = parseTransactionDraft(JSON.stringify(draft), { ...options, context, legacyDefaultLedgerId: "ledger-1" });
    expect(migrated).toMatchObject({ version: 2, context, clientRequestId, status: "awaiting-confirmation", payload: draft.payload });
    expect(parseTransactionDraft(JSON.stringify(migrated), { ...options, context: { ...context, ledgerId: "ledger-2" } })).toBeNull();
    expect(parseTransactionDraft(JSON.stringify(draft), { ...options, context: { ...context, ledgerId: "travel-ledger" }, legacyDefaultLedgerId: "ledger-1" })).toBeNull();
    expect(parseTransactionDraft(JSON.stringify(draft), { ...options, context })).toBeNull();
  });
});
