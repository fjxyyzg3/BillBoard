import { afterEach, describe, expect, it, vi } from "vitest";
import { lockPageScroll } from "@/lib/ui/page-scroll-lock";

afterEach(() => vi.unstubAllGlobals());

describe("shared overlay page scroll lock", () => {
  it.each(["first", "second"] as const)("preserves the page until the last overlay closes (%s closes first)", (order) => {
    const original = { left: "2px", overflow: "auto", paddingRight: "8px", position: "relative", right: "3px", top: "4px", width: "90%" };
    const body = { style: { ...original } };
    const root = { clientWidth: 980, style: { overflow: "scroll" } };
    const scrollTo = vi.fn();
    vi.stubGlobal("document", { body, documentElement: root });
    vi.stubGlobal("window", { scrollX: 0, scrollY: 160, innerWidth: 1000, scrollTo });
    vi.stubGlobal("getComputedStyle", () => ({ paddingRight: body.style.paddingRight }));

    const releaseFirst = lockPageScroll();
    const releaseSecond = lockPageScroll();
    const [releaseEarlier, releaseLater] = order === "first" ? [releaseFirst, releaseSecond] : [releaseSecond, releaseFirst];
    try {
      expect(body.style.position).toBe("fixed");
      expect(body.style.top).toBe("-160px");
      expect(body.style.paddingRight).toBe("28px");
      expect(root.style.overflow).toBe("hidden");

      releaseEarlier();
      releaseEarlier();
      expect(body.style.position).toBe("fixed");
      expect(root.style.overflow).toBe("hidden");
      expect(scrollTo).not.toHaveBeenCalled();

      releaseLater();
      releaseLater();
      expect(body.style).toEqual(original);
      expect(root.style.overflow).toBe("scroll");
      expect(scrollTo).toHaveBeenCalledExactlyOnceWith({ left: 0, top: 160, behavior: "instant" });
    } finally {
      releaseFirst();
      releaseSecond();
    }
  });
});
