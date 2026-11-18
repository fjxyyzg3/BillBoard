export type ApkRelease = {
  versionName: string;
  versionCode: number;
  size: number;
  sha256: string;
  minSdk: number;
  notes: { "zh-CN": string; "en-US": string };
};

export const updaterStatuses = ["idle", "checking", "available", "downloading", "ready", "permission", "installing", "error"] as const;
export const updaterErrors = ["offline", "auth", "unavailable", "invalid", "download", "install", "permission", "cancelled", "busy"] as const;
export type UpdaterState = {
  status: typeof updaterStatuses[number];
  installedVersion: string;
  installedVersionCode: number;
  release: ApkRelease | null;
  progress: number;
  error: typeof updaterErrors[number] | null;
};
export type UpdaterCommand = "status" | "check" | "download" | "install" | "cancel";
export type UpdaterBridge = { postMessage: (message: string) => void; onmessage: ((event: { data: string }) => void) | null };

declare global {
  interface Window { BillBoardUpdater?: UpdaterBridge }
}

export function parseUpdaterState(raw: string): UpdaterState | null {
  if (typeof raw !== "string" || raw.length > 32768) return null;
  try {
    const value = JSON.parse(raw);
    if (!value || !updaterStatuses.includes(value.status) || typeof value.installedVersion !== "string"
      || value.installedVersion.length > 80 || !positiveInteger(value.installedVersionCode, 2100000000)
      || !Number.isInteger(value.progress) || value.progress < 0 || value.progress > 100
      || (value.error !== null && !updaterErrors.includes(value.error))) return null;
    const release = value.release;
    if (release !== null && (!release || !/^\d+\.\d+\.\d+$/.test(release.versionName)
      || release.versionName.length > 40 || !positiveInteger(release.versionCode, 2100000000)
      || !positiveInteger(release.size, 100 * 1024 * 1024) || !/^[a-f0-9]{64}$/.test(release.sha256)
      || !positiveInteger(release.minSdk, 1000) || !release.notes
      || !["zh-CN", "en-US"].every((locale) => typeof release.notes[locale] === "string" && release.notes[locale].length <= 4000))) return null;
    return value as UpdaterState;
  } catch {
    return null;
  }
}

function positiveInteger(value: unknown, maximum: number): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value > 0 && value <= maximum;
}

export function hasApkUpdate(state: UpdaterState | null): boolean {
  return Boolean(state?.release && state.release.versionCode > state.installedVersionCode);
}
