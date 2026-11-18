import { join } from "node:path";
import { setTimeout } from "node:timers/promises";
import { androidEnvironment, repoRoot, runAndroidTool, runGradle } from "../ops/android/environment.mjs";

// Changing REQUEST_INSTALL_PACKAGES kills the target on modern Android. Configure it before each run.
const environment = androidEnvironment({ signing: false });
environment.env.BILLBOARD_ANDROID_ORIGIN = "https://billboard.example";
const serial = process.env.BILLBOARD_TEST_SERIAL ?? "emulator-5554";
if (!/^emulator-\d+$/.test(serial)) throw new Error("Updater verification requires an isolated emulator");
const adb = join(environment.config.ANDROID_HOME, "platform-tools", process.platform === "win32" ? "adb.exe" : "adb");
const packageName = "com.billboard.app.debug";
const testClass = "com.billboard.app.AndroidUpdaterTest";
const deniedTest = `${testClass}#returningFromUnknownSourcesPermissionRequiresAnotherExplicitInstall`;
const replacementTest = `${testClass}#confirmedReplacementWhenExplicitlyRequested`;
const postReplacementTest = `${testClass}#verifiesVersionAndCookieAfterReplacementWhenExplicitlyRequested`;
const device = (args, options) => runAndroidTool(adb, ["-s", serial, ...args], environment, options);
const permission = (mode) => {
  device(["shell", "am", "force-stop", packageName]);
  device(["shell", "appops", "set", packageName, "REQUEST_INSTALL_PACKAGES", mode]);
};
const instrument = (args, replacing = false) => {
  const output = device(["shell", "am", "instrument", "-w", "-r", ...args,
    `${packageName}.test/androidx.test.runner.AndroidJUnitRunner`]);
  if (!replacing && (!/OK \(\d+ tests?\)/.test(output) || /FAILURES!!!|INSTRUMENTATION_FAILED|Process crashed/.test(output))) {
    throw new Error("Android instrumentation failed");
  }
  return output;
};

runGradle([":app:assembleDebug", ":app:assembleDebugAndroidTest"], environment);
device(["install", "-r", "-d", join(repoRoot, "android/app/build/outputs/apk/debug/app-debug.apk")]);
device(["install", "-r", join(repoRoot, "android/app/build/outputs/apk/androidTest/debug/app-debug-androidTest.apk")]);
permission("allow");
instrument(["-e", "notClass", `${deniedTest},${replacementTest},${postReplacementTest}`]);
permission("deny");
instrument(["-e", "class", deniedTest]);

if (process.argv.includes("--confirm-upgrade")) {
  permission("allow");
  const before = device(["shell", "dumpsys", "package", packageName], { showOutput: false }).match(/versionCode=(\d+)/)?.[1];
  const output = instrument(["-e", "class", replacementTest, "-e", "performUpdate", "true"], true);
  // A real self-update terminates its own instrumentation. Verify the installed package independently.
  let after;
  for (let attempt = 0; attempt < 20; attempt++) {
    after = device(["shell", "dumpsys", "package", packageName], { showOutput: false }).match(/versionCode=(\d+)/)?.[1];
    if (Number(after) === Number(before) + 1) break;
    await setTimeout(500);
  }
  if (!before || Number(after) !== Number(before) + 1 || !/Process crashed|Process is no longer running/.test(output)) {
    throw new Error("The explicit PackageInstaller replacement was not independently verified");
  }
  console.log(`Verified PackageInstaller replacement: versionCode ${before} -> ${after}`);
  instrument(["-e", "class", postReplacementTest, "-e", "afterUpdate", "true"]);
  console.log("Verified installed version and persistent Cookie after process restart");
}
console.log("Android device verification passed");
