import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  decodeRecordSearchToken,
  decodeRecordAmountToken,
  createRecordAmountToken,
} from "@/lib/records/search-token";

const tokenContext = { householdId: "household-1", memberId: "member-1", scope: { kind: "household" as const } };

const { requireAppSessionMock } = vi.hoisted(() => ({
  requireAppSessionMock: vi.fn(),
}));

vi.mock("@/lib/auth/session", () => ({
  requireAppSession: requireAppSessionMock,
}));
vi.mock("@/lib/encryption/request", async (original) => ({
  ...await original<typeof import("@/lib/encryption/request")>(),
  withHouseholdEncryption: async (_input: unknown, work: (session: unknown) => Promise<unknown>) => work(await requireAppSessionMock()),
}));

vi.mock("next/headers", () => ({ cookies: async () => ({ get: () => undefined }) }));
vi.mock("@/lib/db", () => ({ db: {
  ledger: { findMany: async () => [{ id: "ledger-1", name: "Default", isDefault: true, archivedAt: null, acceptsLegacyDrafts: true }] },
} }));

vi.mock("@/lib/auth/household-context", () => ({
  resolveHouseholdContext: async (_client: unknown, session: { householdId: string; memberId: string }) => ({ ...session, ledgerId: "ledger-1", ledgerName: "Default", role: "OWNER", userId: "member-user-1" }),
}));

describe("record search route", () => {
  it.each(["ledger=foreign", "ledger=all&ledger=ledger-1", "entryLedger=ledger-1&entryLedger=foreign"])("rejects an unavailable or ambiguous scope: %s", async (query) => {
    const { POST } = await import("@/app/(app)/records/search/route");
    const response = await POST(new Request("https://billboard.test/records/search", {
      method: "POST", body: new URLSearchParams({ returnTo: `/records?${query}`, search: "private note" }),
    }));
    expect(response.status).toBe(404);
    expect(response.headers.get("location")).toBeNull();
  });
  beforeEach(() => {
    vi.resetModules();
    vi.stubEnv("AUTH_SECRET", "record-search-test-secret");
    requireAppSessionMock.mockResolvedValue({
      householdId: "household-1",
      id: "member-user-1",
      memberId: "member-1",
    });
  });

  afterEach(() => {
    requireAppSessionMock.mockReset();
    vi.unstubAllEnvs();
  });

  it("redirects with an opaque token and preserves safe records filters", async () => {
    const { POST } = await import("@/app/(app)/records/search/route");
    const body = new URLSearchParams({
      returnTo: "/records?mode=all&page=3&record=record-1&type=expense",
      search: "  private note  ",
    });
    const response = await POST(
      new Request("https://billboard.test/records/search", {
        body,
        method: "POST",
      }),
    );

    expect(response.status).toBe(303);
    const location = new URL(
      response.headers.get("location") ?? "",
      "https://billboard.test",
    );
    const token = location.searchParams.get("search");

    expect(location.pathname).toBe("/records");
    expect(location.searchParams.get("mode")).toBe("all");
    expect(location.searchParams.get("record")).toBe("record-1");
    expect(location.searchParams.get("type")).toBe("expense");
    expect(location.searchParams.has("page")).toBe(false);
    expect(token).toBeTruthy();
    expect(token).not.toContain("private note");
    expect(decodeRecordSearchToken(token ?? undefined, tokenContext)).toBe("private note");
  });

  it("removes the search token when the submitted search is blank", async () => {
    const { POST } = await import("@/app/(app)/records/search/route");
    const response = await POST(
      new Request("https://billboard.test/records/search", {
        body: new URLSearchParams({
          returnTo: "/records?mode=all&search=v1.old-token",
          search: "  ",
        }),
        method: "POST",
      }),
    );
    const location = new URL(
      response.headers.get("location") ?? "",
      "https://billboard.test",
    );

    expect(response.status).toBe(303);
    expect(location.pathname).toBe("/records");
    expect(location.searchParams.get("mode")).toBe("all");
    expect(location.searchParams.has("search")).toBe(false);
  });

  it("adds a private amount filter, retains active filters and drops legacy perspective", async () => {
    const { POST } = await import("@/app/(app)/records/search/route");
    const response = await POST(new Request("https://billboard.test/records/search", {
      method: "POST",
      body: new URLSearchParams({
        returnTo: "/records?mode=month&month=2026-04&perspective=me&type=expense&category=dining&page=3",
        search: "private note",
        amountMode: "exact",
        amountExact: "299.99",
      }),
    }));
    const location = new URL(response.headers.get("location") ?? "", "https://billboard.test");

    expect(response.status).toBe(303);
    expect(location.searchParams.get("amount")).toBeTruthy();
    expect(decodeRecordAmountToken(location.searchParams.get("amount") ?? undefined, tokenContext))
      .toEqual({ mode: "exact", valueFen: 29999 });
    expect(location.searchParams.get("search")).toBeTruthy();
    expect(location.search).not.toContain("299.99");
    expect(location.searchParams.get("mode")).toBe("month");
    expect(location.searchParams.get("month")).toBe("2026-04");
    expect(location.searchParams.has("perspective")).toBe(false);
    expect(location.searchParams.get("type")).toBe("expense");
    expect(location.searchParams.get("category")).toBe("dining");
    expect(location.searchParams.has("page")).toBe(false);
  });

  it("rejects a reversed amount range without replacing existing filters", async () => {
    const { POST } = await import("@/app/(app)/records/search/route");
    const response = await POST(new Request("https://billboard.test/records/search", {
      method: "POST",
      body: new URLSearchParams({
        returnTo: "/records?mode=month&month=2026-04&search=v1.previous&amount=v1.previous-amount&page=3",
        search: "replacement",
        amountMode: "range",
        amountMin: "300",
        amountMax: "200",
      }),
    }));
    const location = new URL(response.headers.get("location") ?? "", "https://billboard.test");

    expect(location.searchParams.get("filterError")).toBe("invalidAmountRange");
    expect(location.searchParams.get("search")).toBe("v1.previous");
    expect(location.searchParams.get("amount")).toBe("v1.previous-amount");
    expect(location.searchParams.get("page")).toBe("3");
  });

  it("can submit amount-only ranges and clear amounts without clearing keywords", async () => {
    const { POST } = await import("@/app/(app)/records/search/route");
    const submit = (body: Record<string, string>) => POST(new Request("https://billboard.test/records/search", {
      method: "POST", body: new URLSearchParams(body),
    }));
    const rangeResponse = await submit({
      returnTo: "/records?mode=month&month=2026-04",
      search: "",
      amountMode: "range", amountMin: "200", amountMax: "300",
    });
    const rangeLocation = new URL(rangeResponse.headers.get("location")!, "https://billboard.test");
    const amount = rangeLocation.searchParams.get("amount")!;
    expect(decodeRecordAmountToken(amount, tokenContext))
      .toEqual({ mode: "range", minFen: 20000, maxFen: 30000 });
    expect(rangeLocation.searchParams.has("search")).toBe(false);

    const clearResponse = await submit({
      returnTo: `/records?mode=month&month=2026-04&amount=${amount}&filterError=invalidAmount`,
      search: "retained keyword", amountMode: "any",
    });
    const clearLocation = new URL(clearResponse.headers.get("location")!, "https://billboard.test");
    expect(clearLocation.searchParams.has("amount")).toBe(false);
    expect(clearLocation.searchParams.has("filterError")).toBe(false);
    expect(decodeRecordSearchToken(clearLocation.searchParams.get("search")!, tokenContext))
      .toBe("retained keyword");
    expect(clearLocation.searchParams.get("month")).toBe("2026-04");
  });

  it.each(["-1", "1.234", "1e3", "21474836.48"])("rejects invalid amount %s at the server boundary", async (amountExact) => {
    const { POST } = await import("@/app/(app)/records/search/route");
    const original = createRecordAmountToken({ mode: "exact", valueFen: 20000 }, tokenContext)!;
    const response = await POST(new Request("https://billboard.test/records/search", {
      method: "POST",
      body: new URLSearchParams({
        returnTo: `/records?amount=${original}&type=expense`,
        amountMode: "exact", amountExact,
      }),
    }));
    const location = new URL(response.headers.get("location")!, "https://billboard.test");
    expect(location.searchParams.get("filterError")).toBe("invalidAmount");
    expect(location.searchParams.get("amount")).toBe(original);
    expect(location.searchParams.get("type")).toBe("expense");
  });

  it("falls back to the records page for an external return target", async () => {
    const { POST } = await import("@/app/(app)/records/search/route");
    const response = await POST(
      new Request("https://billboard.test/records/search", {
        body: new URLSearchParams({
          returnTo: "https://attacker.test/records?mode=all",
          search: "private note",
        }),
        method: "POST",
      }),
    );
    const location = new URL(
      response.headers.get("location") ?? "",
      "https://billboard.test",
    );

    expect(response.status).toBe(303);
    expect(location.origin).toBe("https://billboard.test");
    expect(location.pathname).toBe("/records");
    expect(location.searchParams.get("mode")).toBe("month");
  });

  it("redirects unauthenticated submissions to login", async () => {
    requireAppSessionMock.mockRejectedValueOnce(new Error("Unauthorized"));
    const { POST } = await import("@/app/(app)/records/search/route");
    const response = await POST(
      new Request("https://billboard.test/records/search", {
        body: new URLSearchParams({
          returnTo: "/records?mode=all",
          search: "private note",
        }),
        method: "POST",
      }),
    );

    expect(response.status).toBe(303);
    expect(response.headers.get("location")).toBe("/login");
  });
});
