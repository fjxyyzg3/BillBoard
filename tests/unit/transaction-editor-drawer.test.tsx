import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";

import { TransactionEditorDrawer } from "@/components/transaction-editor-drawer";
import { getMessages } from "@/lib/i18n";

vi.mock("next/navigation", () => ({
  useRouter: () => ({ replace: vi.fn() }),
}));

vi.mock("@/app/(app)/records/actions", () => ({
  submitRecordDelete: vi.fn(),
  submitRecordUpdate: vi.fn(),
}));

describe("TransactionEditorDrawer", () => {
  it("renders a mobile date control and direct choices for both family members", () => {
    const messages = getMessages("en-US");
    const markup = renderToStaticMarkup(
      <TransactionEditorDrawer
        categories={[{ id: "dining", name: "Dining", type: "expense" }]}
        closeHref="/records?mode=all"
        context={{ householdId: "household", memberId: "a", ledgerId: "main" }}
        ledgers={[
          { id: "main", name: "Main", isDefault: true, archivedAt: null },
          { id: "travel", name: "Travel", isDefault: false, archivedAt: null },
          { id: "archived", name: "Old holidays", isDefault: false, archivedAt: "2026-10-21T00:00:00Z" },
        ]}
        householdMembers={[
          { id: "a", memberName: "Member A" },
          { id: "b", memberName: "Member B" },
        ]}
        labels={{ common: messages.common, editor: messages.editor }}
        locale="en-US"
        record={{
          id: "record",
          amountFen: 1234,
          actorMemberId: "b",
          categoryId: "dining",
          createdByLabel: "Member A",
          note: null,
          occurredAtLocal: "2026-10-13T10:30",
          type: "expense",
        }}
        returnTo="/records?mode=all"
      />,
    );

    expect(markup).toContain('class="ios-datetime__native"');
    expect(markup).toMatch(/<input(?=[^>]*name="actorMemberId")(?=[^>]*type="radio")(?=[^>]*value="a")[^>]*>/);
    expect(markup).toMatch(/<input(?=[^>]*name="actorMemberId")(?=[^>]*type="radio")(?=[^>]*value="b")[^>]*>/);
    expect(markup).toContain('name="returnTo"');
    expect(markup).toContain("Delete record");
    expect(markup).toContain("Save changes");
    expect(markup).toContain('name="targetLedgerId"');
    expect(markup).toContain('value="travel"');
    expect(markup).not.toContain('value="archived"');
  });
});
