import { expect, test, type Locator, type Page } from "./fixtures";
import { getMessages } from "../../src/lib/i18n";

const features = ["security", "entry", "import", "reports"] as const;
const chinese = getMessages("zh-CN").help.showcase;
const english = getMessages("en-US").help.showcase;

async function openHelp(page: Page) {
  // Only release metadata is substituted; the feature demonstrations render normally.
  await page.route("**/api/downloads", (route) => route.fulfill({ json: {
    android: { status: "available", version: "1.60.0", size: 5242880, minSdk: 29 },
    windows: { status: "available", version: "1.59.0", size: 73400320 },
  } }));
  await page.goto("/help");
}

function demonstration(page: Page, feature: typeof features[number]) {
  const section = page.locator(`#feature-${feature}`);
  return { section, stage: section.locator("figure[data-demo-step]") };
}

async function finishDemonstration(page: Page, stage: Locator) {
  // Let React commit each frame before advancing the timer scheduled by its next effect.
  for (const step of [1, 2, 3]) {
    await page.clock.runFor(3400);
    await expect(stage).toHaveAttribute("data-demo-step", String(step));
  }
  await page.clock.runFor(3400);
  await expect(stage).toHaveAttribute("data-demo-playing", "false");
}

async function setDocumentHidden(page: Page, hidden: boolean) {
  // Headless Chromium keeps tabs foregrounded; substitute only the visibility API boundary.
  await page.evaluate((value) => {
    if (value) {
      Object.defineProperty(document, "hidden", { configurable: true, value: true });
      Object.defineProperty(document, "visibilityState", { configurable: true, value: "hidden" });
    } else {
      Reflect.deleteProperty(document, "hidden");
      Reflect.deleteProperty(document, "visibilityState");
    }
    document.dispatchEvent(new Event("visibilitychange"));
  }, hidden);
}

test("the public help page introduces its four feature demonstrations on a bilingual mobile layout", async ({ page }) => {
  await page.setViewportSize({ width: 320, height: 844 });
  await openHelp(page);
  for (const feature of features) {
    await expect(page.locator(`#feature-${feature}`).getByRole("heading", { level: 2 })).toBeVisible();
  }
  expect(await page.locator("#features, #downloads, #apply, #contents").evaluateAll((elements) => elements.map((element) => element.id)))
    .toEqual(["features", "downloads", "apply", "contents"]);
  for (const anchor of ["features", "downloads", "apply", "contents"]) {
    await expect(page.locator(`main > header a[href="#${anchor}"]`)).toBeVisible();
  }
  await expect(page.getByRole("link", { name: "下载 Android APK", exact: true })).toHaveAttribute("href", "/api/downloads/android");
  await expect(page.locator("#apply").getByRole("textbox", { name: getMessages("zh-CN").accessApplication.email, exact: true })).toBeVisible();
  await expect(page.locator("#apply").getByRole("textbox", { name: getMessages("zh-CN").accessApplication.note, exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

  await page.getByRole("button", { name: "切换语言", exact: true }).click();
  await expect(page.locator("html")).toHaveAttribute("lang", "en-US");
  await expect(page.locator("#features").getByRole("button", { name: english.replay, exact: true })).toHaveCount(4);
  await expect(page.locator("#feature-import").getByRole("heading", { level: 2, name: english.import.title, exact: true })).toBeVisible();
  await expect(page.getByRole("link", { name: "Download Windows EXE", exact: true })).toHaveAttribute("href", "/api/downloads/windows");
  await expect(page.getByRole("navigation", { name: "Guide contents" })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
});

test("the statement import demonstration reviews categories and duplicates before recording its sample totals locally", async ({ page }) => {
  const mutations: string[] = [];
  const apiReads: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (!["GET", "HEAD"].includes(request.method())) mutations.push(`${request.method()} ${pathname}`);
    if (pathname.startsWith("/api/")) apiReads.push(pathname);
  });
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.clock.install();
  await openHelp(page);
  const { section, stage } = demonstration(page, "import");
  await expect(section.getByRole("heading", { level: 2 })).toBeVisible();
  const labels = chinese.import;
  expect(await page.locator("#features > section").evaluateAll((elements) => elements.map((element) => element.id)))
    .toEqual(features.map((feature) => `feature-${feature}`));
  for (const [source, formats] of [
    [labels.sources.suiShouJi, [".xlsx"]],
    [labels.sources.wechatPay, [".xlsx"]],
    [labels.sources.alipay, [".csv"]],
    [labels.sources.cmb, [".pdf", ".zip"]],
  ] as const) {
    const sourceItem = stage.getByRole("listitem").filter({ hasText: source });
    await expect(sourceItem).toBeVisible();
    for (const format of formats) await expect(sourceItem).toContainText(format);
  }
  await expect(section.getByRole("link", { name: chinese.readGuide, exact: true })).toHaveAttribute("href", "#import-export");
  await stage.scrollIntoViewIfNeeded();
  await section.getByRole("button", { name: chinese.replay, exact: true }).click();
  await expect(stage).toHaveAttribute("data-demo-step", "0");
  await expect(stage.getByText(labels.steps[0], { exact: true })).toBeVisible();
  await expect(stage.getByText(labels.saved, { exact: true })).not.toBeVisible();
  for (const step of [1, 2, 3]) {
    await page.clock.runFor(3400);
    await expect(stage).toHaveAttribute("data-demo-step", String(step));
    await expect(stage.getByText(labels.steps[step], { exact: true })).toBeVisible();
    if (step < 3) await expect(stage.getByText(labels.saved, { exact: true })).not.toBeVisible();
    if (step === 2) await expect(stage.getByText(labels.duplicate, { exact: true })).toBeVisible();
  }
  await expect(stage.getByText(labels.uploaded, { exact: true })).toBeVisible();
  await expect(stage.getByText(labels.saved, { exact: true })).toBeVisible();
  for (const description of ["午饭", "地铁"]) await expect(stage.getByText(description, { exact: true }).first()).toBeVisible();
  for (const amount of ["−¥35.00", "−¥6.00", "¥41.00"]) await expect(stage.getByText(amount, { exact: true }).first()).toBeVisible();
  await expect(stage.getByText(labels.total, { exact: true })).toBeVisible();
  await page.clock.runFor(3400);
  await expect(section.getByRole("button", { name: chinese.complete, exact: true })).toBeDisabled();
  expect(mutations).toEqual([]);
  expect(apiReads.every((path) => path === "/api/downloads")).toBe(true);
});

test("a visible demonstration advances and supports pause, resume and replay", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.clock.install();
  await openHelp(page);
  const { section, stage } = demonstration(page, "security");
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveAttribute("data-demo-playing", "true");
  await section.getByRole("button", { name: chinese.replay, exact: true }).click();
  await expect(stage).toHaveAttribute("data-demo-step", "0");
  await page.clock.runFor(3400);
  await expect(stage).toHaveAttribute("data-demo-step", "1");
  await expect(stage.getByText("已开启", { exact: true })).toBeVisible();

  await section.getByRole("button", { name: chinese.pause, exact: true }).click();
  await expect(section.getByRole("button", { name: chinese.resume, exact: true })).toBeEnabled();
  await expect(stage).toHaveAttribute("data-demo-playing", "false");
  await page.clock.runFor(20_000);
  await expect(stage).toHaveAttribute("data-demo-step", "1");
  await section.getByRole("button", { name: chinese.resume, exact: true }).click();
  await page.clock.runFor(3400);
  await expect(stage).toHaveAttribute("data-demo-step", "2");

  await section.getByRole("button", { name: chinese.replay, exact: true }).click();
  await expect(stage).toHaveAttribute("data-demo-step", "0");
  await expect(stage).toHaveAttribute("data-demo-playing", "true");
  await finishDemonstration(page, stage);
  await expect(stage.getByText("已解锁，可以查看", { exact: true })).toBeVisible();
  await expect(section.getByRole("button", { name: chinese.complete, exact: true })).toBeDisabled();
  await expect(section.getByRole("button", { name: chinese.replay, exact: true })).toBeEnabled();
});

test("offscreen and background demonstrations stop while preserving a deliberate pause", async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 1000 });
  await page.clock.install();
  await openHelp(page);
  const { section, stage } = demonstration(page, "reports");
  await stage.scrollIntoViewIfNeeded();
  await section.getByRole("button", { name: chinese.replay, exact: true }).click();
  await page.clock.runFor(3400);
  await expect(stage).toHaveAttribute("data-demo-step", "1");

  await page.locator("#contents").scrollIntoViewIfNeeded();
  await expect(stage).toHaveAttribute("data-demo-playing", "false");
  await page.clock.runFor(20_000);
  await expect(stage).toHaveAttribute("data-demo-step", "1");
  await stage.scrollIntoViewIfNeeded();
  await expect(stage).toHaveAttribute("data-demo-playing", "true");

  await setDocumentHidden(page, true);
  await expect(stage).toHaveAttribute("data-demo-playing", "false");
  await page.clock.runFor(20_000);
  await expect(stage).toHaveAttribute("data-demo-step", "1");
  await setDocumentHidden(page, false);
  await expect(stage).toHaveAttribute("data-demo-playing", "true");

  await section.getByRole("button", { name: chinese.pause, exact: true }).click();
  await page.locator("#contents").scrollIntoViewIfNeeded();
  await stage.scrollIntoViewIfNeeded();
  await setDocumentHidden(page, true);
  await setDocumentHidden(page, false);
  await page.clock.runFor(20_000);
  await expect(stage).toHaveAttribute("data-demo-playing", "false");
  await expect(stage).toHaveAttribute("data-demo-step", "1");
  await expect(section.getByRole("button", { name: chinese.resume, exact: true })).toBeEnabled();
});

test("reduced motion shows the complete static demonstrations with playback disabled", async ({ page }) => {
  await page.emulateMedia({ reducedMotion: "reduce" });
  await page.clock.install();
  await openHelp(page);
  const completedLabels = {
    security: "已解锁，可以查看",
    entry: "三笔记录已入账",
    import: "两笔记录已入账",
    reports: "18 日 · 2 笔支出",
  };
  for (const feature of features) {
    const { section, stage } = demonstration(page, feature);
    await stage.scrollIntoViewIfNeeded();
    await expect(stage).toHaveAttribute("data-demo-step", "3");
    await expect(stage).toHaveAttribute("data-demo-playing", "false");
    await expect(stage).toHaveAttribute("data-reduced-motion", "true");
    await expect(section.getByRole("button", { name: chinese.pause, exact: true })).toBeDisabled();
    await expect(section.getByRole("button", { name: chinese.replay, exact: true })).toBeDisabled();
    await expect(stage.getByText(completedLabels[feature], { exact: true })).toBeVisible();
    expect(await stage.evaluate((element) => element.getAnimations({ subtree: true }).filter((animation) => animation.playState === "running").length)).toBe(0);
  }
  await page.clock.runFor(20_000);
  for (const feature of features) {
    await expect(demonstration(page, feature).stage).toHaveAttribute("data-demo-step", "3");
  }
});

test("voice and text examples stay local without requesting a microphone or sending entries", async ({ page }) => {
  let microphoneRequests = 0;
  await page.exposeFunction("reportUnexpectedMicrophone", () => { microphoneRequests += 1; });
  await page.addInitScript(() => {
    // Fail at the real browser permission boundary if a demonstration attempts recording.
    navigator.mediaDevices.getUserMedia = async () => {
      await (window as unknown as { reportUnexpectedMicrophone: () => Promise<void> }).reportUnexpectedMicrophone();
      throw new DOMException("A product demonstration must not record audio", "NotAllowedError");
    };
  });
  const mutations: string[] = [];
  const apiReads: string[] = [];
  page.on("request", (request) => {
    const pathname = new URL(request.url()).pathname;
    if (!["GET", "HEAD"].includes(request.method())) mutations.push(`${request.method()} ${pathname}`);
    if (pathname.startsWith("/api/")) apiReads.push(pathname);
  });
  await page.clock.install();
  await openHelp(page);
  const { section, stage } = demonstration(page, "entry");
  await stage.scrollIntoViewIfNeeded();
  const voice = section.getByRole("button", { name: "说出来", exact: true });
  const text = section.getByRole("button", { name: "写下来", exact: true });
  await expect(voice).toHaveAttribute("aria-pressed", "true");
  await section.getByRole("button", { name: chinese.replay, exact: true }).click();
  await text.click();
  await expect(text).toHaveAttribute("aria-pressed", "true");
  await expect(voice).toHaveAttribute("aria-pressed", "false");
  await finishDemonstration(page, stage);
  for (const record of ["午饭", "地铁", "工资到账"]) {
    await expect(stage.getByText(record, { exact: true })).toBeVisible();
  }
  await voice.click();
  await expect(voice).toHaveAttribute("aria-pressed", "true");
  await expect(text).toHaveAttribute("aria-pressed", "false");
  await section.getByRole("button", { name: chinese.replay, exact: true }).click();
  await finishDemonstration(page, stage);
  expect(microphoneRequests).toBe(0);
  expect(mutations).toEqual([]);
  expect(apiReads.every((path) => path === "/api/downloads")).toBe(true);
});
