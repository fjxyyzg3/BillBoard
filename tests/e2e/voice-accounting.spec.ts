import { PrismaClient } from "@prisma/client";
import { clearTransactions } from "./db-cleanup";
import { expect, test, type Page } from "./fixtures";
import { prepareVoiceTranscription } from "./voice-admission-fixture";

const pendingKeyPrefix = "billboard:voice-pending:v2:";
const mixedTransactions = "工资转账到账8000元，午饭花了35元";
const mixedSuccess = "已记 2 笔，收入 ¥8,000.00，支出 ¥35.00";
type VoiceWindow = typeof window & {
  voiceFixture: { calls: number; tracks: MediaStreamTrack[]; delivered: number; grant: () => void };
};

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function ledgerSnapshot() {
  const url = new URL(requireEnv("DATABASE_URL"));
  if (process.env.NODE_ENV === "production" || !["127.0.0.1", "localhost"].includes(url.hostname)
    || !/(?:dev|test)/i.test(url.pathname.replace(/^\//, ""))) {
    throw new Error("Voice fixtures require a local dev/test database");
  }
  const prisma = new PrismaClient();
  try {
    const user = await prisma.user.findUniqueOrThrow({ where: { email: requireEnv("SEED_USER_A_EMAIL") },
      select: { householdMember: { where: { leftAt: null }, take: 1, select: { id: true, householdId: true } } } });
    if (!user.householdMember[0]) throw new Error("Seed member is missing");
    const member = user.householdMember[0];
    const ledger = await prisma.ledger.findFirstOrThrow({ where: { householdId: member.householdId, isDefault: true } });
    const [transactions, requests] = await Promise.all([
      prisma.transaction.findMany({ where: { householdId: member.householdId, deletedAt: null },
        orderBy: { id: "asc" }, select: { id: true, type: true, amountFen: true, actorMemberId: true,
          createdByMemberId: true, source: true, sourceFingerprint: true, sourceImportedAt: true } }),
      prisma.naturalLanguageRequest.findMany({ where: { householdId: member.householdId, createdByMemberId: member.id },
        orderBy: { createdAt: "asc" }, select: { clientRequestId: true, status: true, errorCode: true } }),
    ]);
    return { member, ledger, transactions, requests };
  } finally {
    await prisma.$disconnect();
  }
}

async function installMicrophone(page: Page, options: { deferred?: boolean; lateResponse?: boolean } = {}) {
  await page.addInitScript(({ deferred, lateResponse }) => {
    const fixture = { calls: 0, tracks: [] as MediaStreamTrack[], delivered: 0, grant: () => {} };
    (window as VoiceWindow).voiceFixture = fixture;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      fixture.calls += 1;
      // Use native audio rendering and the production worklet/WAV encoder.
      const context = new AudioContext();
      const oscillator = context.createOscillator();
      const destination = context.createMediaStreamDestination();
      oscillator.frequency.value = 440;
      oscillator.connect(destination);
      oscillator.start();
      await context.resume();
      for (const track of destination.stream.getTracks()) {
        fixture.tracks.push(track);
        const stop = track.stop.bind(track);
        track.stop = () => {
          stop();
          oscillator.disconnect();
          if (context.state !== "closed") void context.close();
        };
      }
      if (deferred) await new Promise<void>((resolve) => { fixture.grant = resolve; });
      return destination.stream;
    } });
    const originalFetch = window.fetch.bind(window);
    window.fetch = async (input, init) => {
      const voiceRequest = typeof input === "string" && input.includes("/api/voice/transcribe");
      const response = await originalFetch(input, voiceRequest && lateResponse ? { ...init, signal: undefined } : init);
      if (voiceRequest) fixture.delivered += 1;
      return response;
    };
  }, options);
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
}

function entryLink(page: Page, english = false) {
  return page.getByRole("link", { name: english ? "Add" : "记一笔", exact: true }).filter({ visible: true });
}

function dialog(page: Page, english = false) {
  return page.getByRole("dialog", { name: english ? "Voice entry" : "语音记账", exact: true });
}

async function hold(page: Page, options: { touch?: boolean; permission?: boolean } = {}) {
  const box = await entryLink(page).boundingBox();
  if (!box) throw new Error("Voice navigation is not visible");
  const position = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
  const session = options.touch ? await page.context().newCDPSession(page) : null;
  if (session) {
    await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...position, id: 1 }] });
  } else {
    await page.mouse.move(position.x, position.y);
    await page.mouse.down();
  }
  await expect(dialog(page)).toBeVisible();
  await expect(dialog(page).getByText(options.permission ? "请允许使用麦克风，并继续按住" : "正在录音", { exact: true })).toBeVisible();
  if (!options.permission) await expect(dialog(page).getByText(/^[1-9]\d* \/ 60 s$/)).toBeVisible();
  return {
    async slideUp() {
      if (session) await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: position.x, y: position.y - 100, id: 1 }] });
      else await page.mouse.move(position.x, position.y - 100);
    },
    async release() {
      if (session) {
        await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        await session.detach();
      } else await page.mouse.up();
    },
  };
}

async function assertMicrophoneReleased(page: Page) {
  await expect.poll(() => page.evaluate(() => (window as VoiceWindow).voiceFixture.tracks.filter((track) => track.readyState === "live").length)).toBe(0);
}

async function transcriber(page: Page, text = mixedTransactions, delayed = false) {
  const state = { calls: 0, bodies: [] as Buffer[] };
  let waiting: Awaited<ReturnType<typeof prepareVoiceTranscription>> | null = null;
  await page.route("**/api/voice/transcribe", async (route) => {
    const body = route.request().postDataBuffer();
    if (body) state.bodies.push(body);
    const transcription = await prepareVoiceTranscription(route);
    state.calls += 1;
    if (delayed) { waiting = transcription; return; }
    await transcription.fulfill(text);
  });
  return { state, async finish() {
    expect(waiting).not.toBeNull();
    const transcription = waiting!;
    waiting = null;
    await transcription.fulfill(text);
  } };
}

function observeActions(page: Page) {
  const actions: unknown[][] = [];
  page.on("request", (request) => {
    if (request.method() === "POST" && request.headers()["next-action"]) actions.push(request.postDataJSON() as unknown[]);
    else if (request.method() === "POST" && new URL(request.url()).pathname === "/api/voice/entry") actions.push([request.postDataJSON()]);
    else if (request.method() === "GET" && new URL(request.url()).pathname === "/api/voice/entry") actions.push([new URL(request.url()).searchParams.get("requestId")]);
  });
  return actions;
}

async function pendingEntries(page: Page) {
  return page.evaluate((prefix) => Object.entries(sessionStorage).filter(([key]) => key.startsWith(prefix) || key.startsWith("billboard:natural-language-pending:v2:")), pendingKeyPrefix);
}

async function pauseFirstActionResponse(page: Page) {
  const state = { received: false };
  let intercepted = false;
  let release = () => {};
  const released = new Promise<void>((resolve) => { release = resolve; });
  await page.route("**/*", async (route) => {
    const request = route.request();
    if (intercepted || request.method() !== "POST" || (!request.headers()["next-action"] && new URL(request.url()).pathname !== "/api/voice/entry")) {
      await route.fallback();
      return;
    }
    intercepted = true;
    const response = await route.fetch();
    await response.body();
    state.received = true;
    await released;
    await route.fulfill({ response });
  });
  return { state, release };
}

test.describe("voice accounting", () => {
  test.beforeEach(async ({ page }) => {
    await clearTransactions();
    await page.setViewportSize({ width: 390, height: 844 });
  });

  test("keeps the background still during voice recording and restores its scroll position", async ({ page }) => {
    await installMicrophone(page);
    await login(page);
    await page.setViewportSize({ width: 390, height: 600 });
    await page.emulateMedia({ reducedMotion: "reduce" });
    await page.goto("/add");
    await expect(page.getByRole("heading", { name: "记一笔", exact: true })).toBeVisible();
    await expect(page.getByLabel("金额", { exact: true })).toBeEnabled();
    await page.evaluate(() => window.scrollTo(0, 160));
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(160);
    const before = await page.evaluate(() => ({
      scrollY: window.scrollY,
      position: document.body.style.position,
      headingTop: document.querySelector("h1")!.getBoundingClientRect().top,
    }));
    const recording = await hold(page);
    await expect.poll(() => page.evaluate(() => document.body.style.position)).toBe("fixed");
    expect(await page.locator("h1").evaluate((heading) => heading.getBoundingClientRect().top)).toBeCloseTo(before.headingTop, 0);
    await page.mouse.move(5, 5);
    await page.mouse.wheel(0, 600);
    await page.evaluate(() => new Promise<void>((resolve) => requestAnimationFrame(() => requestAnimationFrame(() => resolve()))));
    expect(await page.locator("h1").evaluate((heading) => heading.getBoundingClientRect().top)).toBeCloseTo(before.headingTop, 0);
    await recording.slideUp();
    await recording.release();
    await expect(dialog(page).getByRole("alert")).toContainText("本次录音未发送");
    await page.keyboard.press("Escape");
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => page.evaluate(() => document.body.style.position)).toBe(before.position);
    await expect.poll(() => page.evaluate(() => window.scrollY)).toBe(before.scrollY);
    await assertMicrophoneReleased(page);
  });

  test("releases the recording surface immediately and permits a second recording before transcription finishes", async ({ page }) => {
    await installMicrophone(page);
    const asr = await transcriber(page, mixedTransactions, true);
    await login(page);
    const first = await hold(page);
    await first.release();
    await expect(dialog(page)).toHaveCount(0, { timeout: 1500 });
    await expect.poll(() => asr.state.calls).toBe(1);
    await assertMicrophoneReleased(page);
    await entryLink(page).click();
    await expect(page).toHaveURL(/\/add$/);
    const second = await hold(page);
    await asr.finish();
    await expect.poll(async () => (await ledgerSnapshot()).transactions.length).toBe(2);
    await expect(dialog(page).getByText("正在录音", { exact: true })).toBeVisible();
    await expect(page.getByTestId("voice-success-notice")).toHaveCount(0);
    await second.release();
    await expect(dialog(page)).toHaveCount(0);
    await assertMicrophoneReleased(page);
    await expect(page.getByTestId("voice-success-notice")).toContainText(mixedSuccess);
    await expect.poll(() => asr.state.calls).toBe(2);
    await asr.finish();
    await expect.poll(async () => (await ledgerSnapshot()).transactions.length).toBe(4);
    const saved = await ledgerSnapshot();
    expect(saved.requests).toHaveLength(2);
    expect(new Set(saved.requests.map((request) => request.clientRequestId)).size).toBe(2);
    await expect(dialog(page)).toHaveCount(0);
  });

  test("shows voice processing feedback immediately and opens the task list", async ({ page }, testInfo) => {
    await installMicrophone(page);
    const asr = await transcriber(page, mixedTransactions, true);
    await login(page);
    const target = (await ledgerSnapshot()).ledger;
    const ledgerName = target.name === "Default" ? "默认账本" : target.name;
    const response = await pauseFirstActionResponse(page);
    try {
      const pressed = await hold(page);
      await pressed.release();
      await expect(dialog(page)).toHaveCount(0, { timeout: 1500 });
      const status = page.getByTestId("voice-task-status");
      await expect(status).toBeVisible({ timeout: 1500 });
      await expect(status).toContainText("正在识别语音…");
      await expect(page.getByRole("status").filter({ hasText: "正在识别语音…" })).toBeVisible();
      await expect(status).toContainText(ledgerName);
      await expect(entryLink(page)).toBeFocused();
      await assertMicrophoneReleased(page);
      const position = await status.boundingBox();
      expect(position).not.toBeNull();
      expect(position!.y).toBeGreaterThan(844 / 2);
      await page.screenshot({ path: testInfo.outputPath("voice-processing-mobile.png"), fullPage: true });
      for (const width of [320, 768, 1280]) {
        await page.setViewportSize({ width, height: 844 });
        await expect(status).toBeVisible();
        const box = await status.boundingBox();
        expect(box).not.toBeNull();
        expect(box!.x).toBeGreaterThanOrEqual(0);
        expect(box!.x + box!.width).toBeLessThanOrEqual(width);
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
        await page.screenshot({ path: testInfo.outputPath(`voice-processing-${width}.png`), fullPage: true });
      }
      await page.setViewportSize({ width: 390, height: 844 });
      await status.getByRole("button", { name: "查看状态", exact: true }).click();
      await expect(dialog(page).getByTestId("voice-task-list")).toContainText("正在识别语音…");
      await expect(dialog(page).getByTestId("voice-task-list")).toContainText(ledgerName);
      await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
      await expect(status).toBeVisible();
      await expect.poll(() => asr.state.calls).toBe(1);
      await asr.finish();
      await expect.poll(() => response.state.received).toBe(true);
      await expect(status).toContainText("正在记账…");
      await expect(dialog(page)).toHaveCount(0);
      response.release();
      const success = page.getByTestId("voice-success-notice");
      await expect(success).toContainText(mixedSuccess);
      await expect(success).toContainText(ledgerName);
      const recorded = success.getByRole("link", { name: "查看记录", exact: true });
      await expect(recorded).toHaveAttribute("href", `/records?mode=all&ledger=${encodeURIComponent(target.id)}`);
      const completedPosition = await status.boundingBox();
      expect(completedPosition).not.toBeNull();
      expect(Math.abs(completedPosition!.y + completedPosition!.height - position!.y - position!.height)).toBeLessThan(4);
      await page.screenshot({ path: testInfo.outputPath("voice-completed-mobile.png"), fullPage: true });
      await recorded.click();
      await expect(page.getByRole("combobox", { name: "查看范围", exact: true })).toHaveValue(target.id);
      expect((await ledgerSnapshot()).transactions).toHaveLength(2);
    } finally {
      response.release();
    }
  });

  test("combines processing and queued recordings into one status without blocking the next entry", async ({ page }) => {
    await installMicrophone(page);
    const asr = await transcriber(page, mixedTransactions, true);
    await login(page);
    const first = await hold(page);
    await first.release();
    await expect.poll(() => asr.state.calls).toBe(1);
    const second = await hold(page);
    await second.release();
    await expect(dialog(page)).toHaveCount(0);
    const status = page.getByTestId("voice-task-status");
    await expect(status).toHaveCount(1);
    await expect(status).toContainText("1 段处理中 · 1 段排队");
    await assertMicrophoneReleased(page);
    await status.getByRole("button", { name: "查看状态", exact: true }).click();
    const list = dialog(page).getByTestId("voice-task-list");
    await expect(list).toContainText("正在识别语音…");
    await expect(list).toContainText("等待处理");
    await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
    await asr.finish();
    await expect.poll(() => asr.state.calls).toBe(2);
    await asr.finish();
    await expect.poll(async () => (await ledgerSnapshot()).transactions.length).toBe(4);
    const saved = await ledgerSnapshot();
    expect(saved.requests).toHaveLength(2);
    expect(new Set(saved.requests.map((request) => request.clientRequestId)).size).toBe(2);
    await expect(dialog(page)).toHaveCount(0);
  });

  test("saves a manual entry while the background voice accounting response is still pending", async ({ page }) => {
    await installMicrophone(page);
    await transcriber(page);
    await login(page);
    const response = await pauseFirstActionResponse(page);
    try {
      const pressed = await hold(page);
      await pressed.release();
      await expect.poll(() => response.state.received).toBe(true);
      await expect(dialog(page)).toHaveCount(0);
      await entryLink(page).click();
      await page.getByLabel("金额", { exact: true }).fill("12.34");
      await page.getByRole("button", { name: "保存记录", exact: true }).click();
      await expect.poll(async () => (await ledgerSnapshot()).transactions.length).toBe(3);
      await expect(page.getByText("记录已保存", { exact: true })).toBeVisible();
      response.release();
      await expect(page.getByTestId("voice-success-notice")).toContainText(mixedSuccess);
    } finally {
      response.release();
    }
  });

  test("keeps short clicks as navigation and touch holds automatically record mixed transactions on the current page", async ({ page }, testInfo) => {
    await installMicrophone(page);
    const asr = await transcriber(page);
    await login(page);
    await entryLink(page).click();
    await expect(page).toHaveURL(/\/add$/);
    expect(await page.evaluate(() => (window as VoiceWindow).voiceFixture.calls)).toBe(0);
    await page.getByRole("link", { name: "首页", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/);
    const before = page.url();
    const pressed = await hold(page, { touch: true });
    await expect(page).toHaveURL(before);
    await page.screenshot({ path: testInfo.outputPath("voice-recording-mobile.png"), fullPage: true });
    await pressed.release();
    await expect(page.getByTestId("voice-success-notice").getByText(mixedSuccess, { exact: true })).toBeVisible();
    await page.screenshot({ path: testInfo.outputPath("voice-success-mobile.png"), fullPage: true });
    await expect(page).toHaveURL(before);
    await assertMicrophoneReleased(page);
    expect(asr.state.calls).toBe(1);
    const wav = asr.state.bodies[0];
    expect(wav.toString("ascii", 0, 4)).toBe("RIFF");
    expect(wav.toString("ascii", 8, 12)).toBe("WAVE");
    expect(wav.readUInt16LE(22)).toBe(1);
    expect(wav.readUInt32LE(24)).toBe(16000);
    expect(wav.readUInt16LE(34)).toBe(16);
    expect(wav.length).toBeGreaterThan(44);
    expect(wav.length).toBeLessThanOrEqual(2 * 1024 * 1024);
    expect(wav.subarray(44).some((value) => value !== 0)).toBe(true);
    const saved = await ledgerSnapshot();
    expect(saved.transactions).toHaveLength(2);
    expect(saved.transactions.map(({ amountFen }) => amountFen).sort((a, b) => a - b)).toEqual([3500, 800000]);
    expect(new Set(saved.transactions.map(({ type }) => type))).toEqual(new Set(["INCOME", "EXPENSE"]));
    for (const record of saved.transactions) expect(record).toMatchObject({ actorMemberId: saved.member.id,
      createdByMemberId: saved.member.id, source: null, sourceFingerprint: null, sourceImportedAt: null });
    expect(saved.requests).toHaveLength(1);
    expect(await pendingEntries(page)).toEqual([]);
  });

  test("losing focus before the long-press threshold prevents any microphone permission request", async ({ page }) => {
    await installMicrophone(page);
    const asr = await transcriber(page);
    await login(page);
    const actions = observeActions(page);
    await page.clock.install();
    const box = await entryLink(page).boundingBox();
    if (!box) throw new Error("Voice navigation is not visible");
    await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
    await page.mouse.down();
    await page.clock.runFor(200);
    await page.evaluate(() => window.dispatchEvent(new Event("blur")));
    await page.clock.runFor(500);
    await page.mouse.up();
    await expect(dialog(page)).toHaveCount(0);
    await expect(page).toHaveURL(/\/home$/);
    expect(await page.evaluate(() => (window as VoiceWindow).voiceFixture.calls)).toBe(0);
    expect(asr.state.calls).toBe(0);
    expect(actions).toEqual([]);
  });

  test("sliding a held touch upward cancels without uploading or accounting", async ({ page }) => {
    await installMicrophone(page);
    const asr = await transcriber(page);
    await login(page);
    const actions = observeActions(page);
    const pressed = await hold(page, { touch: true });
    await pressed.slideUp();
    await expect(dialog(page).getByText("松开取消", { exact: true })).toBeVisible();
    await pressed.release();
    await expect(dialog(page).getByRole("alert")).toContainText("本次录音未发送");
    await assertMicrophoneReleased(page);
    expect(asr.state.calls).toBe(0);
    expect(actions).toEqual([]);
    expect((await ledgerSnapshot()).requests).toHaveLength(0);
  });

  test("a late permission grant after release cannot start recording or submit", async ({ page }) => {
    await installMicrophone(page, { deferred: true });
    const asr = await transcriber(page);
    await login(page);
    const actions = observeActions(page);
    const pressed = await hold(page, { permission: true });
    await expect.poll(() => page.evaluate(() => (window as VoiceWindow).voiceFixture.tracks.length)).toBe(1);
    await pressed.release();
    await expect(dialog(page).getByRole("alert")).toContainText("录音尚未开始");
    await page.evaluate(() => (window as VoiceWindow).voiceFixture.grant());
    await assertMicrophoneReleased(page);
    await expect(dialog(page).getByText("正在录音", { exact: true })).toHaveCount(0);
    expect(asr.state.calls).toBe(0);
    expect(actions).toEqual([]);
    expect((await ledgerSnapshot()).transactions).toHaveLength(0);
  });

  for (const interruption of ["background", "navigation"] as const) {
    test(`continues transcription after ${interruption} and only notifies in the foreground`, async ({ page }) => {
      await installMicrophone(page, { lateResponse: true });
      const asr = await transcriber(page, mixedTransactions, true);
      await login(page);
      await entryLink(page).click();
      await expect(page).toHaveURL(/\/add$/);
      const actions = observeActions(page);
      const pressed = await hold(page);
      await pressed.release();
      await expect(dialog(page)).toHaveCount(0);
      await expect.poll(() => asr.state.calls).toBe(1);
      expect(actions).toEqual([]);
      expect(await pendingEntries(page)).toEqual([]);
      if (interruption === "background") await page.evaluate(() => {
        Object.defineProperty(document, "hidden", { configurable: true, value: true });
        document.dispatchEvent(new Event("visibilitychange"));
        window.dispatchEvent(new Event("blur"));
      });
      else { await page.goBack(); await expect(page).toHaveURL(/\/home$/); }
      await expect(dialog(page)).toHaveCount(0);
      await asr.finish();
      await expect.poll(() => page.evaluate(() => (window as VoiceWindow).voiceFixture.delivered)).toBe(1);
      await expect.poll(async () => (await ledgerSnapshot()).transactions.length).toBe(2);
      if (interruption === "background") {
        await expect(page.getByTestId("voice-success-notice")).toHaveCount(0);
        await page.evaluate(() => {
          Reflect.deleteProperty(document, "hidden");
          document.dispatchEvent(new Event("visibilitychange"));
        });
      }
      await expect(page.getByTestId("voice-success-notice")).toContainText(mixedSuccess);
      await assertMicrophoneReleased(page);
      expect(actions).toHaveLength(1);
      expect(await pendingEntries(page)).toEqual([]);
      expect((await ledgerSnapshot()).requests).toHaveLength(1);
    });
  }

  test("refuses voice accounting when UUID storage fails and keeps the transcript for correction", async ({ page }) => {
    await installMicrophone(page);
    await transcriber(page);
    await login(page);
    await page.evaluate((prefix) => {
      const setItem = Storage.prototype.setItem;
      Storage.prototype.setItem = function (key, value) {
        if (key.startsWith(prefix)) throw new DOMException("Storage disabled for fixture", "SecurityError");
        setItem.call(this, key, value);
      };
    }, pendingKeyPrefix);
    const actions = observeActions(page);
    const pressed = await hold(page);
    await pressed.release();
    await page.getByRole("button", { name: "1 次语音记账需处理", exact: true }).click();
    await expect(dialog(page).getByRole("alert")).toContainText("未发起记账");
    await expect(dialog(page).getByRole("textbox", { name: "修改识别文字", exact: true })).toHaveValue(mixedTransactions);
    await assertMicrophoneReleased(page);
    expect(actions).toEqual([]);
    expect((await ledgerSnapshot()).requests).toHaveLength(0);
    expect(await pendingEntries(page)).toEqual([]);
  });

  test("releases text entry after recording and preserves both existing drafts after voice success", async ({ page }) => {
    await installMicrophone(page);
    const asr = await transcriber(page, mixedTransactions, true);
    await login(page);
    await entryLink(page).click();
    await page.getByLabel("金额", { exact: true }).fill("23.45");
    await page.getByRole("button", { name: "添加备注", exact: true }).click();
    await page.getByLabel("备注", { exact: true }).fill("Synthetic manual draft");
    await page.getByRole("button", { name: "自然语言", exact: true }).click();
    const draft = page.getByRole("textbox", { name: "收支描述", exact: true });
    await draft.fill("午饭99元");
    const naturalForm = page.locator("form").filter({ has: draft });
    const actions = observeActions(page);
    const pressed = await hold(page);
    await expect(naturalForm.getByRole("button")).toBeDisabled();
    await pressed.release();
    await expect(dialog(page)).toHaveCount(0);
    await expect.poll(() => asr.state.calls).toBe(1);
    await expect(naturalForm.getByRole("button")).toBeEnabled();
    expect(actions).toEqual([]);
    await asr.finish();
    await expect(page.getByTestId("voice-success-notice")).toContainText(mixedSuccess);
    await expect(draft).toHaveValue("午饭99元");
    await expect(naturalForm.getByRole("button", { name: "导入", exact: true })).toBeEnabled();
    await page.getByRole("button", { name: "手工填写", exact: true }).click();
    await expect(page.getByLabel("金额", { exact: true })).toHaveValue("23.45");
    await expect(page.getByLabel("备注", { exact: true })).toHaveValue("Synthetic manual draft");
    expect(actions).toHaveLength(1);
    expect((await ledgerSnapshot()).transactions).toHaveLength(2);
  });

  test("supports keyboard recording and English correction without partial accounting", async ({ page }) => {
    await page.setViewportSize({ width: 1280, height: 900 });
    await installMicrophone(page);
    await transcriber(page, "Lunch 35 CNY, taxi amount forgotten");
    await login(page);
    await page.getByRole("button", { name: "切换语言", exact: true }).filter({ visible: true }).click();
    const link = entryLink(page, true);
    await expect(link).toHaveAttribute("aria-keyshortcuts", "Space");
    await link.focus();
    await page.keyboard.press("Space");
    const overlay = dialog(page, true);
    await expect(overlay).toBeFocused();
    await expect(overlay.getByText("Recording", { exact: true })).toBeVisible();
    await expect(overlay.getByText(/^[1-9]\d* \/ 60 s$/)).toBeVisible();
    await page.keyboard.press("Tab");
    await expect(overlay.getByRole("button", { name: "Close", exact: true })).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(overlay.getByRole("button", { name: "Stop and record transactions", exact: true })).toBeFocused();
    await page.keyboard.press("Enter");
    await expect(overlay).toHaveCount(0);
    await page.getByRole("button", { name: "1 voice entry needs attention", exact: true }).click();
    await expect(overlay.getByRole("alert")).toContainText("Add the amount");
    expect((await ledgerSnapshot()).transactions).toHaveLength(0);
    const transcript = overlay.getByRole("textbox", { name: "Edit transcript", exact: true });
    await expect(transcript).toHaveValue("Lunch 35 CNY, taxi amount forgotten");
    await transcript.fill("Lunch 35 CNY, taxi 22 CNY");
    await overlay.getByRole("button", { name: "Submit edited text", exact: true }).click();
    await expect(page.getByTestId("voice-success-notice")).toContainText("2 transactions recorded, expenses ¥57.00");
    const saved = await ledgerSnapshot();
    expect(saved.transactions).toHaveLength(2);
    expect(saved.requests).toHaveLength(2);
    expect(new Set(saved.requests.map(({ clientRequestId }) => clientRequestId)).size).toBe(2);
    await expect(overlay).toHaveCount(0);
    await expect(link).toBeFocused();
    await assertMicrophoneReleased(page);
  });

  for (const outcome of ["success", "correction"] as const) {
    test(`keeps a voice ${outcome} result non-modal after accounting completes`, async ({ page }) => {
      await installMicrophone(page);
      const transcript = outcome === "success" ? mixedTransactions : "午饭35元，打车忘了多少钱";
      await transcriber(page, transcript);
      await login(page);
      const response = await pauseFirstActionResponse(page);
      try {
        const pressed = await hold(page);
        await pressed.release();
        await expect(dialog(page)).toHaveCount(0);
        await expect.poll(() => response.state.received).toBe(true);
        await expect(page.getByRole("button", { name: "查看待确认记账", exact: true })).toHaveCount(0);
        response.release();
        if (outcome === "success") {
          await expect(page.getByTestId("voice-success-notice")).toContainText(mixedSuccess);
          await expect(dialog(page)).toHaveCount(0);
          await expect(page.getByTestId("voice-success-notice")).toHaveCount(0, { timeout: 7000 });
        } else {
          await page.getByRole("button", { name: "1 次语音记账需处理", exact: true }).click();
          await expect(dialog(page).getByRole("alert")).toContainText("请补充金额");
          await expect(dialog(page).getByRole("textbox", { name: "修改识别文字", exact: true })).toHaveValue(transcript);
        }
        const saved = await ledgerSnapshot();
        expect(saved.transactions).toHaveLength(outcome === "success" ? 2 : 0);
        expect(saved.requests).toHaveLength(1);
        expect(await pendingEntries(page)).toEqual([]);
        await assertMicrophoneReleased(page);
      } finally {
        response.release();
      }
    });
  }

  test("keeps a text request visible globally when navigating away while its response is pending", async ({ page }) => {
    await installMicrophone(page);
    const asr = await transcriber(page);
    await login(page);
    await entryLink(page).click();
    await expect(page).toHaveURL(/\/add$/);
    await page.getByRole("button", { name: "自然语言", exact: true }).click();
    await page.getByRole("textbox", { name: "收支描述", exact: true }).fill(mixedTransactions);
    const response = await pauseFirstActionResponse(page);
    try {
      await page.getByRole("button", { name: "导入", exact: true }).click();
      await expect.poll(() => response.state.received).toBe(true);
      await page.getByRole("link", { name: "首页", exact: true }).click();
      await expect(page).toHaveURL(/\/home$/);
      await page.getByRole("button", { name: "查看待确认记账", exact: true }).click();
      await expect(dialog(page).getByText("正在记账…", { exact: true })).toBeVisible();
      response.release();
      await expect(dialog(page).getByText(mixedSuccess, { exact: true })).toBeVisible();
      await expect(page).toHaveURL(/\/home$/);
      expect(asr.state.calls).toBe(0);
      expect(await page.evaluate(() => (window as VoiceWindow).voiceFixture.calls)).toBe(0);
      const saved = await ledgerSnapshot();
      expect(saved.transactions).toHaveLength(2);
      expect(saved.requests).toHaveLength(1);
      expect(await pendingEntries(page)).toEqual([]);
    } finally {
      response.release();
    }
  });

  test("keeps pending text and voice controls separate and usable on the same page", async ({ page }, testInfo) => {
    await installMicrophone(page);
    const asr = await transcriber(page, mixedTransactions, true);
    await login(page);
    const pressed = await hold(page);
    await pressed.release();
    await expect.poll(() => asr.state.calls).toBe(1);
    await entryLink(page).click();
    await page.getByRole("button", { name: "自然语言", exact: true }).click();
    await page.getByRole("textbox", { name: "收支描述", exact: true }).fill("午饭99元");
    const response = await pauseFirstActionResponse(page);
    try {
      await page.getByRole("button", { name: "导入", exact: true }).click();
      await expect.poll(() => response.state.received).toBe(true);
      await page.getByRole("link", { name: "首页", exact: true }).click();
      await expect(page).toHaveURL(/\/home$/);
      const voice = page.getByTestId("voice-task-status").getByRole("button", { name: "查看状态", exact: true });
      const text = page.getByRole("button", { name: "查看待确认记账", exact: true });
      await expect(voice).toBeVisible();
      await expect(text).toBeVisible();
      const voiceBox = await voice.boundingBox();
      const textBox = await text.boundingBox();
      expect(voiceBox).not.toBeNull();
      expect(textBox).not.toBeNull();
      expect(voiceBox!.x + voiceBox!.width <= textBox!.x || textBox!.x + textBox!.width <= voiceBox!.x
        || voiceBox!.y + voiceBox!.height <= textBox!.y || textBox!.y + textBox!.height <= voiceBox!.y).toBe(true);
      await page.screenshot({ path: testInfo.outputPath("voice-text-pending-mobile.png"), fullPage: true });
      await text.click();
      await expect(dialog(page).getByText("正在记账…", { exact: true })).toBeVisible();
      await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
      await voice.click();
      await expect(dialog(page).getByTestId("voice-task-list")).toContainText("正在识别语音…");
      await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
      response.release();
      await asr.finish();
      await expect(page.getByTestId("voice-success-notice")).toContainText(mixedSuccess);
      await expect.poll(async () => (await ledgerSnapshot()).transactions.length).toBe(3);
    } finally {
      response.release();
    }
  });

  test("restores only committed voice UUIDs after a lost response without duplicating transactions", async ({ page }) => {
    await installMicrophone(page);
    const asr = await transcriber(page);
    await login(page);
    let dropped = false;
    let recover = false;
    const actions = observeActions(page);
    await page.route("**/*", async (route) => {
      const request = route.request();
      const url = new URL(request.url());
      if (!dropped && request.method() === "POST" && url.pathname === "/api/voice/entry") {
        dropped = true;
        const response = await route.fetch();
        await response.body();
        await route.abort("failed");
      } else if (!recover && request.method() === "GET" && url.pathname === "/api/voice/entry") {
        await route.fulfill({ json: { status: "unknown", requestId: url.searchParams.get("requestId") } });
      } else await route.fallback();
    });
    const pressed = await hold(page);
    await pressed.release();
    await expect(page.getByTestId("voice-task-status")).toContainText("正在确认记账结果…");
    await expect(page.getByTestId("voice-task-status")).not.toContainText("本次未记账");
    await page.getByTestId("voice-task-status").getByRole("button", { name: "查看状态", exact: true }).click();
    await dialog(page).getByTestId("voice-task-list").getByRole("button", { name: "查看状态", exact: true }).click();
    await expect(dialog(page).getByTestId("voice-task-list")).toHaveCount(0);
    await expect(dialog(page)).toBeFocused();
    await page.keyboard.press("Tab");
    await expect(dialog(page).getByRole("button", { name: "关闭", exact: true })).toBeFocused();
    await page.keyboard.press("Shift+Tab");
    expect(await dialog(page).evaluate((element) => element.contains(document.activeElement))).toBe(true);
    await page.keyboard.press("Tab");
    await expect(dialog(page).getByRole("button", { name: "关闭", exact: true })).toBeFocused();
    await expect(dialog(page).getByText("记账结果尚未确认", { exact: true })).toBeVisible();
    const pending = await pendingEntries(page);
    const committed = await ledgerSnapshot();
    expect(pending).toHaveLength(1);
    expect(pending[0][0]).toBe(`${pendingKeyPrefix}${[committed.member.householdId, committed.member.id, committed.ledger.id].map(encodeURIComponent).join(":")}`);
    expect(JSON.parse(pending[0][1])).toEqual([committed.requests[0].clientRequestId]);
    expect(committed.transactions).toHaveLength(2);
    const stored = await page.evaluate(() => JSON.stringify({ session: { ...sessionStorage }, local: { ...localStorage } }));
    expect(stored).not.toContain(mixedTransactions);
    expect(stored).not.toContain("amountFen");
    await dialog(page).getByRole("button", { name: "关闭", exact: true }).click();
    await page.getByRole("button", { name: "1 次语音记账需处理", exact: true }).click();
    await expect(dialog(page).getByText("记账结果尚未确认", { exact: true })).toBeVisible();
    expect(asr.state.calls).toBe(1);
    expect(actions.filter(([input]) => typeof input === "object")).toHaveLength(1);
    recover = true;
    await page.reload();
    await expect(page).toHaveURL(/\/home$/);
    await expect(page.getByTestId("voice-success-notice")).toContainText(mixedSuccess);
    expect(await pendingEntries(page)).toEqual([]);
    const restored = await ledgerSnapshot();
    expect(restored.transactions).toEqual(committed.transactions);
    expect(restored.requests).toEqual(committed.requests);
    expect(asr.state.calls).toBe(1);
    expect(actions.filter(([input]) => typeof input === "object")).toHaveLength(1);
    const queries = actions.filter(([input]) => typeof input === "string");
    expect(queries.length).toBeGreaterThan(0);
    expect(queries.every(([id]) => id === committed.requests[0].clientRequestId)).toBe(true);
    await expect(dialog(page).getByRole("textbox")).toHaveCount(0);
  });

  test("returns to sign-in after voice session expiry and retains the UUID for confirmation", async ({ page }) => {
    await installMicrophone(page);
    const asr = await transcriber(page);
    await login(page);
    let requestId = "";
    await page.route("**/api/voice/entry", async (route) => {
      requestId = route.request().postDataJSON().requestId;
      // Keep the HTTP boundary deterministic; server tests cover actual revocation.
      await page.context().clearCookies();
      await route.fulfill({ status: 401, json: { error: "unauthorized" } });
    });
    const pressed = await hold(page);
    await pressed.release();
    await expect(page).toHaveURL(/\/login\?reason=session-expired$/);
    await expect(page.getByRole("button", { name: "登录", exact: true })).toBeVisible();
    const entries = await pendingEntries(page);
    expect(entries).toHaveLength(1);
    expect(JSON.parse(entries[0][1])).toEqual([requestId]);
    expect((await ledgerSnapshot()).transactions).toHaveLength(0);
    await page.unroute("**/api/voice/entry");
    const recovery: Array<{ method: string; requestId: string | null }> = [];
    page.on("request", (request) => {
      const url = new URL(request.url());
      if (url.pathname === "/api/voice/entry") recovery.push({ method: request.method(), requestId: url.searchParams.get("requestId") });
    });
    await login(page);
    await expect.poll(() => pendingEntries(page)).toEqual([]);
    expect(recovery.length).toBeGreaterThan(0);
    expect(recovery.every((request) => request.method === "GET" && request.requestId === requestId)).toBe(true);
    expect(asr.state.calls).toBe(1);
    expect((await ledgerSnapshot()).transactions).toHaveLength(0);
  });

  test("returns to sign-in after expiry and discards the old pending UUID when another member signs in", async ({ page }) => {
    await installMicrophone(page);
    const asr = await transcriber(page);
    await login(page);
    await page.route("**/api/voice/entry", async (route) => {
      await page.context().clearCookies();
      await route.fulfill({ status: 401, json: { error: "unauthorized" } });
    });
    const pressed = await hold(page);
    await pressed.release();
    await expect(page).toHaveURL(/\/login\?reason=session-expired$/);
    expect(await pendingEntries(page)).toHaveLength(1);
    await page.unroute("**/api/voice/entry");
    const recoveryRequests: string[] = [];
    page.on("request", (request) => {
      if (new URL(request.url()).pathname === "/api/voice/entry") recoveryRequests.push(request.url());
    });
    await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_B_EMAIL"));
    await page.getByLabel("密码").fill(requireEnv("SEED_USER_B_PASSWORD"));
    await page.getByRole("button", { name: "登录", exact: true }).click();
    await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
    await expect.poll(() => pendingEntries(page)).toEqual([]);
    await entryLink(page).click();
    await expect(page.getByRole("button", { name: "手工填写", exact: true })).toBeEnabled();
    expect(recoveryRequests).toEqual([]);
    expect(asr.state.calls).toBe(1);
    expect((await ledgerSnapshot()).transactions).toHaveLength(0);
  });

  test("queues text accounting until an unknown voice request has been confirmed", async ({ page }) => {
    await installMicrophone(page);
    await transcriber(page);
    await login(page);
    let recover = false;
    await page.route("**/api/voice/entry**", async (route) => {
      if (route.request().method() === "POST") {
        const response = await route.fetch();
        const result = await response.json();
        await route.fulfill({ json: { status: "unknown", requestId: result.requestId } });
      } else if (!recover) {
        await route.fulfill({ json: { status: "unknown", requestId: new URL(route.request().url()).searchParams.get("requestId") } });
      } else await route.continue();
    });
    const pressed = await hold(page);
    await pressed.release();
    await expect(page.getByRole("button", { name: "1 次语音记账需处理", exact: true })).toBeVisible();
    await entryLink(page).click();
    await page.getByRole("button", { name: "自然语言", exact: true }).click();
    await page.getByRole("textbox", { name: "收支描述", exact: true }).fill("午饭99元");
    const textRequests: unknown[] = [];
    await page.route("**/add**", async (route) => {
      if (route.request().method() === "POST" && route.request().headers()["next-action"]) textRequests.push(route.request().postDataJSON());
      await route.continue();
    });
    await page.getByRole("button", { name: "导入", exact: true }).click();
    await expect(page.getByRole("button", { name: "处理中…", exact: true })).toBeDisabled();
    // Advance one confirmation cycle: the next model call must still wait for its predecessor.
    await page.clock.install();
    await page.clock.runFor(1500);
    expect(textRequests).toHaveLength(0);
    expect((await ledgerSnapshot()).transactions).toHaveLength(2);
    recover = true;
    await page.clock.runFor(1500);
    await expect.poll(async () => (await ledgerSnapshot()).transactions.length).toBe(3);
    expect(textRequests).toHaveLength(1);
  });
});
