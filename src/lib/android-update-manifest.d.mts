export type AndroidUpdateManifest = {
  versionName: string;
  versionCode: number;
  size: number;
  sha256: string;
  minSdk: number;
  notes: { "zh-CN": string; "en-US": string };
};
export declare const MAX_ANDROID_APK_BYTES: number;
export declare const ANDROID_SHA256_PATTERN: RegExp;
export declare function parseAndroidUpdateManifest(value: unknown): AndroidUpdateManifest;
