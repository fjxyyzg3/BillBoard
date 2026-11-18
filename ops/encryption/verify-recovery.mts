import { spawn } from "node:child_process";
import { constants } from "node:fs";
import { lstat, open } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { MAX_RECOVERY_SNAPSHOT_BYTES, RecoveryError, verifyFinancialSnapshot, type RecoveryMaterial } from "../../src/lib/encryption/recovery.ts";

const projectRoot = fileURLToPath(new URL("../../", import.meta.url));
function invalid(): never { throw new RecoveryError("RECOVERY_INVALID"); }
function argumentsFor(values: string[]) {
  const flags = new Map<string, string>();
  for (let index = 0; index < values.length; index++) {
    const flag = values[index];
    if (flags.has(flag) || !["--snapshot", "--manifest-digest", "--recovery-package", "--synthetic", "--help"].includes(flag)) invalid();
    if (["--synthetic", "--help"].includes(flag)) flags.set(flag, "true");
    else {
      const value = values[++index];
      if (!value || value.startsWith("--")) invalid();
      flags.set(flag, value);
    }
  }
  return flags;
}
async function boundedFile(filename: string, maximum: number) {
  const stat = await lstat(filename);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size > maximum) invalid();
  const handle = await open(filename, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0));
  try {
    const actual = await handle.stat();
    if (!actual.isFile() || actual.dev !== stat.dev || actual.ino !== stat.ino || actual.size !== stat.size) invalid();
    const chunks: Buffer[] = [];
    let size = 0;
    while (true) {
      const buffer = Buffer.allocUnsafe(128 * 1024), next = await handle.read(buffer);
      if (!next.bytesRead) break;
      size += next.bytesRead;
      if (size > maximum) invalid();
      chunks.push(buffer.subarray(0, next.bytesRead));
    }
    return Buffer.concat(chunks, size);
  } finally { await handle.close(); }
}
async function readCode(): Promise<string> {
  if (process.stdin.isTTY) process.stderr.write("Current household code (hidden; never written to disk): ");
  return new Promise<string>((resolve, reject) => {
    const chunks: Buffer[] = [];
    let length = 0, completed = false;
    const raw = process.stdin.isTTY;
    const finish = (error?: Error) => {
      if (completed) return;
      completed = true; clearTimeout(timer);
      process.stdin.off("data", data); process.stdin.off("end", end); process.stdin.off("error", failed);
      if (raw) { process.stdin.setRawMode(false); process.stderr.write("\n"); }
      process.stdin.pause();
      const bytes = Buffer.concat(chunks);
      try {
        if (error) reject(error);
        else resolve(new TextDecoder("utf-8", { fatal: true }).decode(bytes).trim());
      } catch { reject(new RecoveryError("RECOVERY_INVALID")); }
      finally { bytes.fill(0); for (const chunk of chunks) chunk.fill(0); }
    };
    const data = (chunk: Buffer) => {
      for (const byte of chunk) {
        if (byte === 3) { finish(new RecoveryError("RECOVERY_INVALID")); return; }
        if (byte === 10 || byte === 13) { finish(); return; }
        if (raw && (byte === 127 || byte === 8)) { if (length) { chunks.pop()!.fill(0); length--; } continue; }
        if (++length > 4096) { finish(new RecoveryError("RECOVERY_BUDGET")); return; }
        chunks.push(Buffer.from([byte]));
      }
    };
    const end = () => finish(), failed = () => finish(new RecoveryError("RECOVERY_INVALID"));
    const timer = setTimeout(() => finish(new RecoveryError("RECOVERY_INVALID")), 60_000);
    process.stdin.on("data", data); process.stdin.once("end", end); process.stdin.once("error", failed);
    if (raw) process.stdin.setRawMode(true);
    process.stdin.resume();
  });
}

async function synthetic() {
  // The acceptance suite migrates only owned random databases, then destroys its source.
  process.loadEnvFile(path.join(projectRoot, ".env.example"));
  const url = new URL(process.env.DATABASE_URL ?? "");
  if (process.env.NODE_ENV === "production" || !["localhost", "127.0.0.1"].includes(url.hostname) || !/_(?:dev|test)$/.test(url.pathname)) invalid();
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, [path.join(projectRoot, "node_modules/vitest/vitest.mjs"), "run", "--dir", "tests/integration", "--no-file-parallelism", "tests/integration/encryption-recovery.test.ts"], {
      cwd: projectRoot, windowsHide: true, stdio: "ignore",
      env: { DATABASE_URL: url.toString(), NODE_ENV: "test", PATH: process.env.PATH, SystemRoot: process.env.SystemRoot, TEMP: process.env.TEMP, TMP: process.env.TMP },
    });
    child.once("error", () => reject(new RecoveryError("RECOVERY_INVALID")));
    child.once("close", (status) => resolve(status ?? 1));
  });
  if (code !== 0) throw new RecoveryError("RECOVERY_MISMATCH");
  process.stdout.write(`${JSON.stringify({ mode: "synthetic", verified: true, production: false, acceptanceSuite: "encryption-recovery.test.ts", isolatedPostgreSQL17: true })}\n`);
}

async function main() {
  const flags = argumentsFor(process.argv.slice(2));
  if (flags.has("--help") || !flags.size) {
    process.stdout.write("Check only: node --import tsx ops/encryption/verify-recovery.mts --snapshot <bundle.json> --manifest-digest <trusted-sha256> [--recovery-package <encrypted-BBP1-file>]\n");
    process.stdout.write("The current code is read only from hidden terminal input or bounded ephemeral stdin. No restore, credential environment variables or plaintext key files are supported.\n");
    process.stdout.write("Synthetic drill: node --import tsx ops/encryption/verify-recovery.mts --synthetic\n");
    return;
  }
  if (flags.has("--synthetic")) {
    if (flags.size !== 1) invalid();
    await synthetic(); return;
  }
  const filename = flags.get("--snapshot"), expectedManifestDigest = flags.get("--manifest-digest");
  if (!filename || !expectedManifestDigest || !/^[0-9a-f]{64}$/.test(expectedManifestDigest)) invalid();
  const bytes = await boundedFile(filename, MAX_RECOVERY_SNAPSHOT_BYTES + 4 * 1024 * 1024);
  let bundle: unknown;
  try { bundle = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(bytes)); }
  finally { bytes.fill(0); }
  let material: RecoveryMaterial | undefined;
  try {
    if (flags.has("--recovery-package")) {
      const sealed = await boundedFile(flags.get("--recovery-package")!, 3 * 1024 * 1024);
      try { material = { code: await readCode(), recoveryPackage: new TextDecoder("utf-8", { fatal: true }).decode(sealed).trim() }; }
      finally { sealed.fill(0); }
    }
    const result = await verifyFinancialSnapshot(bundle, { expectedManifestDigest, material });
    process.stdout.write(`${JSON.stringify({ mode: "check-only", ...result, targetWritten: false })}\n`);
  } finally { if (material) material.code = ""; }
}

main().catch((error: unknown) => {
  // Errors never echo arguments, DSNs, package bytes, row values or entered secrets.
  process.stderr.write(`${error instanceof RecoveryError ? error.code : "RECOVERY_INVALID"}\n`);
  process.exitCode = 1;
});
