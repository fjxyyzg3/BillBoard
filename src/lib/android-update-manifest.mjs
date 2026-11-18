export const MAX_ANDROID_APK_BYTES = 100 * 1024 * 1024;
export const ANDROID_SHA256_PATTERN = /^[a-f0-9]{64}$/;

export function parseAndroidUpdateManifest(value) {
  if (!value || typeof value !== "object" || Array.isArray(value)
    || typeof value.versionName !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.versionName)
    || value.versionName.length > 40
    || !Number.isSafeInteger(value.versionCode) || value.versionCode < 1 || value.versionCode > 2_100_000_000
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_ANDROID_APK_BYTES
    || typeof value.sha256 !== "string" || !ANDROID_SHA256_PATTERN.test(value.sha256)
    || !Number.isInteger(value.minSdk) || value.minSdk < 1 || value.minSdk > 10_000
    || !value.notes || typeof value.notes !== "object"
    || ["zh-CN", "en-US"].some((locale) => typeof value.notes[locale] !== "string"
      || !value.notes[locale].trim() || value.notes[locale].length > 4000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.notes[locale]))) {
    throw new Error("Invalid Android update manifest");
  }
  return {
    versionName: value.versionName, versionCode: value.versionCode, size: value.size,
    sha256: value.sha256, minSdk: value.minSdk,
    notes: { "zh-CN": value.notes["zh-CN"].trim(), "en-US": value.notes["en-US"].trim() },
  };
}
