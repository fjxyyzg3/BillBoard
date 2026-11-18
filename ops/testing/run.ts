import { execFileSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { mkdirSync, renameSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { loadTestEnvironment } from "./environment";
import { runTimedCommand, type SuiteTiming } from "./timing";

const commands = {
  lint: ["node_modules/eslint/bin/eslint.js", ".", "--max-warnings=0"],
  unit: ["node_modules/vitest/vitest.mjs", "run", "--project", "unit"],
  integration: ["node_modules/vitest/vitest.mjs", "run", "--project", "integration"],
  e2e: ["node_modules/@playwright/test/cli.js", "test"],
};
type Suite = keyof typeof commands;

async function main() {
  const [mode, ...args] = process.argv.slice(2);
  if (!Object.hasOwn(commands, mode) && mode !== "full") throw new Error("Choose lint, unit, integration, e2e or full");
  if (mode === "full" && args.length) throw new Error("Full verification does not accept test filters or overrides");

  const start = performance.now();
  const startedAt = new Date().toISOString();
  const directory = join("tmp", "verification", `${Date.now()}-${randomUUID()}`);
  mkdirSync(directory, { recursive: true });
  const results: SuiteTiming[] = [];
  const run = async (suite: Suite) => {
    if (suite === "integration" || suite === "e2e") loadTestEnvironment(suite);
    const result = await runTimedCommand({
      suite, args: [...commands[suite], ...args], env: { ...process.env }, directory,
      scope: args.length ? "focused" : "full",
    });
    results.push(result);
    return result.exitCode === 0;
  };
  try {
    if (mode === "full") {
      if (await run("lint") && await run("unit")) {
        await Promise.all([run("integration"), run("e2e")]);
      }
    } else await run(mode as Suite);
  } finally {
    const passed = results.length === (mode === "full" ? 4 : 1) && results.every((result) => result.exitCode === 0);
    let sourceCommit: string | null = null;
    let sourceDirty: boolean | null = null;
    try {
      sourceCommit = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8", windowsHide: true }).trim();
      sourceDirty = Boolean(execFileSync("git", ["status", "--porcelain"], { encoding: "utf8", windowsHide: true }).trim());
    } catch { /* Git metadata is optional. */ }
    const report = {
      mode, scope: args.length ? "focused" : "full", passed, sourceCommit, sourceDirty, startedAt,
      finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start),
      suites: results, slowestFiles: results.flatMap((result) => result.files.map((file) => ({ suite: result.suite, ...file })))
        .sort((a, b) => b.durationMs - a.durationMs).slice(0, 10),
    };
    const json = `${JSON.stringify(report, null, 2)}\n`;
    writeFileSync(join(directory, "summary.json"), json);
    const latest = join(directory, "latest.json.tmp");
    writeFileSync(latest, json);
    renameSync(latest, join("tmp", "verification", "latest.json"));
    process.stdout.write(`[verification] Report: ${join(directory, "summary.json")}\n`);
    process.exitCode = passed ? 0 : 1;
  }
}

main().catch(() => {
  process.stderr.write("Verification could not start or finish; check test configuration and local test database preparation. Private environment details were suppressed.\n");
  process.exitCode = 1;
});
