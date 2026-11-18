import { clearTransactions } from "./db-cleanup";
import { expect, test, type Page } from "./fixtures";
import { fulfillVoiceTranscription } from "./voice-admission-fixture";

const pendingKeyPrefix = "billboard:voice-pending:v2:";
const mixedTransactions = "工资转账到账8000元，午饭花了35元";
const mixedSuccess = "已记 2 笔，收入 ¥8,000.00，支出 ¥35.00";

type VoiceLimitWindow = typeof window & {
  voiceLimitFixture: { tracks: MediaStreamTrack[]; context: AudioContext | null };
};

function requireEnv(name: string) {
  const value = process.env[name];
  if (!value) throw new Error(`Missing required env var: ${name}`);
  return value;
}

async function installMicrophone(page: Page) {
  await page.addInitScript(() => {
    const fixture = { tracks: [] as MediaStreamTrack[], context: null as AudioContext | null };
    (window as VoiceLimitWindow).voiceLimitFixture = fixture;
    Object.defineProperty(navigator.mediaDevices, "getUserMedia", { configurable: true, value: async () => {
      // Only the microphone boundary is synthetic. Native rendering feeds the production worklet.
      const context = new AudioContext();
      fixture.context = context;
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
      return destination.stream;
    } });
  });
}

async function login(page: Page) {
  await page.goto("/login");
  await page.getByLabel("邮箱").fill(requireEnv("SEED_USER_A_EMAIL"));
  await page.getByLabel("密码").fill(requireEnv("SEED_USER_A_PASSWORD"));
  await page.getByRole("button", { name: "登录", exact: true }).click();
  await expect(page).toHaveURL(/\/home$/, { timeout: 15_000 });
}

function dialog(page: Page) {
  return page.getByRole("dialog", { name: "语音记账", exact: true });
}

async function pendingEntries(page: Page) {
  return page.evaluate((prefix) => Object.entries(sessionStorage).filter(([key]) => key.startsWith(prefix)), pendingKeyPrefix);
}

test.describe("voice recording time limit", () => {
  test.beforeEach(async ({ page }) => {
    await clearTransactions();
    await page.setViewportSize({ width: 390, height: 844 });
  });

  for (const outcome of ["submit", "cancel"] as const) {
    test(`stops capture at 60 seconds while held and waits for release to ${outcome}`, async ({ page }) => {
      await installMicrophone(page);
      const uploads: Buffer[] = [];
      await page.route("**/api/voice/transcribe", async (route) => {
        const body = route.request().postDataBuffer();
        if (!body) throw new Error("Voice upload has no body");
        uploads.push(body);
        await fulfillVoiceTranscription(route, mixedTransactions);
      });
      await page.clock.install();
      await login(page);
      const actions: unknown[][] = [];
      page.on("request", (request) => {
        if (request.method() === "POST" && request.headers()["next-action"]) actions.push(request.postDataJSON() as unknown[]);
        else if (request.method() === "POST" && new URL(request.url()).pathname === "/api/voice/entry") actions.push([request.postDataJSON()]);
      });
      const link = page.getByRole("link", { name: "记一笔", exact: true }).filter({ visible: true });
      const box = await link.boundingBox();
      if (!box) throw new Error("Voice navigation is not visible");
      const position = { x: box.x + box.width / 2, y: box.y + box.height / 2 };
      const touch = await page.context().newCDPSession(page);
      try {
        await touch.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [{ ...position, id: 1 }] });
        await expect(dialog(page).getByText("正在录音", { exact: true })).toBeVisible();
        const audioStartedAt = await page.evaluate(() => (window as VoiceLimitWindow).voiceLimitFixture.context!.currentTime);
        // AudioContext time remains native: capture more than one real second before advancing UI timers.
        await expect.poll(() => page.evaluate(() => (window as VoiceLimitWindow).voiceLimitFixture.context!.currentTime))
          .toBeGreaterThan(audioStartedAt + 1.1);
        await expect.poll(() => page.evaluate(() => (window as VoiceLimitWindow).voiceLimitFixture.tracks.filter((track) => track.readyState === "live").length))
          .toBe(1);

        await page.clock.fastForward(60_000);
        await expect(dialog(page).getByText("已录满 60 秒，松开发送", { exact: true })).toBeVisible();
        await expect(dialog(page).getByText("60 / 60 s", { exact: true })).toBeVisible();
        await expect.poll(() => page.evaluate(() => (window as VoiceLimitWindow).voiceLimitFixture.tracks.filter((track) => track.readyState === "live").length))
          .toBe(0);
        await expect.poll(() => page.evaluate(() => (window as VoiceLimitWindow).voiceLimitFixture.context!.state)).toBe("closed");
        await page.clock.fastForward(1000);
        expect(uploads).toHaveLength(0);
        expect(actions).toHaveLength(0);
        expect(await pendingEntries(page)).toEqual([]);
        await expect(page).toHaveURL(/\/home$/);

        if (outcome === "cancel") {
          await touch.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [{ x: position.x, y: position.y - 100, id: 1 }] });
          await expect(dialog(page).getByText("松开取消", { exact: true })).toBeVisible();
        }
        await touch.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] });
        if (outcome === "submit") {
          await expect(page.getByTestId("voice-success-notice")).toContainText(mixedSuccess);
          await expect(dialog(page)).toHaveCount(0);
          expect(uploads).toHaveLength(1);
          expect(actions).toHaveLength(1);
          const audio = uploads[0];
          expect(audio.toString("ascii", 0, 4)).toBe("RIFF");
          expect(audio.toString("ascii", 8, 12)).toBe("WAVE");
          expect(audio.readUInt16LE(22)).toBe(1);
          expect(audio.readUInt32LE(24)).toBe(16000);
          expect(audio.readUInt16LE(34)).toBe(16);
          expect(audio.length).toBeGreaterThan(44 + 16000 * 2);
          expect(audio.length).toBeLessThanOrEqual(44 + 60 * 16000 * 2);
          expect(audio.subarray(44).some((value) => value !== 0)).toBe(true);
        } else {
          await expect(dialog(page).getByRole("alert")).toContainText("本次录音未发送");
          await page.clock.fastForward(1000);
          expect(uploads).toHaveLength(0);
          expect(actions).toHaveLength(0);
        }
        expect(await pendingEntries(page)).toEqual([]);
        await expect(page).toHaveURL(/\/home$/);
      } finally {
        await touch.detach();
      }
    });
  }
});
