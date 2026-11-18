import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { RecordsFilterBar } from "@/components/records-filter-bar";
import { getMessages } from "@/lib/i18n";

const harness = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], query: "ledger=ledger-1", push: vi.fn(), replace: vi.fn(), fetch: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useId: () => "filters",
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values)) harness.values[index] = typeof initial === "function" ? initial() : initial;
    return [harness.values[index], (value: unknown) => {
      harness.values[index] = typeof value === "function" ? value(harness.values[index]) : value;
    }];
  },
  useRef: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.values)) harness.values[index] = { current: initial };
    return harness.values[index];
  },
  useEffect: () => {},
  useSyncExternalStore: () => true,
  useTransition: () => [false, (work: () => void) => work()],
}));
vi.mock("next/navigation", () => ({
  usePathname: () => "/records",
  useRouter: () => ({ push: harness.push, replace: harness.replace }),
  useSearchParams: () => new URLSearchParams(harness.query),
}));
vi.mock("@/lib/encryption/client", () => ({
  getEncryptionInput: () => ({ code: "test-code", revision: 3 }),
  appendEncryption: (form: FormData) => {
    form.set("__householdEncryption", JSON.stringify({ code: "test-code", revision: 3 }));
    return form;
  },
}));

type ElementProps = { children?: ReactNode; [key: string]: unknown };
function elements(node: ReactNode): Array<ReactElement<ElementProps>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}
function render(overrides: Partial<Parameters<typeof RecordsFilterBar>[0]> = {}) {
  harness.cursor = 0;
  return RecordsFilterBar({ categories: [], labels: { common: getMessages("en-US").common }, locale: "en-US", searchValue: "dinner", ...overrides });
}
function submitEvent(fields: Record<string, string>) {
  return {
    currentTarget: { action: "http://localhost/records/search", fields },
    defaultPrevented: false,
    preventDefault() { this.defaultPrevented = true; },
  };
}
const NativeFormData = FormData;

describe("record search submission", () => {
  beforeEach(() => {
    harness.cursor = 0;
    harness.values = [];
    harness.query = "ledger=ledger-1";
    harness.push.mockReset();
    harness.replace.mockReset();
    harness.fetch.mockReset();
    vi.stubGlobal("window", { location: { origin: "http://localhost" } });
    vi.stubGlobal("fetch", harness.fetch);
    vi.stubGlobal("FormData", class extends NativeFormData {
      constructor(form: { fields: Record<string, string> }) {
        super();
        for (const [key, value] of Object.entries(form.fields)) this.set(key, value);
      }
    });
  });
  afterEach(() => vi.unstubAllGlobals());

  it("restores decoded amounts and search after the URL updates before server props", () => {
    const previous = { amountFilter: { mode: "range" as const, minFen: 20000, maxFen: 30000 }, searchValue: "previous term" };
    render(previous);
    harness.query = "ledger=ledger-1&amount=exact-token&search=new-token";
    render(previous);
    const tree = render({ amountFilter: { mode: "exact", valueFen: 20000 }, searchValue: "restored term" });
    expect(elements(tree).find((node) => node.props.name === "amountMode")?.props.value).toBe("exact");
    expect(elements(tree).find((node) => node.props.name === "amountExact")?.props.value).toBe("200.00");
    expect(elements(tree).find((node) => node.type === "input" && node.props.name === "search")?.props.value).toBe("restored term");
  });

  it("preserves an unsubmitted amount when the decoded server filter has not changed", () => {
    const input = elements(render({ amountFilter: { mode: "exact", valueFen: 20000 } })).find((node) => node.props.name === "amountExact")!;
    (input.props.onChange as (event: unknown) => void)({ target: { value: "250" } });
    const tree = render({ amountFilter: { mode: "exact", valueFen: 20000 } });
    expect(elements(tree).find((node) => node.props.name === "amountExact")?.props.value).toBe("250");
  });

  it("adds encrypted search to browser history and sends the household key", async () => {
    harness.fetch.mockResolvedValue({ ok: true, url: "http://localhost/records?search=opaque" });
    const form = elements(render()).filter((node) => node.type === "form")[0];
    expect(form.props.onSubmit).toBeTypeOf("function");
    const event = submitEvent({ search: "dinner", returnTo: "/records?ledger=ledger-1" });
    await (form.props.onSubmit as (event: unknown) => Promise<void>)(event);
    expect(event.defaultPrevented).toBe(true);
    const request = harness.fetch.mock.calls[0][1];
    expect(request.body.get("__householdEncryption")).toBe(JSON.stringify({ code: "test-code", revision: 3 }));
    expect(request.body.get("search")).toBe("dinner");
    expect(harness.push).toHaveBeenCalledWith("/records?search=opaque", { scroll: false });
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it("adds applied filters to browser history so Back restores the previous amount", async () => {
    harness.fetch.mockResolvedValue({ ok: true, url: "http://localhost/records?amount=next-range" });
    const form = elements(render()).filter((node) => node.type === "form")[1];
    await (form.props.onSubmit as (event: unknown) => Promise<void>)(submitEvent({ search: "dinner", amountMode: "range", amountMin: "10", amountMax: "20" }));
    expect(harness.push).toHaveBeenCalledWith("/records?amount=next-range", { scroll: false });
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it("keeps a failed advanced-filter request visible inside its dialog", async () => {
    harness.fetch.mockRejectedValue(new Error("offline"));
    const form = elements(render()).filter((node) => node.type === "form")[1];
    await (form.props.onSubmit as (event: unknown) => Promise<void>)(submitEvent({ search: "dinner", amountMode: "any" }));
    const nextForm = elements(render()).filter((node) => node.type === "form")[1];
    const dialog = elements(nextForm.props.children).find((node) => typeof node.type === "function" && node.type.name === "BottomSheet");
    expect(dialog).toBeDefined();
    expect(elements(dialog!.props.children).some((node) => node.props.role === "alert")).toBe(true);
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it("does not start a duplicate request while a filter submission is pending", async () => {
    let finish!: (result: unknown) => void;
    harness.fetch.mockReturnValue(new Promise((resolve) => { finish = resolve; }));
    const form = elements(render()).filter((node) => node.type === "form")[1];
    const submit = form.props.onSubmit as (event: unknown) => Promise<void>;
    const first = submit(submitEvent({ search: "dinner", amountMode: "any" }));
    const second = submit(submitEvent({ search: "dinner", amountMode: "any" }));
    expect(harness.fetch).toHaveBeenCalledTimes(1);
    finish({ ok: true, url: "http://localhost/records?search=opaque" });
    await Promise.all([first, second]);
  });
});
