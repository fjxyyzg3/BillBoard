import type { KeyObject } from "node:crypto";

export type DesktopRelease = {
  schema: 1;
  productId: "com.billboard.desktop";
  platform: "win32";
  arch: "x64";
  version: string;
  size: number;
  sha256: string;
  notes: { "zh-CN": string; "en-US": string };
};

export type DesktopEnvelope = { payload: string; signature: string };
export type DesktopManifestKey = string | Buffer | KeyObject;

export declare const DESKTOP_PRODUCT_ID: "com.billboard.desktop";
export declare const MAX_DESKTOP_INSTALLER_BYTES: number;
export declare const MAX_DESKTOP_MANIFEST_BYTES: number;
export declare const DESKTOP_SHA256_PATTERN: RegExp;
export declare function parseDesktopRelease(value: unknown): DesktopRelease;
export declare function parseDesktopEnvelope(raw: unknown): DesktopEnvelope;
export declare function verifyDesktopManifest(raw: unknown, publicKey: DesktopManifestKey): DesktopRelease;
export declare function createDesktopManifest(release: unknown, privateKey: DesktopManifestKey): DesktopEnvelope;
export declare function compareDesktopVersions(a: string, b: string): -1 | 0 | 1;
