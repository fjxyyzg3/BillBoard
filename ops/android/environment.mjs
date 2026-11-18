import { spawnSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, delimiter, join, resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { parseEnv } from "node:util";
import { redactBuildOutput, validateAndroidOrigin } from "./build-config.mjs";

export const repoRoot = resolve(dirname(fileURLToPath(import.meta.url)), "../..");
export const privateConfigPath = join(repoRoot, ".env.android.local");
const configKeys = [
  "JAVA_HOME", "ANDROID_HOME", "GRADLE_USER_HOME", "JAVA_TOOL_OPTIONS", "BILLBOARD_ANDROID_ORIGIN", "BILLBOARD_ANDROID_KEYSTORE",
  "BILLBOARD_ANDROID_KEY_ALIAS", "BILLBOARD_ANDROID_STORE_PASSWORD", "BILLBOARD_ANDROID_KEY_PASSWORD",
];

export function androidEnvironment({ signing = true } = {}) {
  const file = existsSync(privateConfigPath) ? parseEnv(readFileSync(privateConfigPath, "utf8")) : {};
  const config = Object.fromEntries(configKeys.map((key) => [key, process.env[key] ?? file[key] ?? ""]));
  config.BILLBOARD_ANDROID_ORIGIN = validateAndroidOrigin(config.BILLBOARD_ANDROID_ORIGIN);
  const java = join(config.JAVA_HOME, "bin", process.platform === "win32" ? "java.exe" : "java");
  if (!config.JAVA_HOME || !existsSync(java) || !config.ANDROID_HOME || !existsSync(config.ANDROID_HOME)) {
    throw new Error("Set JAVA_HOME and ANDROID_HOME in .env.android.local to the installed Android toolchain");
  }
  if (signing && (!config.BILLBOARD_ANDROID_KEYSTORE || !existsSync(config.BILLBOARD_ANDROID_KEYSTORE)
    || !config.BILLBOARD_ANDROID_KEY_ALIAS || !config.BILLBOARD_ANDROID_STORE_PASSWORD || !config.BILLBOARD_ANDROID_KEY_PASSWORD)) {
    throw new Error("A persistent private release keystore and signing configuration are required");
  }
  const configured = Object.fromEntries(Object.entries(config).filter(([, value]) => value));
  return {
    config,
    java,
    env: {
      ...process.env, ...configured,
      BILLBOARD_NODE_EXECUTABLE: process.execPath,
      PATH: `${join(config.JAVA_HOME, "bin")}${delimiter}${process.env.PATH ?? ""}`,
    },
  };
}

export function runAndroidTool(executable, args, environment, { showOutput = true, cwd = repoRoot } = {}) {
  const result = spawnSync(executable, args, {
    cwd, env: environment.env, encoding: "utf8", windowsHide: true, maxBuffer: 32 * 1024 * 1024,
  });
  const output = redactBuildOutput(`${result.stdout ?? ""}${result.stderr ?? ""}`, Object.values(environment.config));
  if (showOutput && output) process.stdout.write(output);
  if (result.error || result.status !== 0) {
    if (!showOutput && output) process.stderr.write(output);
    throw new Error("Android tool failed; see the sanitized output above");
  }
  return output;
}

export function runGradle(tasks, environment) {
  return runAndroidTool(environment.java, [
    "-classpath", join(repoRoot, "android/gradle/wrapper/gradle-wrapper.jar"),
    "org.gradle.wrapper.GradleWrapperMain", "--no-daemon", "--console=plain", ...tasks,
  ], environment, { cwd: join(repoRoot, "android") });
}
