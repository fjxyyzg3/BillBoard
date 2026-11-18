import { copyFileSync, existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { DESKTOP_BUILDER_VERSION, DESKTOP_ELECTRON_VERSION } from "./build-config.mjs";
import { desktopRoot, repoRoot, reportDesktopFailure, runDesktopTool } from "./environment.mjs";

try {
  const pkg = JSON.parse(readFileSync(join(desktopRoot, "package.json"), "utf8"));
  const lock = JSON.parse(readFileSync(join(desktopRoot, "package-lock.json"), "utf8"));
  const root = JSON.parse(readFileSync(join(repoRoot, "package.json"), "utf8"));
  if (pkg.version !== root.version || lock.version !== pkg.version || lock.packages[""].version !== pkg.version
    || pkg.dependencies || pkg.devDependencies.electron !== DESKTOP_ELECTRON_VERSION
    || pkg.devDependencies["electron-builder"] !== DESKTOP_BUILDER_VERSION) {
    throw new Error("Desktop dependency lock and version must match the independent project and root version");
  }
  for (const [name, expected] of [["electron", DESKTOP_ELECTRON_VERSION], ["electron-builder", DESKTOP_BUILDER_VERSION]]) {
    const installed = JSON.parse(readFileSync(join(desktopRoot, "node_modules", name, "package.json"), "utf8"));
    if (installed.version !== expected) throw new Error("Desktop dependency installation does not match the exact lock");
  }
  mkdirSync(join(desktopRoot, "shared"), { recursive: true });
  copyFileSync(join(repoRoot, "src/lib/desktop-update-manifest.mjs"), join(desktopRoot, "shared/desktop-update-manifest.mjs"));
  const sources = (directory) => readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    return entry.isDirectory() ? sources(path) : /\.(?:mjs|cjs)$/.test(entry.name) ? [path] : [];
  });
  for (const source of [...sources(join(desktopRoot, "src")), ...sources(join(repoRoot, "ops/desktop")),
    join(desktopRoot, "electron-builder.cjs"), join(desktopRoot, "test-windows.mjs"), join(desktopRoot, "test-web.mjs")]) {
    runDesktopTool(process.execPath, ["--check", source]);
  }
  const tests = sources(join(desktopRoot, "tests")).filter((file) => file.endsWith(".test.mjs"));
  if (!tests.length) throw new Error("Desktop tool failed; native behavior tests are required");
  runDesktopTool(process.execPath, ["--test", ...tests]);
  if (!existsSync(join(desktopRoot, "node_modules/electron/dist/electron.exe")) && process.platform === "win32") {
    throw new Error("Desktop dependency runtime is absent; run node desktop/node_modules/electron/install.js");
  }
  process.stdout.write("Windows desktop source, independent lock, shared protocol and native behavior checks passed.\n");
} catch (error) {
  reportDesktopFailure(error, "Desktop verification failed; inspect the local independent toolchain and sanitized output");
}
