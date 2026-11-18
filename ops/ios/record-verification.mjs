import { execFileSync } from "node:child_process";
import { mkdir } from "node:fs/promises";
import { join } from "node:path";
import { IOS_REPOSITORY_ID } from "../../src/lib/ios-release-manifest.mjs";
import { atomicWrite, boundedFile, verificationCoverage, verificationSuites } from "./release.mjs";

const git = (...args) => execFileSync("git", args, {
  encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 30_000,
}).trim();
const revision = /^[a-f0-9]{40}$/;
const date = (value) => new Date(value).toISOString();

function reportSummary(report) {
  if (!revision.test(report.sourceTree) || !Array.isArray(report.suites)) throw new Error("Verification has no stable source tree");
  return {
    sourceTree: report.sourceTree,
    startedAt: date(report.startedAt),
    finishedAt: date(report.finishedAt),
    suites: report.suites.map((suite) => ({
      suite: verificationSuites.includes(suite.suite) ? suite.suite : "unknown",
      scope: suite.scope === "full" ? "full" : "focused",
      exitCode: Number.isInteger(suite.exitCode) ? suite.exitCode : 1,
      signal: suite.signal ? "interrupted" : null,
      files: (suite.files ?? []).filter(file => /^tests\/[a-z0-9_./-]+$/i.test(file.file))
        .map(file => ({ file: file.file, passed: typeof file.passed === "boolean" ? file.passed : undefined,
          tests: Number.isSafeInteger(file.tests) ? file.tests : undefined })),
    })),
  };
}

async function main() {
  const reportPaths = [];
  const retained = [];
  for (const arg of process.argv.slice(2)) {
    if (/^--retain=(lint|unit|integration|e2e)=[a-f0-9]{40}$/.test(arg)) retained.push(arg.slice("--retain=".length));
    else if (arg.startsWith("--")) throw new Error("Unsupported verification option");
    else reportPaths.push(arg);
  }
  if (!reportPaths.length || reportPaths.length > 24 || git("branch", "--show-current") !== "master" || git("status", "--porcelain")) {
    throw new Error("A clean production checkout and verification reports are required");
  }
  const sha = git("rev-parse", "HEAD");
  const tree = git("rev-parse", "HEAD^{tree}");
  const ref = "refs/heads/master";
  const remote = git("ls-remote", "--exit-code", "origin", ref).split(/\s+/, 2);
  if (remote[0] !== sha || remote[1] !== ref) throw new Error("The production checkout is not published");
  const reports = await Promise.all(reportPaths.map(async path => reportSummary(JSON.parse(await boundedFile(path, 8 * 1024 * 1024)))));
  const coverage = verificationCoverage(reports, tree, retained);
  const directory = join("tmp", "verification", "releases");
  await mkdir(directory, { recursive: true });
  const receipt = { schema: 1, repositoryId: IOS_REPOSITORY_ID, ref, sha, tree, coverage, retained, reports };
  await atomicWrite(join(directory, sha + ".json"), JSON.stringify(receipt) + "\n");
  process.stdout.write("Recorded verification for the published iOS source.\n");
}

main().catch(() => {
  process.stderr.write("Could not record iOS verification. Check the clean pushed master, verification reports, and coverage.\n");
  process.exitCode = 1;
});
