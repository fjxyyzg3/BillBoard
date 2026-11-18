import { execFileSync } from "node:child_process";
import { mkdir, mkdtemp, readdir, rm, stat } from "node:fs/promises";
import { join, resolve } from "node:path";
import { IOS_REPOSITORY_ID, IOS_WORKFLOW } from "../../src/lib/ios-release-manifest.mjs";
import {
  boundedFile, collectRetiredIosReleases, currentIosRelease, decodeIosPayload, MAX_ENCRYPTED_BYTES,
  publishIosRelease, requireVerification,
} from "./release.mjs";

const local = resolve("tmp", "releases", "ios");
const published = join(local, "published");
const argv = process.argv.slice(2);
const ref = "refs/heads/master";

function command(executable, args, timeout = 35_000) {
  return execFileSync(executable, args, {
    encoding: "utf8", windowsHide: true, timeout, maxBuffer: 4 * 1024 * 1024, stdio: ["ignore", "pipe", "pipe"],
    env: { ...process.env, GH_PROMPT_DISABLED: "1", GH_PAGER: "" },
  });
}

const github = (endpoint) => JSON.parse(command("gh", ["api", endpoint]));

function validRun(run) {
  return run.event === "workflow_dispatch" && run.head_branch === "master" && run.conclusion === "success"
    && run.repository?.id === IOS_REPOSITORY_ID && run.head_repository?.id === IOS_REPOSITORY_ID
    && run.path?.split("@")[0] === IOS_WORKFLOW && /^[a-f0-9]{40}$/.test(run.head_sha)
    && [run.id, run.run_number, run.run_attempt].every(value => Number.isSafeInteger(value) && value > 0);
}

function selectArtifact(repository) {
  const file = IOS_WORKFLOW.split("/").at(-1);
  const runs = github(`repos/${repository}/actions/workflows/${file}/runs?event=workflow_dispatch&branch=master&status=success&per_page=50`);
  for (const run of runs.workflow_runs.filter(validRun).sort((a, b) => b.run_number - a.run_number || b.run_attempt - a.run_attempt)) {
    const name = `ios-release-${run.id}-${run.run_attempt}`;
    const { artifacts } = github(`repos/${repository}/actions/runs/${run.id}/artifacts?name=${name}`);
    const artifact = artifacts.find(candidate => candidate.name === name && !candidate.expired);
    if (artifact) return { run, artifact };
  }
  return null;
}

function assertAttestation(file, repository, run) {
  const statements = JSON.parse(command("gh", [
    "attestation", "verify", file, "--repo", repository, "--signer-workflow", `${repository}/${IOS_WORKFLOW}`,
    "--source-ref", ref, "--source-digest", run.head_sha, "--deny-self-hosted-runners", "--format", "json",
  ], 60_000));
  const invocation = `https://github.com/${repository}/actions/runs/${run.id}/attempts/${run.run_attempt}`;
  if (!statements.some(({ verificationResult }) => {
    const predicate = verificationResult?.statement?.predicate;
    return predicate?.runDetails?.metadata?.invocationId === invocation
      && predicate?.buildDefinition?.internalParameters?.github?.event_name === "workflow_dispatch"
      && Number(predicate.buildDefinition.internalParameters.github.repository_id) === IOS_REPOSITORY_ID;
  })) throw new Error("GitHub attestation does not match the release run");
}

async function pull() {
  const [age, identity] = argv.map(path => resolve(path));
  if (!age || !identity || argv.length !== 2 || !(await stat(identity)).isFile()) throw new Error("iOS release tools are not configured");
  const repo = github(`repositories/${IOS_REPOSITORY_ID}`);
  if (repo.id !== IOS_REPOSITORY_ID || repo.default_branch !== "master" || !/^[\w.-]+\/[\w.-]+$/.test(repo.full_name)) {
    throw new Error("Unexpected iOS release repository");
  }
  await mkdir(published, { recursive: true });
  await collectRetiredIosReleases(published);
  for (const entry of await readdir(local, { withFileTypes: true })) {
    if (entry.isDirectory() && /^pull-[a-zA-Z0-9]{6}$/.test(entry.name)) {
      await rm(join(local, entry.name), { recursive: true, force: true });
    }
  }
  const repository = repo.full_name;
  const candidate = selectArtifact(repository);
  if (!candidate) return;
  const { run, artifact } = candidate;
  const current = await currentIosRelease(published);
  if (current && (current.runNumber > run.run_number
    || (current.runId === run.id && current.attempt >= run.run_attempt))) return;
  if (!Number.isSafeInteger(artifact.size_in_bytes) || artifact.size_in_bytes < 1 || artifact.size_in_bytes > MAX_ENCRYPTED_BYTES
    || artifact.workflow_run?.head_sha && artifact.workflow_run.head_sha !== run.head_sha) throw new Error("Invalid artifact metadata");
  const commit = github(`repos/${repository}/git/commits/${run.head_sha}`);
  if (commit.sha !== run.head_sha) throw new Error("Invalid release commit");
  const receipt = await boundedFile(join("tmp", "verification", "releases", run.head_sha + ".json"), 16 * 1024 * 1024);
  requireVerification(JSON.parse(receipt), run.head_sha, commit.tree?.sha);

  const staging = await mkdtemp(join(local, "pull-"));
  try {
    const encrypted = join(staging, "release.age");
    const plaintext = join(staging, "release.bin");
    command("gh", ["run", "download", String(run.id), "--repo", repository, "--name", artifact.name, "--dir", staging], 90_000);
    const files = await readdir(staging, { withFileTypes: true });
    if (files.length !== 1 || files[0].name !== "release.age" || !files[0].isFile()) throw new Error("Unexpected artifact contents");
    await boundedFile(encrypted, MAX_ENCRYPTED_BYTES);
    assertAttestation(encrypted, repository, run);
    command(age, ["--decrypt", "--identity", identity, "--output", plaintext, encrypted], 45_000);
    const { release, ipa } = decodeIosPayload(await boundedFile(plaintext, MAX_ENCRYPTED_BYTES));
    if (release.sourceCommit !== run.head_sha || release.runId !== run.id || release.runNumber !== run.run_number
      || release.attempt !== run.run_attempt) throw new Error("iOS metadata does not match the attested run");
    const installed = await publishIosRelease(published, release, ipa);
    if (installed === "published") process.stdout.write(`Published iOS build ${release.build} from ${release.sourceCommit}.\n`);
  } finally {
    await rm(staging, { recursive: true, force: true }).catch(() => {
      process.stderr.write("iOS workspace cleanup will be retried on the next poll.\n");
    });
  }
}

pull().catch(() => {
  process.stderr.write("iOS publication deferred. Check the GitHub run, verification receipt, or local tools. The current release was retained.\n");
  process.exitCode = 1;
});
