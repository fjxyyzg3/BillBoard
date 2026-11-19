export const MAX_IOS_IPA_BYTES = 64 * 1024 * 1024;
export const MAX_IOS_METADATA_BYTES = 8192;
export const IOS_INSTALL_TTL_MS = 10 * 60_000;
export const IOS_DOWNLOAD_TIMEOUT_MS = 10 * 60_000;
export const IOS_REPOSITORY_ID = 1462445518;
export const IOS_WORKFLOW = ".github/workflows/ios-release.yml";

export function iosBuildNumber(runNumber, attempt) {
  if (!Number.isSafeInteger(runNumber) || runNumber < 1 || runNumber > 999900
    || !Number.isSafeInteger(attempt) || attempt < 1 || attempt > 99) {
    throw new Error("Invalid iOS build sequence");
  }
  return [Math.floor((runNumber - 1) / 100) + 1, (runNumber - 1) % 100, attempt].join(".");
}

export function isIosBuild(value) {
  return typeof value === "string" && /^[1-9]\d{0,3}\.(?:0|[1-9]\d?)\.[1-9]\d?$/.test(value);
}

export function compareIosBuilds(left, right) {
  if (!isIosBuild(left) || !isIosBuild(right)) throw new Error("Invalid iOS build number");
  const [leftMajor, leftMinor, leftAttempt] = left.split(".").map(Number);
  const [rightMajor, rightMinor, rightAttempt] = right.split(".").map(Number);
  return leftMajor - rightMajor || leftMinor - rightMinor || leftAttempt - rightAttempt;
}

export function parseIosRelease(value) {
  const { schema, version, build, bundleId, teamId, sourceCommit, runId, runNumber, attempt, sha256, size, validUntil } = value ?? {};
  if (schema !== 1 || typeof version !== "string" || !/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(version)
    || typeof bundleId !== "string" || bundleId.length > 155 || !/^[A-Za-z0-9-]+(?:\.[A-Za-z0-9-]+)+$/.test(bundleId)
    || typeof teamId !== "string" || !/^[A-Z0-9]{10}$/.test(teamId)
    || typeof sourceCommit !== "string" || !/^[a-f0-9]{40}$/.test(sourceCommit)
    || typeof sha256 !== "string" || !/^[a-f0-9]{64}$/.test(sha256) || !Number.isSafeInteger(runId) || runId < 1
    || !Number.isSafeInteger(size) || size < 1 || size > MAX_IOS_IPA_BYTES
    || !Number.isSafeInteger(validUntil) || validUntil < 1
    || build !== iosBuildNumber(runNumber, attempt)) throw new Error("Invalid iOS release metadata");
  return { schema, version, build, bundleId, teamId, sourceCommit, runId, runNumber, attempt, sha256, size, validUntil };
}
