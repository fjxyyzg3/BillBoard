import { isValidElement, type ReactElement, type ReactNode } from "react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { TransactionForm } from "@/components/transaction-form";
import { getEncryptionMessages, getMessages } from "@/lib/i18n";

const harness = vi.hoisted(() => ({ cursor: 0, states: [] as unknown[], effects: [] as Array<() => void>, read: vi.fn(), clear: vi.fn() }));
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) harness.states[index] = typeof initial === "function" ? initial() : initial;
    return [harness.states[index], (next: unknown) => { harness.states[index] = typeof next === "function" ? next(harness.states[index]) : next; }];
  },
  useEffect: (work: () => void) => harness.effects.push(work),
  useRef: (initial: unknown) => ({ current: initial }), useId: () => "transaction-form",
}));
vi.mock("motion/react", () => ({ useReducedMotion: () => true, motion: { div: "div", circle: "circle", path: "path" }, AnimatePresence: "div" }));
vi.mock("@/app/(app)/add/actions", () => ({ submitTransaction: vi.fn() }));
vi.mock("@/lib/encryption/client", () => ({
  appendEncryption: (value: FormData) => value, clearClientDraft: harness.clear,
  getClientEncryption: () => ({ status: { mode: "UNENCRYPTED" } }), encryptionClientGeneration: () => 0,
  readClientDraft: harness.read, writeClientDraft: vi.fn(),
}));

type ElementProps = { children?: ReactNode; [key: string]: unknown };
function elements(node: ReactNode): Array<ReactElement<ElementProps>> {
  if (Array.isArray(node)) return node.flatMap(elements);
  if (!isValidElement<ElementProps>(node)) return [];
  return [node, ...elements(node.props.children)];
}

function render() {
  harness.cursor = 0;
  harness.effects = [];
  const messages = getMessages("zh-CN");
  return TransactionForm({ categories: [], defaultCategoryIds: { income: "income", expense: "expense" }, householdMembers: [], currentMemberId: "member", locale: "zh-CN", labels: { add: messages.add, common: messages.common } });
}

function restore() {
  render();
  for (const effect of harness.effects) effect();
}

describe("protected draft recovery after disabling household encryption", () => {
  beforeEach(() => {
    harness.cursor = 0; harness.states = []; harness.effects = []; harness.clear.mockReset(); harness.read.mockReset();
    vi.stubGlobal("window", {});
  });
  afterEach(() => vi.unstubAllGlobals());

  it("blocks editing when an existing protected draft cannot be opened, preserving its original UUID", async () => {
    harness.read.mockRejectedValue(new Error("PROTECTED_DRAFT_UNAVAILABLE"));
    restore();
    await vi.waitFor(() => expect(elements(render()).find((node) => node.props.role === "alert")?.props.children).toBe(getEncryptionMessages("zh-CN").pendingStorageUnavailable));
    const tree = elements(render());
    expect(tree.find((node) => node.type === "fieldset")?.props.disabled).toBe(true);
    expect(tree.find((node) => node.type === "button" && node.props.type === "submit")?.props.disabled).toBe(true);
    expect(harness.clear).not.toHaveBeenCalled();
  });

  it("keeps the original unencrypted fallback when ordinary browser storage is unavailable", async () => {
    harness.read.mockRejectedValue(new Error("LOCAL_KEY_STORAGE_UNAVAILABLE"));
    restore();
    await vi.waitFor(() => expect(elements(render()).find((node) => node.type === "fieldset")?.props.disabled).toBe(false));
    const tree = elements(render());
    expect(tree.find((node) => node.type === "button" && node.props.type === "submit")?.props.disabled).toBe(false);
    expect(tree.some((node) => node.props.role === "alert")).toBe(false);
  });
});
