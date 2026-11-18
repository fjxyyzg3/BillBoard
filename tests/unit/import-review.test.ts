import { ImportDraftRowStatus } from "@prisma/client";
import { describe, expect, it } from "vitest";

import { buildImportReviewHref, canDecideImportRow, getImportReviewPage, isLockedImportRefund } from "@/lib/imports/review";
import { CMB_FULLY_REFUNDED, CMB_REFUND_MANUAL_REASONS } from "@/lib/imports/types";

describe("CMB refund review decisions", () => {
  it.each([CMB_FULLY_REFUNDED, ...CMB_REFUND_MANUAL_REASONS])(
    "prevents importing a locked refund outcome: %s", (skipReason) => {
      const row = { status: ImportDraftRowStatus.USER_SKIPPED, skipReason };

      expect(isLockedImportRefund(row)).toBe(true);
      expect(canDecideImportRow(row)).toBe(false);
    },
  );

  it("keeps ordinary CMB movements available for a user decision", () => {
    expect(canDecideImportRow({
      status: ImportDraftRowStatus.USER_SKIPPED,
      skipReason: "Suggested bank transfer-like transaction",
    })).toBe(true);
  });
});

describe("import review navigation", () => {
  const rows = Array.from({ length: 163 }, (_, index) => ({
    id: `row-${index + 1}`,
    status: index % 2 === 0 ? ImportDraftRowStatus.READY : ImportDraftRowStatus.POSSIBLE_DUPLICATE,
  }));

  it.each([undefined, "0", "-1", "1.5", "1e2", "Infinity", "9007199254740993"])(
    "normalizes invalid page %s without losing access to the first page", (value) => {
      const result = getImportReviewPage(rows, "all", value);
      expect(result.page).toBe(1);
      expect(result.rows[0]?.id).toBe("row-1");
    },
  );

  it("returns the last valid page after a filter reduces the available rows", () => {
    const result = getImportReviewPage(rows, ImportDraftRowStatus.POSSIBLE_DUPLICATE, "999");
    expect(result).toMatchObject({ page: 2, pageCount: 2, total: 81 });
    expect(result.rows).toHaveLength(31);
    expect(result.rows.every((row) => row.status === ImportDraftRowStatus.POSSIBLE_DUPLICATE)).toBe(true);
  });

  it("keeps an empty status usable and falls back to all rows for an unknown status", () => {
    expect(getImportReviewPage(rows, ImportDraftRowStatus.INVALID, "5"))
      .toMatchObject({ page: 1, pageCount: 1, total: 0, rows: [] });
    expect(getImportReviewPage(rows, "unknown", "1")).toMatchObject({ status: "all", total: 163 });
  });

  it("encodes only the draft and navigation state in links", () => {
    const url = new URL(buildImportReviewHref("draft&unexpected=value", ImportDraftRowStatus.USER_SKIPPED, 3), "http://localhost");
    expect(Array.from(url.searchParams.keys())).toEqual(["draft", "status", "page"]);
    expect(url.searchParams.get("draft")).toBe("draft&unexpected=value");
    expect(buildImportReviewHref("draft-1", "all", 1)).toBe("/records/import?draft=draft-1");
  });
});
