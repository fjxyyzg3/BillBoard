import type { KeyObject } from "node:crypto";
import type { DesktopEnvelope, DesktopRelease } from "../../src/lib/desktop-update-manifest.mjs";

export declare function validateDesktopBuildProvenance(metadata: { sourceCommit: string; sourceDirty: boolean }, state: {
  branch: string; commit: string; remoteCommit: string; dirty: boolean;
}): void;
export declare function inspectDesktopArtifact(path: string): { size: number; sha256: string };
export declare function publishVerifiedExe(options: {
  source: string; directory: string; release: DesktopRelease; privateKey: string | Buffer | KeyObject;
}): DesktopEnvelope;
