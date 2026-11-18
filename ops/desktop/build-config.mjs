import { execFileSync } from "node:child_process";
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync } from "node:crypto";
import {
  chmodSync, closeSync, existsSync, fsyncSync, lstatSync, mkdirSync, openSync,
  readFileSync, realpathSync, unlinkSync, writeFileSync,
} from "node:fs";
import { basename, dirname, isAbsolute, relative, resolve, sep } from "node:path";

export const DESKTOP_APP_ID = "com.billboard.desktop";
export const DESKTOP_ELECTRON_VERSION = "45.0.0";
export const DESKTOP_BUILDER_VERSION = "26.15.3";

export function validateDesktopOrigin(value) {
  try {
    if (typeof value !== "string" || /[\s\\<>]/.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || /[?#]/.test(value)) throw new Error();
    return url.origin;
  } catch {
    throw new Error("Desktop origin must be an HTTPS root URL without credentials, query or fragment");
  }
}

export function validateDesktopVersion(version) {
  if (typeof version !== "string" || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version)
    || version.split(".").some((part) => Number(part) > 65535)) {
    throw new Error("Desktop version must fit the three Windows version fields");
  }
  return version;
}

export function validateDesktopAppIdentity(appId, origin) {
  if (appId === DESKTOP_APP_ID) return;
  const hostname = new URL(validateDesktopOrigin(origin)).hostname;
  if (!/^com\.billboard\.desktop\.validation\.[a-z0-9]+$/.test(appId)
    || !(hostname === "localhost" || hostname.endsWith(".test") || hostname.endsWith(".example"))) {
    throw new Error("Desktop validation packages require a separate validation appId and synthetic HTTPS origin");
  }
}

export function redactDesktopOutput(value, privateValues = []) {
  const values = new Set(privateValues.filter((item) => typeof item === "string" && item.length >= 4));
  for (const item of values) {
    try { values.add(new URL(item).hostname); } catch { /* Most signing values are not URLs. */ }
  }
  let output = String(value);
  for (const item of [...values].filter(Boolean).sort((a, b) => b.length - a.length)) {
    output = output.replaceAll(item, "<redacted>");
  }
  return output;
}

function comparable(path) {
  return process.platform === "win32" ? path.toLowerCase() : path;
}

function canonicalTarget(path) {
  let parent = resolve(path);
  const tail = [];
  while (!existsSync(parent)) {
    tail.unshift(basename(parent));
    const next = dirname(parent);
    if (next === parent) throw new Error("Desktop signing key requires a valid absolute private path");
    parent = next;
  }
  return resolve(realpathSync(parent), ...tail);
}

export function validateDesktopPrivateKeyPath(path, repositoryRoots) {
  if (typeof path !== "string" || !isAbsolute(path) || /[\r\n<>]/.test(path)) {
    throw new Error("Desktop signing key requires a valid absolute private path");
  }
  const target = comparable(canonicalTarget(path));
  for (const repositoryRoot of repositoryRoots) {
    const root = comparable(canonicalTarget(repositoryRoot));
    const local = relative(root, target);
    if (!local || (!isAbsolute(local) && local !== ".." && !local.startsWith(`..${sep}`))) {
      throw new Error("Desktop signing key must stay outside all repository roots");
    }
  }
  return resolve(path);
}

export function protectDesktopPrivatePath(path, { directory = false } = {}) {
  if (process.platform === "win32") {
    const account = `${process.env.USERDOMAIN}\\${process.env.USERNAME}`;
    const access = directory ? "(OI)(CI)(F)" : "(F)";
    execFileSync("icacls.exe", [path, "/inheritance:r", "/grant:r", `${account}:${access}`, `*S-1-5-18:${access}`], {
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
    });
  } else {
    chmodSync(path, directory ? 0o700 : 0o600);
  }
}

function assertDesktopPrivateKeyPermissions(path) {
  if (process.platform !== "win32") {
    if ((lstatSync(path).mode & 0o077) !== 0) throw new Error("Desktop signing key permissions must be private");
    return;
  }
  const script = "$ErrorActionPreference='Stop'; $allowed=@([Security.Principal.WindowsIdentity]::GetCurrent().User.Value,'S-1-5-18','S-1-5-32-544'); "
    + "$acl=[IO.File]::GetAccessControl($env:BILLBOARD_DESKTOP_ACL_FILE); foreach($rule in $acl.Access) { "
    + "if($rule.AccessControlType -eq 'Allow' -and $rule.IdentityReference.Translate([Security.Principal.SecurityIdentifier]).Value -notin $allowed) { exit 1 } }; exit 0";
  try {
    execFileSync("powershell.exe", ["-NoProfile", "-NonInteractive", "-Command", script], {
      env: { ...process.env, BILLBOARD_DESKTOP_ACL_FILE: path },
      windowsHide: true, stdio: ["ignore", "pipe", "pipe"], timeout: 10000,
    });
  } catch {
    throw new Error("Desktop signing key permissions must be private");
  }
}

export function publicKeyFingerprint(publicKey) {
  const key = createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Desktop update signing requires an Ed25519 key");
  return createHash("sha256").update(key.export({ type: "spki", format: "der" })).digest("hex");
}

export function loadDesktopSigningKey(path, { repositoryRoots = [] } = {}) {
  const file = validateDesktopPrivateKeyPath(path, repositoryRoots);
  const info = lstatSync(file);
  if (!info.isFile() || info.isSymbolicLink() || info.size < 1 || info.size > 16 * 1024
    || comparable(realpathSync(file)) !== comparable(file)) {
    throw new Error("Desktop signing key must be a private regular file");
  }
  const privateKey = createPrivateKey(readFileSync(file));
  if (privateKey.asymmetricKeyType !== "ed25519") throw new Error("Desktop update signing requires an Ed25519 key");
  assertDesktopPrivateKeyPermissions(file);
  const publicKey = createPublicKey(privateKey).export({ type: "spki", format: "pem" }).toString();
  return { privateKey, publicKey, publicKeyFingerprint: publicKeyFingerprint(publicKey) };
}

export function initializeDesktopSigning(path, { repositoryRoots = [] } = {}) {
  const file = validateDesktopPrivateKeyPath(path, repositoryRoots);
  if (existsSync(file)) throw new Error("Desktop signing key already exists; reuse and privately back it up instead of replacing it");
  if (!existsSync(dirname(file))) {
    mkdirSync(dirname(file), { recursive: true, mode: 0o700 });
    protectDesktopPrivatePath(dirname(file), { directory: true });
  }
  const { privateKey } = generateKeyPairSync("ed25519");
  const fd = openSync(file, "wx", 0o600);
  try {
    // Establish the Windows ACL before writing private material to the newly created file.
    protectDesktopPrivatePath(file);
    writeFileSync(fd, privateKey.export({ type: "pkcs8", format: "pem" }));
    fsyncSync(fd);
  } catch (error) {
    closeSync(fd);
    unlinkSync(file);
    throw error;
  }
  closeSync(fd);
  return loadDesktopSigningKey(file, { repositoryRoots });
}
