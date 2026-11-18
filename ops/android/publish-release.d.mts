import type { AndroidUpdateManifest } from "../../src/lib/android-update-manifest.mjs";
export declare function parseApkBadging(output: string): {
  applicationId: string; versionCode: number; versionName: string; minSdk: number;
};
export declare function validateBuildProvenance(
  metadata: { sourceCommit?: unknown; sourceDirty?: unknown },
  state: { branch: string; dirty: boolean; commit: string; remoteCommit: string },
): void;
export declare function publishVerifiedApk(input: {
  source: string; directory: string; manifest: AndroidUpdateManifest;
}): AndroidUpdateManifest;
