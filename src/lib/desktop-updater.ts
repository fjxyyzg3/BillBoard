import type { Locale } from "@/lib/i18n";

export type DesktopRelease = {
  schema: 1; productId: "com.billboard.desktop"; platform: "win32"; arch: "x64";
  version: string; size: number; sha256: string; notes: Record<Locale, string>;
};
export type DesktopUpdaterState = {
  status: "idle" | "checking" | "available" | "downloading" | "ready" | "installing" | "error";
  installedVersion: string; release: DesktopRelease | null; progress: number;
  error: "offline" | "auth" | "unavailable" | "invalid" | "download" | "install" | "cancelled" | "busy" | null;
};
export type DesktopSafety = { ready: boolean; busy: boolean; dirty: boolean; identity: string; locale: Locale };
export type DesktopMessage = DesktopUpdaterState | { type: "prepare"; requestId: string } | { type: "release" };
export type DesktopBridge = { postMessage: (message: string) => void; subscribe: (listener: (event: { data: string }) => void) => () => void };

declare global { interface Window { BillBoardDesktop?: DesktopBridge } }

const statuses = ["idle", "checking", "available", "downloading", "ready", "installing", "error"];
const errors = ["offline", "auth", "unavailable", "invalid", "download", "install", "cancelled", "busy"];
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;

function record(value: unknown): value is Record<string, unknown> {
  return Boolean(value && typeof value === "object" && !Array.isArray(value));
}

function exact(value: Record<string, unknown>, keys: string[]) {
  return Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}

function version(value: unknown): value is string {
  return typeof value === "string" && value.length <= 40 && versionPattern.test(value);
}

function newer(candidate: string, installed: string) {
  const left = candidate.split(".").map(BigInt);
  const right = installed.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (left[index] !== right[index]) return left[index] > right[index];
  }
  return false;
}

function release(value: unknown): value is DesktopRelease {
  if (!record(value) || !exact(value, ["schema", "productId", "platform", "arch", "version", "size", "sha256", "notes"])) return false;
  if (value.schema !== 1 || value.productId !== "com.billboard.desktop" || value.platform !== "win32" || value.arch !== "x64"
    || !version(value.version) || typeof value.size !== "number" || !Number.isSafeInteger(value.size)
    || value.size < 1 || value.size > 256 * 1024 * 1024 || typeof value.sha256 !== "string" || !/^[a-f0-9]{64}$/.test(value.sha256)) return false;
  const notes = value.notes;
  return record(notes) && exact(notes, ["zh-CN", "en-US"]) && [notes["zh-CN"], notes["en-US"]].every((text) =>
    typeof text === "string" && text.length <= 4000 && Boolean(text.trim()) && !/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(text));
}

export function parseDesktopMessage(raw: string): DesktopMessage | null {
  if (typeof raw !== "string" || raw.length > 32768) return null;
  try {
    const value: unknown = JSON.parse(raw);
    if (!record(value)) return null;
    if (value.type === "release" && exact(value, ["type"])) return { type: "release" };
    if (value.type === "prepare" && exact(value, ["type", "requestId"]) && typeof value.requestId === "string"
      && /^[a-zA-Z0-9_-]{1,128}$/.test(value.requestId)) return { type: "prepare", requestId: value.requestId };
    if (!exact(value, ["status", "installedVersion", "release", "progress", "error"]) || typeof value.status !== "string"
      || !statuses.includes(value.status) || !version(value.installedVersion) || typeof value.progress !== "number"
      || !Number.isInteger(value.progress) || value.progress < 0 || value.progress > 100
      || (value.error !== null && (typeof value.error !== "string" || !errors.includes(value.error)))
      || (value.release !== null && !release(value.release))) return null;
    return value as DesktopUpdaterState;
  } catch { return null; }
}

export function hasDesktopUpdate(state: DesktopUpdaterState | null): boolean {
  return Boolean(state?.release && newer(state.release.version, state.installedVersion));
}

function safe(safety: DesktopSafety, foreground: boolean) {
  return foreground && safety.ready && !safety.busy && !safety.dirty && safety.identity.length > 0;
}

export function canInstallDesktopUpdate(state: DesktopUpdaterState | null, safety: DesktopSafety, foreground: boolean): boolean {
  return Boolean(state?.status === "ready" && hasDesktopUpdate(state) && safe(safety, foreground));
}

/** Installation intent belongs to one visible page and one identity. */
export class DesktopInstallGuard {
  private intent: string | null = null;
  private preparing = false;
  get frozen() { return this.preparing; }
  request(state: DesktopUpdaterState | null, safety: DesktopSafety, foreground: boolean, saved: boolean) {
    this.release();
    if (!saved || !canInstallDesktopUpdate(state, safety, foreground)) return false;
    this.intent = safety.identity;
    return true;
  }
  prepare(safety: DesktopSafety, foreground: boolean) {
    if (!this.intent || this.intent !== safety.identity || !safe(safety, foreground)) {
      this.release();
      return false;
    }
    this.preparing = true;
    return true;
  }
  blur() { return !this.preparing && this.invalidate(); }
  invalidate() {
    const requested = this.intent !== null;
    this.release();
    return requested;
  }
  release() { this.intent = null; this.preparing = false; }
}

let operationCount = 0;
let installFrozen = false;
export const DESKTOP_ACTIVITY_EVENT = "billboard:desktop-activity";

export function setDesktopInstallFrozen(frozen: boolean) { installFrozen = frozen; }
export function desktopOperationBusy() { return operationCount > 0; }

/** Claim the busy state before the first await, so an installation cannot race React's render. */
export function beginDesktopOperation(): (() => void) | null {
  if (installFrozen) return null;
  if (typeof window === "undefined" || !window.BillBoardDesktop) return () => undefined;
  operationCount += 1;
  window.dispatchEvent(new Event(DESKTOP_ACTIVITY_EVENT));
  let ended = false;
  return () => {
    if (ended) return;
    ended = true;
    operationCount -= 1;
    window.dispatchEvent(new Event(DESKTOP_ACTIVITY_EVENT));
  };
}
