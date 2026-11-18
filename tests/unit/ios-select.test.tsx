import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IosSelect } from "@/components/ios-select";

describe("IosSelect", () => {
  it("renders a native select with a controlled visible value and chevron", () => {
    const markup = renderToStaticMarkup(
      <IosSelect
        name="mode"
        options={[
          { value: "month", label: "Month" },
          { value: "year", label: "Year" },
        ]}
        value="month"
        variant="pill"
      />,
    );

    expect(markup).toContain("<select");
    expect(markup).toContain('class="ios-select__native"');
    expect(markup).toContain('<option value="month" selected="">Month</option>');
    expect(markup).not.toContain('aria-hidden="true" class="ios-select__value"');
    expect(markup).toContain("ios-select__icon");
    expect(markup).toContain('aria-hidden="true"');
  });
});
