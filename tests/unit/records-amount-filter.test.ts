import { describe, expect, it } from "vitest";
import { isRecordAmountFilter, parseRecordAmountFilter } from "@/lib/records/amount-filter";

describe("record amount filters", () => {
  it("converts decimal amounts exactly to integer fen", () => {
    expect(parseRecordAmountFilter({ mode: "exact", exact: " 299.99 " }))
      .toEqual({ mode: "exact", valueFen: 29999 });
    expect(parseRecordAmountFilter({ mode: "range", min: "0", max: "0.29" }))
      .toEqual({ mode: "range", minFen: 0, maxFen: 29 });
    expect(parseRecordAmountFilter({ mode: "exact", exact: "21474836.47" }))
      .toEqual({ mode: "exact", valueFen: 2147483647 });
  });

  it("supports inclusive equal bounds and one-sided ranges", () => {
    expect(parseRecordAmountFilter({ mode: "range", min: "200", max: "200" }))
      .toEqual({ mode: "range", minFen: 20000, maxFen: 20000 });
    expect(parseRecordAmountFilter({ mode: "range", min: "200" }))
      .toEqual({ mode: "range", minFen: 20000 });
    expect(parseRecordAmountFilter({ mode: "range", max: "300" }))
      .toEqual({ mode: "range", maxFen: 30000 });
  });

  it("treats empty amount inputs as no filter", () => {
    expect(parseRecordAmountFilter({ mode: "any", exact: "299" })).toBeUndefined();
    expect(parseRecordAmountFilter({ mode: "exact", exact: " " })).toBeUndefined();
    expect(parseRecordAmountFilter({ mode: "range", min: "", max: " " })).toBeUndefined();
  });

  it.each(["-1", "NaN", "Infinity", "1e3", "2.999", "200-30", "21474836.48", "9".repeat(31)])(
    "rejects an invalid amount instead of silently dropping the filter: %s", (exact) => {
      expect(() => parseRecordAmountFilter({ mode: "exact", exact })).toThrow("invalidAmount");
    },
  );

  it("rejects reversed ranges and unknown modes", () => {
    expect(() => parseRecordAmountFilter({ mode: "range", min: "300", max: "200" }))
      .toThrow("invalidAmountRange");
    expect(() => parseRecordAmountFilter({ mode: "unsupported", exact: "1" }))
      .toThrow("invalidAmount");
  });

  it("validates decrypted integer bounds", () => {
    expect(isRecordAmountFilter({ mode: "range", minFen: 0, maxFen: 29999 })).toBe(true);
    for (const filter of [null, {}, { mode: "range" }, { mode: "exact", valueFen: 0.1 },
      { mode: "range", minFen: 30000, maxFen: 20000 }, { mode: "exact", valueFen: -1 },
      { mode: "exact", valueFen: 2147483648 }, { mode: "exact", valueFen: "29999" }]) {
      expect(isRecordAmountFilter(filter)).toBe(false);
    }
  });
});
