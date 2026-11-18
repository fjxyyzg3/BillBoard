import { Children, isValidElement, type FormHTMLAttributes, type ReactElement, type ReactNode, type RefObject } from "react";
import { renderToStaticMarkup } from "react-dom/server";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BottomSheet } from "@/components/bottom-sheet";
import { EncryptionSettings } from "@/components/encryption-settings";
import { IdentityField, IdentityForm } from "@/components/identity-form";
import { getEncryptionMessages, getMessages } from "@/lib/i18n";

const harness = vi.hoisted(() => ({ cursor: 0, states: [] as unknown[], effects: [] as Array<() => void>, forget: vi.fn(), refresh: vi.fn(), replace: vi.fn(), finishReauthentication: vi.fn() }));
const identity = { accountId: "account", householdId: "household", memberId: "member" };
const status = { mode: "ENCRYPTED" as const, revision: 1, generation: "generation", keyVersion: 1, isOwner: false, operation: null };

vi.mock("react", async (original) => ({
  ...await original<typeof import("react")>(),
  useState: (initial: unknown) => {
    const index = harness.cursor++;
    if (!(index in harness.states)) harness.states[index] = initial;
    return [harness.states[index], (next: unknown) => { harness.states[index] = typeof next === "function" ? next(harness.states[index]) : next; }];
  },
  useRef: (initial: unknown) => ({ current: initial }),
  useId: () => "identity-feedback-test",
  useEffect: (effect: () => void) => { harness.effects.push(effect); },
}));
vi.mock("next/navigation", () => ({ useRouter: () => ({ refresh: harness.refresh, replace: harness.replace }) }));
vi.mock("@/app/account/actions", () => ({ finishReauthenticationAction: harness.finishReauthentication }));
vi.mock("@/components/encryption-provider", () => ({
  EncryptionProvider: ({ children }: { children: ReactNode }) => children,
  useEncryption: () => ({ identity, status, code: "BBK1.synthetic-code", ready: true }),
}));
vi.mock("@/components/encryption-lifecycle", () => ({ forgetEncryptionIdentity: harness.forget }));

type TreeProps = { children?: ReactNode; onClick?: () => void | Promise<void>; ref?: RefObject<HTMLElement | null> };
function find(value: ReactNode, predicate: (element: ReactElement<TreeProps>) => boolean): ReactElement<TreeProps> | undefined {
  let result: ReactElement<TreeProps> | undefined;
  Children.forEach(value, (child) => {
    if (result || !isValidElement<TreeProps>(child)) return;
    result = predicate(child) ? child : find(child.props.children, predicate);
  });
  return result;
}

function encryptionTree() {
  harness.cursor = 0;
  const body = EncryptionSettings({ identity, status, locale: "zh-CN" }).props.children as ReactElement<{ locale: "zh-CN" }>;
  return (body.type as (props: { locale: "zh-CN" }) => ReactNode)(body.props);
}

type Sheet = ReactElement<Parameters<typeof BottomSheet>[0]>;
const NativeFormData = FormData;

beforeEach(() => {
  harness.cursor = 0;
  harness.states = [];
  harness.effects = [];
  harness.forget.mockReset().mockResolvedValue(undefined);
  harness.refresh.mockReset();
  harness.replace.mockReset();
  harness.finishReauthentication.mockReset().mockResolvedValue(undefined);
});
afterEach(() => vi.unstubAllGlobals());

describe("device data removal confirmation", () => {
  it("opens a confirmation and focuses cancellation without clearing device data", async () => {
    const labels = getEncryptionMessages("zh-CN");
    await find(encryptionTree(), (element) => element.type === "button" && element.props.children === labels.forget)!.props.onClick!();
    expect(harness.forget).not.toHaveBeenCalled();
    const tree = encryptionTree();
    const sheet = find(tree, (element) => element.type === BottomSheet) as Sheet;
    expect(sheet.props.open).toBe(true);
    const cancel = find(sheet.props.footer, (element) => element.type === "button" && element.props.children === labels.cancel)!;
    expect(sheet.props.initialFocusRef).toBe(cancel.props.ref);
    expect(sheet.props.returnFocusRef).toBe(find(tree, (element) => element.type === "button" && element.props.children === labels.forget)!.props.ref);
    cancel.props.onClick!();
    expect((find(encryptionTree(), (element) => element.type === BottomSheet) as Sheet).props.open).toBe(false);
    expect(harness.forget).not.toHaveBeenCalled();
  });

  it("clears device data only after explicit confirmation and preserves cleanup failure feedback", async () => {
    const labels = getEncryptionMessages("zh-CN");
    await find(encryptionTree(), (element) => element.type === "button" && element.props.children === labels.forget)!.props.onClick!();
    expect(harness.forget).not.toHaveBeenCalled();
    const sheet = find(encryptionTree(), (element) => element.type === BottomSheet) as Sheet;
    harness.forget.mockRejectedValue(new Error("LOCAL_KEY_STORAGE_UNAVAILABLE"));
    const confirm = find(sheet.props.footer, (element) => element.type === "button" && element.props.children !== labels.cancel)!;
    await confirm.props.onClick!();
    await vi.waitFor(() => expect(harness.forget).toHaveBeenCalledOnce());
    const tree = encryptionTree();
    expect(find(tree, (element) => element.type === "p" && element.props.children === labels.forgetFailed)).toBeDefined();
    expect((find(tree, (element) => element.type === BottomSheet) as Sheet).props.open).toBe(false);
    expect(harness.refresh).not.toHaveBeenCalled();
  });
});

describe("identity password confirmation feedback", () => {
  it("finishes reauthentication only after identity cleanup and never refreshes the revoked route", async () => {
    let cleaned!: () => void;
    harness.forget.mockImplementation(() => new Promise<void>((resolve) => { cleaned = resolve; }));
    vi.stubGlobal("FormData", class extends NativeFormData { constructor() { super(); } });
    const form = IdentityForm({ action: async () => ({ ok: true, data: { reauthenticate: true } }), labels: getMessages("zh-CN").identity, submitLabel: "Submit" });
    const event = { preventDefault: vi.fn(), currentTarget: { reset: vi.fn() } } as unknown as Parameters<NonNullable<FormHTMLAttributes<HTMLFormElement>["onSubmit"]>>[0];
    const pending = form.props.onSubmit!(event);
    await vi.waitFor(() => expect(harness.forget).toHaveBeenCalledOnce());
    expect(harness.finishReauthentication).not.toHaveBeenCalled();
    cleaned();
    await pending;
    expect(harness.finishReauthentication).toHaveBeenCalledOnce();
    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it("does not finalize browser authentication when local identity cleanup fails", async () => {
    harness.forget.mockRejectedValue(new Error("LOCAL_KEY_STORAGE_UNAVAILABLE"));
    vi.stubGlobal("FormData", class extends NativeFormData { constructor() { super(); } });
    const form = IdentityForm({ action: async () => ({ ok: true, data: { reauthenticate: true } }), labels: getMessages("zh-CN").identity, submitLabel: "Submit" });
    const event = { preventDefault: vi.fn(), currentTarget: { reset: vi.fn() } } as unknown as Parameters<NonNullable<FormHTMLAttributes<HTMLFormElement>["onSubmit"]>>[0];
    await form.props.onSubmit!(event);
    expect(harness.finishReauthentication).not.toHaveBeenCalled();
    expect(harness.refresh).not.toHaveBeenCalled();
    expect(harness.replace).not.toHaveBeenCalled();
  });

  it("associates a mismatch with the confirmation field, focuses it, and clears the error when edited", async () => {
    const labels = getMessages("zh-CN").identity;
    const action = vi.fn().mockResolvedValue({ ok: true, data: { message: "saved" } });
    const confirmation = { focus: vi.fn() };
    const formNode = { querySelector: vi.fn().mockReturnValue(confirmation), reset: vi.fn() };
    let confirmationValue = "different-password";
    vi.stubGlobal("FormData", class extends NativeFormData {
      constructor() { super(); this.set("newPassword", "new-password"); this.set("confirmPassword", confirmationValue); }
    });
    function render() {
      harness.cursor = 0;
      harness.effects = [];
      const form = IdentityForm({ action, labels, comparePasswords: true, submitLabel: labels.changePassword, children: <>
        <IdentityField label={labels.newPassword} name="newPassword" type="password" />
        <IdentityField label={labels.confirmPassword} name="confirmPassword" type="password" />
      </> }) as ReactElement<FormHTMLAttributes<HTMLFormElement> & { ref?: RefObject<HTMLFormElement | null> }>;
      if (form.props.ref) form.props.ref.current = formNode as unknown as HTMLFormElement;
      const markup = renderToStaticMarkup(form);
      for (const effect of harness.effects) effect();
      return { form, markup };
    }
    const event = { preventDefault: vi.fn(), currentTarget: formNode } as unknown as Parameters<NonNullable<FormHTMLAttributes<HTMLFormElement>["onSubmit"]>>[0];
    await render().form.props.onSubmit!(event);
    const mismatch = render();
    expect(action).not.toHaveBeenCalled();
    expect(mismatch.markup).toMatch(/<input[^>]*aria-invalid="true"[^>]*name="confirmPassword"/);
    const description = mismatch.markup.match(/aria-describedby="([^"]+)"/)?.[1];
    expect(description).toBeTruthy();
    expect(mismatch.markup).toContain(`id="${description}"`);
    expect(mismatch.markup).toContain(labels.passwordMismatch);
    expect(confirmation.focus).toHaveBeenCalledOnce();
    mismatch.form.props.onInput!({ target: { name: "confirmPassword" } } as unknown as Parameters<NonNullable<FormHTMLAttributes<HTMLFormElement>["onInput"]>>[0]);
    confirmationValue = "new-password";
    const corrected = render();
    expect(corrected.markup).not.toContain('aria-invalid="true"');
    expect(corrected.markup).not.toContain(labels.passwordMismatch);
    await corrected.form.props.onSubmit!(event);
    expect(action).toHaveBeenCalledOnce();
    expect(formNode.reset).toHaveBeenCalledOnce();
  });
});
