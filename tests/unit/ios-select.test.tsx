import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IosSelect } from "@/components/ios-select";

describe("IosSelect", () => {
  it("renders a native select with a controlled visible value and chevron", () => {
    const markup = renderToStaticMarkup(
      <IosSelect
        name="range"
        options={[
          { value: "this-month", label: "This Month" },
          { value: "last-30-days", label: "Last 30 Days" },
        ]}
        value="this-month"
        variant="pill"
      />,
    );

    expect(markup).toContain("<select");
    expect(markup).toContain('class="ios-select__native"');
    expect(markup).toContain('class="ios-select__value"');
    expect(markup).toContain(">This Month</span>");
    expect(markup).toContain("ios-select__icon");
    expect(markup).toContain('aria-hidden="true"');
  });
});
