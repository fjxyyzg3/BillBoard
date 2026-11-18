import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test } from "vitest";
import { PageHeroArt } from "@/components/page-hero-art";

describe("PageHeroArt", () => {
  test("renders the family artwork for the home page title", () => {
    const markup = renderToStaticMarkup(<PageHeroArt variant="home" />);

    expect(markup).toContain("home-title.webp");
    expect(markup).toContain("width=\"1792\"");
    expect(markup).toContain("height=\"878\"");
    expect(markup).toContain("loading=\"lazy\"");
    expect(markup).not.toContain("fetchPriority");
    expect(markup).not.toContain("rounded-[1.5rem]");
  });

  test("renders the coffee artwork for the add page title", () => {
    const markup = renderToStaticMarkup(<PageHeroArt variant="add" />);

    expect(markup).toContain("add-title.webp");
    expect(markup).toContain("width=\"1591\"");
    expect(markup).toContain("height=\"989\"");
    expect(markup).toContain("loading=\"lazy\"");
    expect(markup).not.toContain("fetchPriority");
    expect(markup).not.toContain("rounded-[1.5rem]");
  });
});
