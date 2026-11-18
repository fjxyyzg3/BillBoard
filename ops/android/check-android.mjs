import { androidEnvironment, runGradle } from "./environment.mjs";

try {
  const environment = androidEnvironment({ signing: false });
  // Instrumentation always uses synthetic content, never the household production service.
  environment.env.BILLBOARD_ANDROID_ORIGIN = "https://billboard.example";
  const tasks = process.argv.includes("--connected")
    ? [":app:connectedDebugAndroidTest"]
    : [":app:lintDebug", ":app:testDebugUnitTest", ":app:assembleDebug", ":app:assembleDebugAndroidTest"];
  runGradle(tasks, environment);
} catch {
  process.stderr.write("Android verification failed; check the sanitized tool output and local toolchain configuration.\n");
  process.exitCode = 1;
}
