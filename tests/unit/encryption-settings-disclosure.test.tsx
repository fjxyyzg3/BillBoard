import { Children, isValidElement, type ReactElement, type ReactNode } from "react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import { EncryptionSettings } from "@/components/encryption-settings";
import type { EncryptionStatus } from "@/lib/encryption/types";
import { getEncryptionMessages } from "@/lib/i18n";

const harness = vi.hoisted(() => ({ cursor: 0, states: [] as unknown[], candidate: null as unknown }));
const identity = { accountId: "account", householdId: "household", memberId: "member" };
const status: EncryptionStatus = { mode: "UNENCRYPTED", revision: 0, generation: null, keyVersion: 0, isOwner: true, operation: null };
const labels = getEncryptionMessages("zh-CN");
vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) harness.states[index] = index === 2 ? harness.candidate : initial;
    return [harness.states[index], (value: unknown) => { harness.states[index] = typeof value === "function" ? value(harness.states[index]) : value; }];
  },
  useRef: (initial: unknown) => ({ current: initial }), useEffect: vi.fn(),
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: vi.fn() }) }));
vi.mock("@/components/encryption-provider", () => ({
  EncryptionProvider: ({ children }: { children: ReactNode }) => children,
  useEncryption: () => ({ identity, status, code: null, ready: true }),
}));

type ElementProps = { children?: ReactNode; open?: boolean; value?: string; onToggle?: (event: { currentTarget: { open: boolean } }) => void; onChange?: (event: { target: { value?: string; files?: File[] } }) => void };
function find(value: ReactNode, predicate: (element: ReactElement<ElementProps>) => boolean): ReactElement<ElementProps> | undefined {
  let result: ReactElement<ElementProps> | undefined;
  Children.forEach(value, (child) => {
    if (result || !isValidElement<ElementProps>(child)) return;
    result = predicate(child) ? child : find(child.props.children, predicate);
  });
  return result;
}

function disclosure(label: string) {
  harness.cursor = 0;
  const wrapper = EncryptionSettings({ identity, status, locale: "zh-CN" });
  const body = wrapper.props.children as ReactElement<{ locale: "zh-CN" }>;
  const tree = (body.type as (props: { locale: "zh-CN" }) => ReactNode)(body.props);
  const found = find(tree, (element) => element.type === "details" && Boolean(find(element.props.children, (child) => child.type === "summary" && child.props.children === label)));
  if (!found) throw new Error("Disclosure missing");
  return found;
}

describe("explicit encryption code disclosures", () => {
  beforeEach(() => { harness.cursor = 0; harness.states = []; harness.candidate = null; });

  it.each([
    { label: labels.recoveryFile, codeIndex: 9 },
    { label: labels.restoreOperation, codeIndex: 11 },
  ])("mounts the $label input only while open and clears its code on close", ({ label, codeIndex }) => {
    const closed = disclosure(label);
    expect(find(closed, (element) => element.type === "textarea")).toBeUndefined();
    closed.props.onToggle!({ currentTarget: { open: true } });
    const opened = disclosure(label);
    const field = find(opened, (element) => element.type === "textarea")!;
    field.props.onChange!({ target: { value: "BBK1.synthetic-private-input" } });
    expect(harness.states[codeIndex]).toBe("BBK1.synthetic-private-input");
    const sourceFile = new File(["BBP1.synthetic-ciphertext"], "recovery.json");
    if (codeIndex === 9) find(opened, (element) => element.type === "input")!.props.onChange!({ target: { files: [sourceFile] } });
    opened.props.onToggle!({ currentTarget: { open: false } });
    expect(harness.states[codeIndex]).toBe("");
    if (codeIndex === 9) expect(harness.states[10]).toBe(sourceFile);
    const collapsed = disclosure(label);
    expect(find(collapsed, (element) => element.type === "textarea")).toBeUndefined();
    collapsed.props.onToggle!({ currentTarget: { open: true } });
    expect(find(disclosure(label), (element) => element.type === "textarea")!.props.value).toBe("");
  });

  it("keeps an unfinished candidate and its original UUID when ending a restore-code disclosure", () => {
    const candidate = { id: "1292ae25-17cf-43e4-b80a-b12d01348079", kind: "ENABLE", code: "BBK1.synthetic-candidate", prepared: true };
    harness.candidate = candidate;
    const closed = disclosure(labels.restoreOperation);
    closed.props.onToggle!({ currentTarget: { open: true } });
    const opened = disclosure(labels.restoreOperation);
    find(opened, (element) => element.type === "textarea")!.props.onChange!({ target: { value: "BBK1.synthetic-restore-input" } });
    opened.props.onToggle!({ currentTarget: { open: false } });
    expect(harness.states[11]).toBe("");
    expect(harness.states[2]).toBe(candidate);
    expect((harness.states[2] as typeof candidate).id).toBe(candidate.id);
  });
});
