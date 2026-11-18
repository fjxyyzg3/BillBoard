import { createHash } from "node:crypto";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";
import { iosBuildNumber } from "@/lib/ios-release-manifest.mjs";
import { publishIosRelease, requireVerification, verificationCoverage } from "../../ops/ios/release.mjs";

const tree = "b".repeat(40);
const sha = "a".repeat(40);
const suites = ["lint", "unit", "integration", "e2e"];
const time = new Date("2026-11-18T00:00:00Z").toISOString();

function report(treeId = tree) {
  return { sourceTree: treeId, startedAt: time, suites: suites.map(suite => ({
    suite, scope: "full", exitCode: 0, signal: null, files: [] as Array<{ file: string; passed: boolean; tests: number }>,
  })) };
}

function candidate(ipa: Buffer, runNumber: number) {
  return {
    schema: 1, version: "1.68.0", build: iosBuildNumber(runNumber, 1), bundleId: "com.example.billboard",
    teamId: "TESTTEAM01", sourceCommit: sha, runId: runNumber + 100, runNumber, attempt: 1,
    sha256: createHash("sha256").update(ipa).digest("hex"), size: ipa.length, validUntil: Date.now() + 86400_000,
  };
}

it("requires full coverage and a receipt for the attested commit and tree", () => {
  const coverage = verificationCoverage([report()], tree);
  const receipt = { schema: 1, repositoryId: 1462445518, ref: "refs/heads/master", sha, tree, coverage };
  expect(requireVerification(receipt, sha, tree)).toBeDefined();
  expect(() => requireVerification(undefined, sha, tree)).toThrow();
  expect(() => requireVerification({ ...receipt, sha: "c".repeat(40) }, sha, tree)).toThrow();
  expect(() => requireVerification({ ...receipt, tree: "c".repeat(40) }, sha, tree)).toThrow();
  expect(() => verificationCoverage([{ ...report(), suites: [{ ...report().suites[1], scope: "focused" }] }], tree)).toThrow();
  expect(() => verificationCoverage([report("c".repeat(40))], tree)).toThrow();
});

it("uses a successful focused rerun only when it covers the original failed file", () => {
  const baseline = report();
  baseline.suites[1] = { ...baseline.suites[1], exitCode: 1, files: [
    { file: "tests/unit/ios-release.test.ts", passed: false, tests: 3 },
  ] };
  const rerun = { ...report(), startedAt: "2026-11-18T01:00:00Z", suites: [{
    ...baseline.suites[1], scope: "focused", exitCode: 0,
    files: [{ file: "tests/unit/ios-release.test.ts", passed: true, tests: 3 }],
  }] };
  expect(() => verificationCoverage([baseline], tree)).toThrow();
  expect(verificationCoverage([baseline, rerun], tree).unit).toMatchObject({ full: true, passed: true, reruns: [1] });
  rerun.suites[0].files[0].tests = 1;
  expect(() => verificationCoverage([baseline, rerun], tree)).toThrow();
});

it("publishes a higher build atomically and keeps the previous immutable release", async () => {
  const directory = await mkdtemp(join(tmpdir(), "billboard-ios-publish-"));
  const prior = Buffer.from("signed fixture one");
  const newer = Buffer.from("signed fixture two");
  try {
    const first = candidate(prior, 1);
    const next = candidate(newer, 2);
    expect(await publishIosRelease(directory, first, prior)).toBe("published");
    expect(await publishIosRelease(directory, next, newer)).toBe("published");
    expect(await publishIosRelease(directory, next, newer)).toBe("current");
    expect(await publishIosRelease(directory, first, prior)).toBe("older");
    await expect(publishIosRelease(directory, candidate(prior, 2), prior)).rejects.toThrow();
    await expect(publishIosRelease(directory, candidate(prior, 3), newer)).rejects.toThrow();
    expect(JSON.parse(await readFile(join(directory, "latest.json"), "utf8"))).toEqual(next);
    expect(await readFile(join(directory, first.sha256 + ".ipa"))).toEqual(prior);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
