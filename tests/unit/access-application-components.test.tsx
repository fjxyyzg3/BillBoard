import { renderToStaticMarkup } from "react-dom/server";
import { describe, expect, it, vi } from "vitest";
import { AccessApplication } from "@/components/access-application";
import { OpsAccessApplications } from "@/components/ops-access-applications";
import { getMessages } from "@/lib/i18n";

vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn(), replace: vi.fn() }) }));
vi.mock("@/app/account/actions", () => ({ finishReauthenticationAction: vi.fn() }));
vi.mock("@/app/help/actions", () => ({ requestAccessApplicationAction: vi.fn() }));
vi.mock("@/app/ops/actions", () => ({ decideAccessApplicationAction: vi.fn(), retryAccessApplicationMailAction: vi.fn() }));

const requestedAt = new Date("2026-10-23T04:00:00Z");
const pending = { id: "request-1", email: "applicant@example.com", note: null, locale: "zh-CN" as const, status: "PENDING" as const, createdAt: requestedAt, verifiedAt: requestedAt, decidedAt: null, mailStatus: "NONE" as const, canRetry: false };

describe("access request presentation", () => {
  it.each(["zh-CN", "en-US"] as const)("offers an email request with an optional bounded note in %s without requiring login", (locale) => {
    const labels = getMessages(locale).accessApplication;
    const markup = renderToStaticMarkup(<AccessApplication locale={locale} />);
    expect(markup).toContain(labels.title);
    expect(markup).toContain(labels.submit);
    expect(markup).toContain('type="email"');
    expect(markup).toContain('method="post"');
    expect(markup).not.toContain('type="password"');
    expect(markup).toContain(`value="${locale}"`);
    const textarea = markup.match(/<textarea\b[^>]*>/)?.[0];
    expect(textarea).toBeDefined();
    expect(textarea).toContain('name="note"');
    expect(textarea).toContain('maxLength="80"');
    expect(textarea).not.toMatch(/\brequired(?:=|\s|>)/);
  });

  it.each(["zh-CN", "en-US"] as const)("renders notes as plain text and shows missing notes in %s", (locale) => {
    for (const status of ["PENDING", "APPROVED", "REJECTED"] as const) {
      const note = "A family friend\n<script>alert(1)</script>";
      const markup = renderToStaticMarkup(<OpsAccessApplications applications={[{ ...pending, status, note }]} locale={locale} page={1} />);
      expect(markup).toContain("A family friend\n&lt;script&gt;alert(1)&lt;/script&gt;");
      expect(markup).not.toContain("<script>");
    }
    const missing = renderToStaticMarkup(<OpsAccessApplications applications={[pending]} locale={locale} page={1} />);
    expect(missing).toContain(locale === "zh-CN" ? "未填写" : "Not provided");
  });

  it("shows decisions only for pending requests and a retry only for retryable failures", () => {
    const labels = getMessages("en-US").ops.accessApplications;
    const pendingMarkup = renderToStaticMarkup(<OpsAccessApplications applications={[pending]} locale="en-US" page={1} />);
    expect(pendingMarkup).toContain(labels.approve);
    expect(pendingMarkup).toContain(labels.reject);
    expect(pendingMarkup).not.toContain(labels.retry);
    const failed = { ...pending, status: "APPROVED" as const, mailStatus: "FAILED" as const, canRetry: true, decidedAt: requestedAt };
    const failedMarkup = renderToStaticMarkup(<OpsAccessApplications applications={[failed]} locale="en-US" page={1} />);
    expect(failedMarkup).toContain(labels.status.APPROVED);
    expect(failedMarkup).toContain(labels.mailStatus.FAILED);
    expect(failedMarkup).toContain(labels.retry);
    expect(failedMarkup).not.toContain(labels.approve);
    expect(failedMarkup).not.toContain(labels.reject);
    const sendingMarkup = renderToStaticMarkup(<OpsAccessApplications applications={[{ ...failed, mailStatus: "SENDING", canRetry: false }]} locale="en-US" page={1} />);
    expect(sendingMarkup).toContain(labels.mailStatus.SENDING);
    expect(sendingMarkup).not.toContain(labels.retry);
  });

  it("provides bounded page links and keeps the previous page available on an empty page", () => {
    const fullPage = Array.from({ length: 100 }, (_, index) => ({ ...pending, id: `request-${index}` }));
    const markup = renderToStaticMarkup(<OpsAccessApplications applications={fullPage} locale="en-US" page={2} />);
    expect(markup).toContain('href="/ops?applicationsPage=1"');
    expect(markup).toContain('href="/ops?applicationsPage=3"');
    const empty = renderToStaticMarkup(<OpsAccessApplications applications={[]} locale="en-US" page={2} />);
    expect(empty).toContain('href="/ops?applicationsPage=1"');
    expect(empty).not.toContain('href="/ops?applicationsPage=3"');
    const first = renderToStaticMarkup(<OpsAccessApplications applications={[]} locale="en-US" page={1} />);
    expect(first).not.toContain('href="/ops?applicationsPage=0"');
    const last = renderToStaticMarkup(<OpsAccessApplications applications={fullPage} locale="en-US" page={1_000} />);
    expect(last).toContain('href="/ops?applicationsPage=999"');
    expect(last).not.toContain('href="/ops?applicationsPage=1001"');
  });
});
