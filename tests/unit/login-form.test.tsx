import { renderToStaticMarkup } from "react-dom/server";
import type { FormHTMLAttributes, ReactElement, ReactNode, SubmitEvent } from "react";
import { afterEach, beforeEach, describe, expect, test, vi } from "vitest";
import { LoginForm } from "@/components/login-form";
import { getMessages, type Messages } from "@/lib/i18n";

const harness = vi.hoisted(() => ({
  error: "",
  replace: vi.fn(),
  signIn: vi.fn(),
}));

vi.mock("react", async (importOriginal) => ({
  ...(await importOriginal<typeof import("react")>()),
  useState: (initial: unknown) => typeof initial === "string"
    ? [harness.error, (value: string) => { harness.error = value; }]
    : [initial, () => undefined],
  useRef: (initial: unknown) => ({ current: initial }),
  useSyncExternalStore: (
    _subscribe: unknown,
    _getSnapshot: unknown,
    getServerSnapshot: () => boolean,
  ) => getServerSnapshot(),
}));

vi.mock("next/navigation", () => ({
  useRouter: () => ({
    replace: harness.replace,
  }),
}));

vi.mock("next-auth/react", () => ({
  SessionProvider: ({ children }: { children: ReactNode }) => children,
  signIn: harness.signIn,
}));

const labels = getMessages("en-US").login;
const NativeFormData = FormData;

beforeEach(() => {
  harness.error = "";
  vi.clearAllMocks();
  harness.signIn.mockReset();
  vi.stubGlobal("FormData", class extends NativeFormData {
    constructor() {
      super();
      this.set("email", "member@example.test");
      this.set("password", "test-password");
    }
  });
});

afterEach(() => {
  vi.unstubAllGlobals();
});

async function submitLogin(formLabels: Messages["login"]) {
  const form = LoginForm({ authBasePath: "/api/auth", labels: formLabels }).props
    .children as ReactElement<FormHTMLAttributes<HTMLFormElement>>;

  await form.props.onSubmit?.({
    preventDefault: vi.fn(),
    currentTarget: {} as HTMLFormElement,
  } as unknown as SubmitEvent<HTMLFormElement>);

  return renderToStaticMarkup(
    <LoginForm authBasePath="/api/auth" labels={formLabels} />,
  );
}

describe("LoginForm", () => {
  test("prevents native GET credential submission before hydration", () => {
    const markup = renderToStaticMarkup(
      <LoginForm authBasePath="/api/auth" labels={labels} />,
    );

    expect(markup).toContain('method="post"');
    expect(markup).toContain("disabled");
  });

  test.each([
    ["zh-CN", "登录尝试过于频繁，请稍后重试。"],
    ["en-US", "Too many login attempts. Please try again later."],
  ] as const)("shows the retry-later message for rate-limited login in %s", async (locale, message) => {
    const formLabels = getMessages(locale).login;
    harness.signIn.mockResolvedValue({
      error: "CredentialsSignin",
      code: "rate_limited",
      status: 401,
      ok: false,
      url: null,
    });

    const markup = await submitLogin(formLabels);

    expect(markup).toContain(message);
    expect(markup).not.toContain(formLabels.invalidCredentials);
    expect(harness.replace).not.toHaveBeenCalled();
  });

  test("keeps the generic credentials message for an ordinary login failure", async () => {
    harness.signIn.mockResolvedValue({
      error: "CredentialsSignin",
      code: "credentials",
      status: 401,
      ok: false,
      url: null,
    });

    expect(await submitLogin(labels)).toContain(labels.invalidCredentials);
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.signIn).toHaveBeenCalledTimes(1);
  });

  test("keeps a retryable error when the login request cannot complete", async () => {
    harness.signIn.mockRejectedValue(new Error("Network unavailable"));
    expect(await submitLogin(labels)).toContain(labels.unavailable);
    expect(harness.replace).not.toHaveBeenCalled();
    expect(harness.signIn).toHaveBeenCalledTimes(1);
  });

  test("refreshes a stale CSRF challenge once without retrying a credentials rejection", async () => {
    harness.signIn.mockResolvedValueOnce({ error: "MissingCSRF" }).mockResolvedValueOnce({ error: undefined });
    await submitLogin(labels);
    expect(harness.signIn).toHaveBeenCalledTimes(2);
    expect(harness.replace).toHaveBeenCalledWith("/home");
  });

  test("bounds retries when the CSRF challenge continues to fail", async () => {
    harness.signIn.mockResolvedValue({ error: "MissingCSRF" });
    expect(await submitLogin(labels)).toContain(labels.invalidCredentials);
    expect(harness.signIn).toHaveBeenCalledTimes(2);
    expect(harness.replace).not.toHaveBeenCalled();
  });

  test("navigates to the ledger after successful login", async () => {
    harness.signIn.mockResolvedValue({
      error: undefined,
      code: undefined,
      status: 200,
      ok: true,
      url: "/home",
    });

    const markup = await submitLogin(labels);

    expect(harness.replace).toHaveBeenCalledWith("/home");
    expect(markup).not.toContain(labels.invalidCredentials);
  });
});
