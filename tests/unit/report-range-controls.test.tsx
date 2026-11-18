import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, test, vi } from "vitest";
import { buildReportHref, ReportRangeControls } from "@/components/report-range-controls";
import { getMessages } from "@/lib/i18n";

vi.mock("next/navigation", () => ({
  usePathname: () => "/home",
  useRouter: () => ({
    replace: vi.fn(),
  }),
  useSearchParams: () =>
    new URLSearchParams(
      "perspective=spouse&categoryType=income&mode=month&month=2026-05&year=2026",
    ),
}));

const labels = getMessages("en-US").home.range;

describe("ReportRangeControls", () => {
  test("keeps the date range behind one accessible trigger and a closed sheet", () => {
    const markup = renderToStaticMarkup(
      <ReportRangeControls
        labels={labels}
        rangeOptions={{ months: ["2026-05"], years: ["2026"] }}
        selection={{ mode: "month", month: "2026-05", year: "2026" }}
      />,
    );

    expect(markup).toContain('aria-haspopup="dialog"');
    expect(markup).toContain('aria-expanded="false"');
    expect(markup).toContain("<dialog");
    expect(markup).not.toContain('<dialog open=""');
  });

  test("builds range hrefs by preserving other filters and clearing legacy perspective and drilldown params", () => {
    const href = buildReportHref(
      "/home",
      new URLSearchParams(
        "perspective=spouse&categoryType=income&range=legacy&mode=month&month=2026-05&year=2026&from=2026-05-01T00%3A00%3A00.000Z&to=2026-05-01T23%3A59%3A59.999Z&record=record-1&type=expense",
      ),
      { mode: "month", month: "2026-05", year: "2026" },
      { mode: "year", year: "2025" },
    );

    expect(href).toBe(
      "/home?categoryType=income&mode=year&month=2026-05&year=2025&type=expense",
    );
    const params = new URL(`https://example.test${href}`).searchParams;

    expect(params.get("categoryType")).toBe("income");
    expect(params.has("perspective")).toBe(false);
    expect(params.get("type")).toBe("expense");
    expect(params.has("range")).toBe(false);
    expect(params.has("from")).toBe(false);
    expect(params.has("to")).toBe(false);
    expect(params.has("record")).toBe(false);
  });

  test("clears the records page cursor when range changes", () => {
    const href = buildReportHref(
      "/records",
      new URLSearchParams("mode=month&month=2026-05&year=2026&page=3"),
      { mode: "month", month: "2026-05", year: "2026" },
      { mode: "year" },
    );

    expect(href).toBe("/records?mode=year&month=2026-05&year=2026");
  });

  test("applies custom dates while preserving record filters and clears them when leaving custom mode", () => {
    const selection = { mode: "month" as const, month: "2026-05", year: "2026" };
    const href = buildReportHref(
      "/records",
      new URLSearchParams("type=expense&mode=month&month=2026-05&year=2026&page=2"),
      selection,
      { mode: "custom", start: "2026-03-02", end: "2026-05-08" },
    );
    const params = new URL(`https://example.test${href}`).searchParams;

    expect(params.get("mode")).toBe("custom");
    expect(params.get("start")).toBe("2026-03-02");
    expect(params.get("end")).toBe("2026-05-08");
    expect(params.get("type")).toBe("expense");
    expect(params.has("page")).toBe(false);

    const recentHref = buildReportHref(
      "/records",
      params,
      { ...selection, mode: "custom", start: "2026-03-02", end: "2026-05-08" },
      { mode: "recent" },
    );
    const recentParams = new URL(`https://example.test${recentHref}`).searchParams;

    expect(recentParams.get("mode")).toBe("recent");
    expect(recentParams.has("start")).toBe(false);
    expect(recentParams.has("end")).toBe(false);
  });

  test("shows the selected custom endpoints and an explicit apply action", () => {
    const markup = renderToStaticMarkup(
      <ReportRangeControls
        labels={labels}
        rangeOptions={{ months: ["2026-05"], years: ["2026"] }}
        selection={{ mode: "custom", month: "2026-05", year: "2026", start: "2026-04-03", end: "2026-05-08" }}
      />,
    );

    expect(markup).toContain("2026-04-03 – 2026-05-08");
    expect(markup).toContain('type="date"');
    expect(markup).toContain('value="2026-04-03"');
    expect(markup).toContain('value="2026-05-08"');
    expect(markup).toContain("Apply");
  });

  test("renders separate year and month selects for bounded month options", () => {
    const markup = renderToStaticMarkup(
      <ReportRangeControls
        labels={labels}
        rangeOptions={{
          months: ["2026-05", "2026-04", "2026-03", "2025-12", "2025-11"],
          years: ["2026", "2025"],
        }}
        selection={{ mode: "month", month: "2026-05", year: "2026" }}
      />,
    );

    expect(markup.match(/<select/g)).toHaveLength(2);
    expect(markup.match(/ios-select--pill/g)).toHaveLength(2);
    expect(markup.match(/ios-select__native/g)).toHaveLength(2);
    expect(markup).not.toContain('type="month"');
    expect(markup).not.toContain('value="2026-05"');
    expect(markup).not.toContain('value="12"');
    expect(markup).toContain('value="2025"');
    expect(markup).toContain('value="05"');
    expect(markup).toContain('value="03"');
  });

  test("renders bounded year options as a select instead of a number input", () => {
    const markup = renderToStaticMarkup(
      <ReportRangeControls
        labels={labels}
        rangeOptions={{
          months: ["2026-05", "2026-04", "2026-03"],
          years: ["2026", "2025", "2024"],
        }}
        selection={{ mode: "year", month: "2026-05", year: "2026" }}
      />,
    );

    expect(markup).toContain("<select");
    expect(markup).toContain("ios-select--pill");
    expect(markup).toContain("ios-select__native");
    expect(markup).not.toContain('type="number"');
    expect(markup).toContain('value="2024"');
  });
});
