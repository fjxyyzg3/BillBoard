import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it } from "vitest";
import { IosDateTimeInput } from "@/components/ios-datetime-input";

describe("IosDateTimeInput", () => {
  it("renders a native datetime-local input with the shared iOS control wrapper", () => {
    const markup = renderToStaticMarkup(
      <IosDateTimeInput defaultValue="2026-05-22T23:29" name="occurredAt" required />,
    );

    expect(markup).toContain('class="ios-datetime"');
    expect(markup).toContain('type="datetime-local"');
    expect(markup).toContain('class="ios-datetime__native"');
    expect(markup).toContain('class="ios-datetime__icon"');
    expect(markup).toContain('name="occurredAt"');
  });
});
