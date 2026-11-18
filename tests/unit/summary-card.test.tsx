import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { SummaryCard } from "@/components/summary-card";

describe("SummaryCard", () => {
  test("renders the matching decorative artwork for each visual type", () => {
    const visuals = ["income", "expense", "net", "records"] as const;

    for (const visual of visuals) {
      const markup = renderToStaticMarkup(
        <SummaryCard title="Title" value="0.00" visual={visual} />,
      );

      expect(markup).toContain(`summary-${visual}.webp`);
      expect(markup).toContain("aria-hidden=\"true\"");
      expect(markup).toContain("loading=\"lazy\"");
    }
  });
});
