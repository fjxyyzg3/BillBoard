export type IosRelease = {
  schema: 1;
  version: string;
  build: string;
  bundleId: string;
  teamId: string;
  sourceCommit: string;
  runId: number;
  runNumber: number;
  attempt: number;
  sha256: string;
  size: number;
  validUntil: number;
};

export declare const MAX_IOS_IPA_BYTES: number;
export declare const MAX_IOS_METADATA_BYTES: number;
export declare const IOS_INSTALL_TTL_MS: number;
export declare const IOS_DOWNLOAD_TIMEOUT_MS: number;
export declare const IOS_REPOSITORY_ID: number;
export declare const IOS_WORKFLOW: string;
export declare function iosBuildNumber(runNumber: number, attempt: number): string;
export declare function isIosBuild(value: unknown): value is string;
export declare function compareIosBuilds(left: string, right: string): number;
export declare function parseIosRelease(value: unknown): IosRelease;
