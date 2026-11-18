import { afterEach, describe, expect, it, vi } from "vitest";
import { DesktopInstallGuard, beginDesktopOperation, canInstallDesktopUpdate, desktopOperationBusy, hasDesktopUpdate, parseDesktopMessage, setDesktopInstallFrozen,
  type DesktopSafety, type DesktopUpdaterState } from "@/lib/desktop-updater";
import { NaturalLanguageController } from "@/lib/transactions/natural-language-controller";

const release = { schema: 1 as const, productId: "com.billboard.desktop" as const, platform: "win32" as const, arch: "x64" as const,
  version: "1.57.0", size: 120_000_000, sha256: "a".repeat(64), notes: { "zh-CN": "应用更新", "en-US": "App update" } };
const state: DesktopUpdaterState = { status: "ready", installedVersion: "1.56.1", release, progress: 100, error: null };
const safety: DesktopSafety = { ready: true, busy: false, dirty: false, identity: '["account","household","member"]', locale: "zh-CN" };

afterEach(() => { setDesktopInstallFrozen(false); vi.unstubAllGlobals(); });

describe("Windows update bridge", () => {
  it("shows updates using the actual installed desktop version through failures", () => {
    for (const status of ["available", "downloading", "ready", "installing", "error"] as const) {
      const parsed = parseDesktopMessage(JSON.stringify({ ...state, status, error: status === "error" ? "install" : null }));
      expect(parsed).not.toBeNull();
      expect(parsed && !("type" in parsed) && hasDesktopUpdate(parsed)).toBe(true);
    }
    expect(hasDesktopUpdate({ ...state, installedVersion: "1.57.0" })).toBe(false);
    expect(hasDesktopUpdate({ ...state, installedVersion: "1.58.0" })).toBe(false);
    expect(hasDesktopUpdate({ ...state, installedVersion: "1.9.0", release: { ...release, version: "1.10.0" } })).toBe(true);
    expect(hasDesktopUpdate(null)).toBe(false);
  });

  it("rejects unbounded or malformed native messages and wrong platform releases", () => {
    for (const value of ["broken", "{}", JSON.stringify({ ...state, progress: 101 }), JSON.stringify({ ...state, status: "permission" }),
      JSON.stringify({ ...state, installedVersion: "latest" }), JSON.stringify({ ...state, error: "unknown" }),
      JSON.stringify({ ...state, installedVersion: "01.57.0" }),
      JSON.stringify({ ...state, release: { ...release, arch: "arm64" } }), JSON.stringify({ ...state, release: { ...release, schema: 2 } }),
      JSON.stringify({ ...state, release: { ...release, productId: "other.app" } }), JSON.stringify({ ...state, release: { ...release, size: 256 * 1024 * 1024 + 1 } }),
      JSON.stringify({ ...state, release: { ...release, sha256: "../private" } }), JSON.stringify({ ...state, release: { ...release, notes: { "zh-CN": "only" } } }),
      JSON.stringify({ ...state, release: { ...release, notes: { ...release.notes, "en-US": "x".repeat(4001) } } }),
      JSON.stringify({ ...state, release: { ...release, notes: { ...release.notes, "en-US": "bad\u0001notes" } } }),
      JSON.stringify({ ...state, release: { ...release, downloadUrl: "https://example.invalid/update.exe" } }),
      JSON.stringify({ type: "prepare", requestId: "x".repeat(129) }), JSON.stringify({ type: "execute", path: "file.exe" })]) {
      expect(parseDesktopMessage(value)).toBeNull();
    }
    expect(parseDesktopMessage(JSON.stringify({ ...state, status: "idle", release: null }))).toMatchObject({ status: "idle", release: null });
    expect(parseDesktopMessage(JSON.stringify({ type: "prepare", requestId: "prepare-1" }))).toEqual({ type: "prepare", requestId: "prepare-1" });
    expect(parseDesktopMessage('{"type":"release"}')).toEqual({ type: "release" });
  });

  it("never considers download completion alone an installation authorization", () => {
    const guard = new DesktopInstallGuard();
    expect(guard.prepare(safety, true)).toBe(false);
    expect(guard.frozen).toBe(false);
    expect(guard.request(state, safety, true, false)).toBe(false);
    expect(guard.request({ ...state, status: "downloading" }, safety, true, true)).toBe(false);
    expect(guard.request(state, safety, true, true)).toBe(true);
    expect(guard.prepare(safety, true)).toBe(true);
    expect(guard.frozen).toBe(true);
  });

  it("fails closed for unknown state, critical work, drafts or background pages", () => {
    expect(canInstallDesktopUpdate(null, safety, true)).toBe(false);
    for (const patch of [{ ready: false }, { busy: true }, { dirty: true }, { identity: "" }]) {
      const guarded = { ...safety, ...patch };
      expect(canInstallDesktopUpdate(state, guarded, true)).toBe(false);
      expect(new DesktopInstallGuard().request(state, guarded, true, true)).toBe(false);
    }
    expect(canInstallDesktopUpdate(state, safety, false)).toBe(false);
    expect(canInstallDesktopUpdate(state, safety, true)).toBe(true);
  });

  it("invalidates an intent on navigation, identity change or newly busy work", () => {
    for (const patch of [{ identity: "different-member" }, { busy: true }, { dirty: true }, { ready: false }]) {
      const guard = new DesktopInstallGuard();
      expect(guard.request(state, safety, true, true)).toBe(true);
      expect(guard.prepare({ ...safety, ...patch }, true)).toBe(false);
      expect(guard.frozen).toBe(false);
      expect(guard.prepare(safety, true)).toBe(false);
    }
    const guard = new DesktopInstallGuard();
    guard.request(state, safety, true, true);
    expect(guard.invalidate()).toBe(true);
    expect(guard.prepare(safety, true)).toBe(false);
  });

  it("cancels ordinary blur but permits the native confirmation to blur during a frozen handshake", () => {
    const guard = new DesktopInstallGuard();
    guard.request(state, safety, true, true);
    expect(guard.blur()).toBe(true);
    expect(guard.prepare(safety, true)).toBe(false);
    guard.request(state, safety, true, true);
    expect(guard.prepare(safety, true)).toBe(true);
    expect(guard.blur()).toBe(false);
    expect(guard.prepare(safety, true)).toBe(true);
    guard.release();
    expect(guard.frozen).toBe(false);
    expect(guard.prepare(safety, true)).toBe(false);
  });

  it("claims work synchronously through its entire lifetime and prevents new work during the install freeze", () => {
    vi.stubGlobal("window", { BillBoardDesktop: { postMessage() {}, subscribe() { return () => undefined; } }, dispatchEvent: () => true });
    const first = beginDesktopOperation();
    const second = beginDesktopOperation();
    expect(desktopOperationBusy()).toBe(true);
    first?.();
    first?.();
    expect(desktopOperationBusy()).toBe(true);
    second?.();
    expect(desktopOperationBusy()).toBe(false);
    setDesktopInstallFrozen(true);
    expect(beginDesktopOperation()).toBeNull();
    expect(desktopOperationBusy()).toBe(false);
    setDesktopInstallFrozen(false);
    const resumed = beginDesktopOperation();
    expect(resumed).toBeTypeOf("function");
    resumed?.();
  });

  it("keeps unsubmitted text on other pages and ledgers visible to the installation guard", async () => {
    const daily = { householdId: "household", memberId: "member", ledgerId: "daily" };
    const travel = { ...daily, ledgerId: "travel" };
    const data = new Map<string, string>();
    const requestId = "00000000-0000-4000-8000-000000000001";
    const success = { status: "success" as const, requestId, resultVersion: 2 as const, count: 1, incomeCount: 0, expenseCount: 1,
      incomeAmountFen: 0, expenseAmountFen: 3500 };
    const controller = new NaturalLanguageController({ memberId: "member", context: daily, uuid: () => requestId,
      storage: () => ({ getItem: (key) => data.get(key) ?? null, setItem: (key, value) => { data.set(key, value); }, removeItem: (key) => { data.delete(key); } }),
      submit: async () => success, query: async () => success });
    await controller.initialize();
    expect(controller.hasUnsavedTextDrafts()).toBe(false);
    controller.setTextDraft("Lunch 35 CNY", daily);
    controller.setTarget(travel, "Travel");
    controller.setTextDraft("   ", travel);
    expect(controller.getTextDraft()).toBe("   ");
    expect(controller.hasUnsavedTextDrafts()).toBe(true);
    controller.setTarget(daily, "Daily");
    controller.submit(controller.textDraftSource(daily), "Lunch 35 CNY", "en-US");
    await vi.waitFor(() => expect(controller.getSnapshot().feedback?.result).toEqual(success));
    expect(controller.hasUnsavedTextDrafts()).toBe(false);
    controller.setTextDraft("Train 25 CNY", travel);
    controller.dispose();
    expect(controller.hasUnsavedTextDrafts()).toBe(false);
  });
});
