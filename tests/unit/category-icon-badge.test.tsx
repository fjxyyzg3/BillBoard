import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { CategoryIconBadge } from "@/components/category-icon-badge";

describe("CategoryIconBadge", () => {
  it("uses the shared muted category palette", () => {
    const markup = renderToStaticMarkup(<CategoryIconBadge categoryName="Dining" />);

    expect(markup).toContain("background-color:#FBE7DF");
    expect(markup).toContain("color:#B86A5B");
  });
});
