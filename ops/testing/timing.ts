import { spawn } from "node:child_process";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";

export type FileTiming = { file: string; durationMs: number };
export type SuiteTiming = {
  suite: string;
  scope: "full" | "focused";
  startedAt: string;
  finishedAt: string;
  durationMs: number;
  exitCode: number;
  signal: string | null;
  files: FileTiming[];
};

export function writeFileTimings(files: FileTiming[]) {
  const target = process.env.BILLBOARD_TEST_TIMING_FILE;
  if (!target) return;
  const safeFiles = files.map(({ file, durationMs }) => ({
    file: relative(process.cwd(), file).replaceAll("\\", "/"),
    durationMs: Math.round(durationMs),
  })).filter(({ file }) => file.startsWith("tests/"));
  writeFileSync(target, JSON.stringify(safeFiles));
}

export async function runTimedCommand(input: {
  suite: string;
  scope: SuiteTiming["scope"];
  args: string[];
  env: NodeJS.ProcessEnv;
  directory: string;
}): Promise<SuiteTiming> {
  const startedAt = new Date().toISOString();
  const start = performance.now();
  const file = join(input.directory, `${input.suite}-files.json`);
  const child = spawn(process.execPath, input.args, {
    env: { ...input.env, BILLBOARD_TEST_TIMING_FILE: file },
    stdio: "inherit",
    windowsHide: true,
  });
  let interrupted: string | null = null;
  const interrupt = (signal: NodeJS.Signals) => { interrupted = signal; child.kill(signal); };
  const onInterrupt = () => interrupt("SIGINT");
  const onTerminate = () => interrupt("SIGTERM");
  process.on("SIGINT", onInterrupt);
  process.on("SIGTERM", onTerminate);
  const outcome = await new Promise<{ exitCode: number; signal: string | null }>((resolve) => {
    child.once("error", () => resolve({ exitCode: 1, signal: null }));
    child.once("close", (code, signal) => resolve({ exitCode: interrupted ? 1 : code ?? 1, signal: interrupted ?? signal }));
  });
  process.off("SIGINT", onInterrupt);
  process.off("SIGTERM", onTerminate);
  const result: SuiteTiming = {
    suite: input.suite, scope: input.scope, startedAt,
    finishedAt: new Date().toISOString(), durationMs: Math.round(performance.now() - start),
    ...outcome, files: existsSync(file) ? JSON.parse(readFileSync(file, "utf8")) as FileTiming[] : [],
  };
  result.files.sort((a, b) => b.durationMs - a.durationMs);
  writeFileSync(join(input.directory, `${input.suite}.json`), `${JSON.stringify(result, null, 2)}\n`);
  process.stdout.write(`[verification] ${input.suite}: ${result.exitCode === 0 ? "PASS" : "FAIL"} ${(result.durationMs / 1000).toFixed(1)}s (${input.scope})\n`);
  return result;
}
