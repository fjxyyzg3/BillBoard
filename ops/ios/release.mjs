import { createHash, randomUUID } from "node:crypto";
import { lstat, mkdir, readFile, readdir, rename, rm, writeFile } from "node:fs/promises";
import { join } from "node:path";
import {
  IOS_DOWNLOAD_TIMEOUT_MS, IOS_INSTALL_TTL_MS, IOS_REPOSITORY_ID, MAX_IOS_IPA_BYTES, MAX_IOS_METADATA_BYTES, parseIosRelease,
} from "../../src/lib/ios-release-manifest.mjs";

export const verificationSuites = ["lint", "unit", "integration", "e2e"];
export const MAX_ENCRYPTED_BYTES = MAX_IOS_IPA_BYTES + 256 * 1024;
const commitPattern = /^[0-9a-f]{40}$/;
const digest = (bytes) => createHash("sha256").update(bytes).digest("hex");

export async function boundedFile(file, max) {
  const info = await lstat(file);
  if (!info.isFile() || info.size < 1 || info.size > max) throw new Error("Unexpected iOS release file");
  const bytes = await readFile(file);
  if (bytes.length !== info.size) throw new Error("iOS release file changed");
  return bytes;
}

export async function atomicWrite(file, body) {
  const temporary = `${file}.${randomUUID()}.tmp`;
  try {
    await writeFile(temporary, body, { flag: "wx", mode: 0o600 });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

const json = (value) => JSON.stringify(value) + "\n";

export function verificationCoverage(reports, tree, retained = []) {
  if (!commitPattern.test(tree) || !Array.isArray(reports)) throw new Error("Invalid verification inputs");
  const coverage = {};
  for (const name of verificationSuites) {
    const runs = reports.flatMap((report, index) => {
      const time = Date.parse(report.startedAt);
      if (!Number.isFinite(time) || !Array.isArray(report.suites)) return [];
      const sameTree = report.sourceTree === tree;
      if (!sameTree && !retained.includes(`${name}=${report.sourceTree}`)) return [];
      return report.suites.filter(suite => suite.suite === name).map(suite => ({ time, index, sameTree, suite }));
    }).sort((a, b) => a.time - b.time);
    const full = runs.findLast(run => run.suite.scope === "full");
    if (!full || full.suite.signal || !Number.isInteger(full.suite.exitCode)) throw new Error(`Missing full ${name} coverage`);

    const reruns = new Set();
    if (full.suite.exitCode !== 0) {
      const damaged = full.suite.files?.filter(file => file.passed === false) ?? [];
      if (!damaged.length || !full.suite.files.every(file => typeof file.passed === "boolean" && file.tests > 0)) {
        throw new Error(`Unresolved full ${name} failure`);
      }
      for (const failed of damaged) {
        const result = runs.findLast(run => run.time > full.time && run.sameTree && !run.suite.signal
          && run.suite.exitCode === 0 && run.suite.files?.some(file => file.file === failed.file
            && file.passed === true && file.tests >= failed.tests));
        if (!result) throw new Error(`Unresolved ${name} file failure`);
        reruns.add(result.index);
      }
    }
    coverage[name] = { full: true, passed: true, baseline: full.index, reruns: [...reruns] };
  }
  return coverage;
}

export function requireVerification(receipt, sha, tree) {
  if (!commitPattern.test(sha) || !commitPattern.test(tree) || receipt?.schema !== 1
    || receipt.repositoryId !== IOS_REPOSITORY_ID || receipt.ref !== "refs/heads/master"
    || receipt.sha !== sha || receipt.tree !== tree
    || !verificationSuites.every(name => receipt.coverage?.[name]?.full === true && receipt.coverage[name].passed === true)) {
    throw new Error("Waiting for verification of the published iOS source");
  }
  return receipt;
}

export function encodeIosPayload(input, ipa) {
  const metadata = parseIosRelease(input);
  if (metadata.size !== ipa.length || metadata.sha256 !== digest(ipa)) throw new Error("iOS package digest does not match");
  const header = Buffer.from(json(metadata));
  const length = Buffer.alloc(4);
  length.writeUInt32BE(header.length);
  return Buffer.concat([length, header, ipa]);
}

export function decodeIosPayload(bytes) {
  if (bytes.length <= 4 || bytes.length > MAX_ENCRYPTED_BYTES) throw new Error("Invalid iOS release payload");
  const length = bytes.readUInt32BE();
  if (length < 1 || length > MAX_IOS_METADATA_BYTES || length + 4 >= bytes.length) throw new Error("Invalid iOS release metadata");
  const release = parseIosRelease(JSON.parse(bytes.subarray(4, 4 + length)));
  const ipa = bytes.subarray(4 + length);
  if (release.size !== ipa.length || release.sha256 !== digest(ipa)) throw new Error("iOS package digest does not match");
  return { release, ipa };
}

export async function currentIosRelease(directory) {
  try {
    return parseIosRelease(JSON.parse(await boundedFile(join(directory, "latest.json"), MAX_IOS_METADATA_BYTES)));
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    return null;
  }
}

function compareVersion(left, right) {
  const target = right.split(".").map(Number);
  return left.split(".").map(Number).map((part, i) => part - target[i]).find(Boolean) ?? 0;
}

async function immutableFile(path, body, maximum) {
  try {
    const old = await boundedFile(path, maximum);
    if (!old.equals(body)) throw new Error("An immutable iOS release file already exists");
  } catch (error) {
    if (error.code !== "ENOENT") throw error;
    await atomicWrite(path, body);
  }
}

export async function publishIosRelease(directory, input, ipa) {
  const release = parseIosRelease(input);
  if (release.validUntil <= Date.now() || ipa.length !== release.size || digest(ipa) !== release.sha256) {
    throw new Error("iOS package failed publication checks");
  }
  await mkdir(directory, { recursive: true });
  const current = await currentIosRelease(directory);
  if (current) {
    if (release.bundleId !== current.bundleId || release.teamId !== current.teamId) throw new Error("iOS application identity changed");
    const order = release.runNumber - current.runNumber || release.attempt - current.attempt;
    if (order < 0 || compareVersion(release.version, current.version) < 0) return "older";
    if (order === 0) {
      if (json(release) === json(current)) return "current";
      throw new Error("An iOS build cannot be replaced");
    }
  }

  await immutableFile(join(directory, release.sha256 + ".ipa"), ipa, MAX_IOS_IPA_BYTES);
  await immutableFile(join(directory, release.sha256 + ".json"), Buffer.from(json(release)), MAX_IOS_METADATA_BYTES);
  if (current) {
    // A credential issued before the switch can open the old file until expiry.
    const deleteAfter = Date.now() + IOS_INSTALL_TTL_MS + IOS_DOWNLOAD_TIMEOUT_MS + 60_000;
    await atomicWrite(join(directory, `retired-${current.sha256}.json`), json({ deleteAfter }));
  }
  await atomicWrite(join(directory, "latest.json"), json(release));
  return "published";
}

export async function collectRetiredIosReleases(directory) {
  const current = await currentIosRelease(directory);
  if (!current) return;
  for (const name of await readdir(directory)) {
    const sha = /^retired-([a-f0-9]{64})\.json$/.exec(name)?.[1];
    if (!sha || sha === current.sha256) continue;
    try {
      const retirement = JSON.parse(await boundedFile(join(directory, name), 1024));
      if (!Number.isSafeInteger(retirement.deleteAfter) || retirement.deleteAfter > Date.now()) continue;
      await rm(join(directory, sha + ".ipa"), { force: true });
      await rm(join(directory, sha + ".json"), { force: true });
      await rm(join(directory, name), { force: true });
    } catch { /* The next poll can retry after file handles have closed. */ }
  }
}
