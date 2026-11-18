import { execFileSync, spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { loadDesktopSigningKey, redactDesktopOutput, validateDesktopOrigin } from "./build-config.mjs";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const desktopRoot = join(repoRoot, "desktop");
export const privateConfigPath = join(repoRoot, ".env.desktop.local");
export const releaseRoot = join(repoRoot, "tmp/releases/windows");

export function git(args) {
  return execFileSync("git", args, {
    cwd: repoRoot, encoding: "utf8", windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 30000,
  }).trim();
}

export function repositoryRoots() {
  return [...new Set([repoRoot, dirname(git(["rev-parse", "--path-format=absolute", "--git-common-dir"]))])];
}

export function desktopConfiguration() {
  const file = existsSync(privateConfigPath) ? parseEnv(readFileSync(privateConfigPath, "utf8")) : {};
  const keys = ["BILLBOARD_DESKTOP_ORIGIN", "BILLBOARD_DESKTOP_UPDATE_PRIVATE_KEY_FILE"];
  return Object.fromEntries(keys.map((key) => [key, process.env[key] ?? file[key] ?? ""]));
}

export function desktopEnvironment() {
  const config = desktopConfiguration();
  const origin = validateDesktopOrigin(config.BILLBOARD_DESKTOP_ORIGIN);
  const signing = loadDesktopSigningKey(config.BILLBOARD_DESKTOP_UPDATE_PRIVATE_KEY_FILE, { repositoryRoots: repositoryRoots() });
  return { config, origin, ...signing };
}

export function desktopGitState() {
  return {
    branch: git(["branch", "--show-current"]), commit: git(["rev-parse", "HEAD"]),
    remoteCommit: git(["ls-remote", "origin", "refs/heads/master"]).split(/\s+/)[0],
    dirty: Boolean(git(["status", "--porcelain"])),
  };
}

export function runDesktopTool(executable, args, { cwd = repoRoot, privateValues = [], showOutput = true, timeout = 600000, env = process.env } = {}) {
  const result = spawnSync(executable, args, {
    cwd, env, encoding: "utf8", windowsHide: true, maxBuffer: 16 * 1024 * 1024, timeout,
  });
  const output = redactDesktopOutput(`${result.stdout ?? ""}${result.stderr ?? ""}`, privateValues);
  if (showOutput && output) process.stdout.write(output);
  if (result.error || result.status !== 0) {
    if (!showOutput && output) process.stderr.write(output);
    throw new Error("Desktop tool failed; inspect the sanitized output and local toolchain");
  }
  return output;
}

export function isMainModule(url) {
  return Boolean(process.argv[1]) && resolve(fileURLToPath(url)) === resolve(process.argv[1]);
}

export function reportDesktopFailure(error, fallback) {
  const message = error instanceof Error ? error.message : "";
  const allowed = ["Desktop origin ", "Desktop version ", "Desktop signing ", "Desktop update signing ",
    "Desktop release ", "Desktop publication ", "Desktop tool failed", "Desktop validation ", "Usage:",
    "Existing Windows manifest", "Existing immutable Windows", "Windows installer ", "Desktop dependency "];
  process.stderr.write(`${allowed.some((prefix) => message.startsWith(prefix)) ? message : fallback}\n`);
  process.exitCode = 1;
}
