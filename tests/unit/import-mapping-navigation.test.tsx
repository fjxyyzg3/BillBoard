import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { ImportCategoryMappingManager } from "@/components/import-category-mapping-manager";
import { confirmImportMappingNavigation, ImportReviewHistoryGuard, registerImportReviewHistoryGuard } from "@/components/import-review-history-guard";
import { useImportMappingNavigationGuard } from "@/components/use-import-mapping-navigation-guard";

type Effect = { dependencies?: unknown[]; cleanup?: () => void };
const harness = vi.hoisted(() => ({ cursor: 0, values: [] as unknown[], effects: [] as Array<() => void>, confirm: vi.fn() }));
vi.mock("react", async (original) => {
  const useEffect = (work: () => void | (() => void), dependencies?: unknown[]) => {
    const index = harness.cursor++;
    const previous = harness.values[index] as Effect | undefined;
    if (!previous || !dependencies || dependencies.some((value, key) => !Object.is(value, previous.dependencies?.[key]))) {
      const effect: Effect = { dependencies };
      harness.values[index] = effect;
      harness.effects.push(() => { previous?.cleanup?.(); effect.cleanup = work() || undefined; });
    }
  };
  return {
    ...await original<typeof import("react")>(),
    useState: (initial: unknown) => {
      const index = harness.cursor++;
      if (!(index in harness.values)) harness.values[index] = initial;
      return [harness.values[index], (value: unknown) => { harness.values[index] = typeof value === "function" ? value(harness.values[index]) : value; }];
    },
    useRef: (initial: unknown) => {
      const index = harness.cursor++;
      if (!(index in harness.values)) harness.values[index] = { current: initial };
      return harness.values[index];
    },
    useEffect, useLayoutEffect: useEffect,
    useTransition: () => [false, (work: () => void) => work()],
  };
});
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/app/(app)/records/import/mappings/actions", () => ({ saveManagedImportMappings: vi.fn() }));

type ElementProps = { children?: ReactNode; [key: string]: unknown };
function elements(node: ReactNode): Array<ReactElement<ElementProps>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}
const mapping = { id: "mapping", source: "wechat_pay" as const, transactionType: "EXPENSE" as const, primaryCategory: "Dining", secondaryCategory: "", categoryId: "dining", categoryName: "Dining", categoryIsActive: true, updatedAt: "2026-01-01T00:00:00.000Z" };
const props = { locale: "en-US" as const, mappings: [mapping], categories: [{ id: "dining", name: "Dining", type: "EXPENSE" as const }, { id: "shopping", name: "Shopping", type: "EXPENSE" as const }] };
function flushEffects() { for (const work of harness.effects.splice(0)) work(); }
function render() {
  harness.cursor = 0;
  const tree = ImportCategoryMappingManager(props);
  flushEffects();
  return tree;
}
function changeMapping() {
  const select = elements(render()).find((node) => node.props.name === "managed-mapping:mapping")!;
  (select.props.onChange as (event: unknown) => void)({ target: { value: "shopping" } });
  render();
}
class FakeElement {
  constructor(readonly href = "http://localhost/records/import") {}
  target = "";
  closest(selector: string) { return selector === "a" ? this : null; }
  hasAttribute() { return false; }
}
let browser: EventTarget & { location: URL; navigation: { currentEntry: { index: number } }; history: { state: object; go: (distance: number) => void }; confirm: typeof harness.confirm };
let cleanupRoot: (() => void) | undefined;

describe("unsaved import mapping navigation", () => {
  beforeEach(() => {
    harness.cursor = 0; harness.values = []; harness.effects = []; harness.confirm.mockReset().mockReturnValue(false);
    const urls = ["http://localhost/records/import", "http://localhost/records/import/mappings"];
    browser = Object.assign(new EventTarget(), {
      location: new URL(urls[1]), navigation: { currentEntry: { index: 1 } },
      history: {
        state: {},
        go(distance: number) {
          queueMicrotask(() => {
            const index = browser.navigation.currentEntry.index + distance;
            browser.navigation.currentEntry.index = index;
            browser.location = new URL(urls[index]);
            browser.dispatchEvent(new Event("popstate"));
          });
        },
      },
      confirm: harness.confirm,
    });
    vi.stubGlobal("window", browser);
    vi.stubGlobal("document", new EventTarget());
    vi.stubGlobal("Element", FakeElement);
    vi.stubGlobal("HTMLFormElement", class {});
    ImportReviewHistoryGuard();
    flushEffects();
    cleanupRoot = (harness.values[0] as Effect).cleanup;
    harness.values = []; harness.cursor = 0;
  });
  afterEach(() => {
    for (const value of harness.values) (value as Effect | undefined)?.cleanup?.();
    cleanupRoot?.();
    vi.unstubAllGlobals();
  });

  it("allows clean mappings to continue while their saved view is refreshing", () => {
    const discard = vi.fn();
    useImportMappingNavigationGuard({ dirty: false, pending: true, formRef: { current: null }, locale: "en-US", onDiscard: discard });
    flushEffects();
    expect(confirmImportMappingNavigation()).toBe(true);
    expect(harness.confirm).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("still protects dirty mappings while their save is pending", () => {
    const discard = vi.fn();
    useImportMappingNavigationGuard({ dirty: true, pending: true, formRef: { current: null }, locale: "en-US", onDiscard: discard });
    flushEffects();
    expect(confirmImportMappingNavigation()).toBe(false);
    expect(harness.confirm).not.toHaveBeenCalled();
    expect(discard).not.toHaveBeenCalled();
  });

  it("warns before a refresh would discard changed mappings", () => {
    changeMapping();
    const event = new Event("beforeunload", { cancelable: true });
    browser.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
  });

  it("cancels link navigation while retaining the selected category", () => {
    changeMapping();
    const event = new Event("click", { cancelable: true });
    Object.assign(event, { button: 0 });
    Object.defineProperty(event, "target", { value: new FakeElement() });
    browser.dispatchEvent(event);
    expect(event.defaultPrevented).toBe(true);
    const select = elements(render()).find((node) => node.props.name === "managed-mapping:mapping")!;
    expect(select.props.value).toBe("shopping");
  });

  it("restores the original URL after cancelling Back without invoking the review guard", async () => {
    changeMapping();
    const review = vi.fn();
    const unregister = registerImportReviewHistoryGuard(review);
    browser.history.go(-1);
    await vi.waitFor(() => expect(harness.confirm).toHaveBeenCalledTimes(1));
    expect(browser.location.pathname).toBe("/records/import/mappings");
    expect(browser.navigation.currentEntry.index).toBe(1);
    expect(review).not.toHaveBeenCalled();
    unregister();
  });

  it("allows Back once after confirmation and leaves the existing review guard in charge", async () => {
    changeMapping();
    harness.confirm.mockReturnValue(true);
    const review = vi.fn();
    const unregister = registerImportReviewHistoryGuard(review);
    browser.history.go(-1);
    await vi.waitFor(() => expect(harness.confirm).toHaveBeenCalledTimes(1));
    expect(browser.location.pathname).toBe("/records/import");
    expect(review).toHaveBeenCalledTimes(1);
    const unload = new Event("beforeunload", { cancelable: true });
    browser.dispatchEvent(unload);
    expect(unload.defaultPrevented).toBe(false);
    unregister();
  });
});
