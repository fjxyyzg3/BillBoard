import { createRequire } from "node:module";
import { closeSync, lstatSync, mkdirSync, mkdtempSync, openSync, readSync, realpathSync, rmSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";
import { DESKTOP_APP_ID, protectDesktopPrivatePath, publicKeyFingerprint, validateDesktopAppIdentity, validateDesktopVersion } from "./build-config.mjs";
import { desktopRoot, releaseRoot, runDesktopTool } from "./environment.mjs";
import { inspectDesktopArtifact } from "./publish-release.mjs";

function archiveEntry(listing, expected, maximumSize) {
  const entries = listing.split(/\r?\n\r?\n/).map((block) => ({
    path: /^Path = (.+)$/m.exec(block)?.[1], size: Number(/^Size = (\d+)$/m.exec(block)?.[1]),
  })).filter((entry) => entry.path);
  const matches = entries.filter((entry) => entry.path.replaceAll("\\", "/") === expected);
  if (entries.length > 4096 || matches.length !== 1 || !Number.isSafeInteger(matches[0].size)
    || matches[0].size < 1 || matches[0].size > maximumSize) {
    throw new Error("Windows installer archive does not contain the bounded expected application");
  }
  return matches[0].path;
}

export async function inspectDesktopInstaller(path, { expectedOrigin } = {}) {
  inspectDesktopArtifact(path);
  const fd = openSync(path, "r");
  try {
    const header = Buffer.alloc(1024 * 1024);
    const bytes = readSync(fd, header, 0, header.length, 0);
    if (header.toString("ascii", 0, 2) !== "MZ"
      || header.subarray(0, bytes).indexOf(Buffer.from("efbeadde4e756c6c736f6674496e7374", "hex")) < 0) {
      throw new Error("Windows installer must be the complete NSIS executable");
    }
  } finally {
    closeSync(fd);
  }
  const require = createRequire(join(desktopRoot, "package.json"));
  const { getPath7za } = require("app-builder-lib/out/toolsets/7zip.js");
  const asar = require("@electron/asar");
  const executable = await getPath7za();
  mkdirSync(releaseRoot, { recursive: true, mode: 0o700 });
  const work = mkdtempSync(join(releaseRoot, "inspect-"));
  protectDesktopPrivatePath(work, { directory: true });
  const originalPath = realpathSync(work);
  const run = (args) => runDesktopTool(executable, args, { showOutput: false, timeout: 60000 });
  try {
    // The pinned 7za locates the embedded 7z stream and lists its app files directly.
    const listing = run(["l", "-slt", "-ba", resolve(path)]);
    const appEntry = archiveEntry(listing, "resources/app.asar", 8 * 1024 * 1024);
    run(["e", "-bd", "-y", resolve(path), appEntry, `-o${work}`]);
    const archive = join(work, "app.asar");
    const archiveInfo = lstatSync(archive);
    if (!archiveInfo.isFile() || archiveInfo.isSymbolicLink() || archiveInfo.size > 8 * 1024 * 1024
      || realpathSync(archive) !== resolve(archive)) {
      throw new Error("Windows installer embedded archive must be a bounded regular file");
    }
    const readJson = (name) => {
      const entry = asar.statFile(archive, name, false);
      if (entry.link || entry.unpacked || !Number.isSafeInteger(entry.size) || entry.size < 1 || entry.size > 64 * 1024) {
        throw new Error("Windows installer embedded metadata must be a bounded regular file");
      }
      return JSON.parse(asar.extractFile(archive, name).toString("utf8"));
    };
    const pkg = readJson("package.json");
    const runtime = readJson("runtime-config.json");
    validateDesktopVersion(pkg.version);
    validateDesktopAppIdentity(runtime.appId, runtime.origin);
    if (pkg.version !== runtime.version || pkg.main !== "src/main.mjs" || runtime.productId !== DESKTOP_APP_ID
      || (expectedOrigin && runtime.origin !== expectedOrigin)) {
      throw new Error("Windows installer embedded metadata does not match its fixed product");
    }
    return { version: pkg.version, appId: runtime.appId, productId: runtime.productId,
      publicKeyFingerprint: publicKeyFingerprint(runtime.publicKey) };
  } finally {
    // Only remove the newly created regular work directory under the private release root.
    const local = relative(realpathSync(releaseRoot), realpathSync(work));
    if (lstatSync(work).isDirectory() && !lstatSync(work).isSymbolicLink() && realpathSync(work) === originalPath
      && local && !isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`)) {
      rmSync(work, { recursive: true, force: true });
    }
  }
}
