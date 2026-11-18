import { describe, expect, it } from "vitest";
import { hasApkUpdate, parseUpdaterState } from "@/lib/android-updater";

const release = { versionName: "1.47.0", versionCode: 1047000, size: 5000000, sha256: "a".repeat(64), minSdk: 29,
  notes: { "zh-CN": "应用更新", "en-US": "App updates" } };
const state = { status: "available", installedVersion: "1.46.1", installedVersionCode: 1046001, release, progress: 0, error: null };

describe("Android updater state", () => {
  it("uses the installed APK code, retains the badge through download and failed installation", () => {
    for (const status of ["available", "downloading", "ready", "permission", "installing", "error"]) {
      const parsed = parseUpdaterState(JSON.stringify({ ...state, status, error: status === "error" ? "install" : null }));
      expect(parsed).not.toBeNull();
      expect(hasApkUpdate(parsed)).toBe(true);
    }
    expect(hasApkUpdate(parseUpdaterState(JSON.stringify({ ...state, installedVersionCode: release.versionCode })))).toBe(false);
    expect(hasApkUpdate(parseUpdaterState(JSON.stringify({ ...state, installedVersionCode: release.versionCode + 1 })))).toBe(false);
  });

  it("rejects malformed or unbounded native data", () => {
    for (const data of ["bad", "{}", JSON.stringify({ ...state, status: "success" }),
      JSON.stringify({ ...state, progress: -1 }), JSON.stringify({ ...state, progress: 101 }),
      JSON.stringify({ ...state, installedVersionCode: 1.5 }),
      JSON.stringify({ ...state, error: "unknown-code" }),
      JSON.stringify({ ...state, release: { ...release, sha256: "../../private" } }),
      JSON.stringify({ ...state, release: { ...release, notes: { "zh-CN": "only" } } }),
      JSON.stringify({ ...state, release: { ...release, size: 200 * 1024 * 1024 } })]) {
      expect(parseUpdaterState(data)).toBeNull();
    }
  });

  it("accepts an idle installed APK without a publication", () => {
    const parsed = parseUpdaterState(JSON.stringify({ ...state, status: "idle", release: null }));
    expect(parsed?.installedVersion).toBe("1.46.1");
    expect(hasApkUpdate(parsed)).toBe(false);
  });
});
