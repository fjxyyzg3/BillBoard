import { createPrivateKey, createPublicKey, KeyObject, sign, verify } from "node:crypto";

export const DESKTOP_PRODUCT_ID = "com.billboard.desktop";
export const MAX_DESKTOP_INSTALLER_BYTES = 256 * 1024 * 1024;
export const MAX_DESKTOP_MANIFEST_BYTES = 64 * 1024;
export const DESKTOP_SHA256_PATTERN = /^[a-f0-9]{64}$/;

const maximumPayloadBytes = 32 * 1024;
const versionPattern = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/;
const base64Pattern = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;
const utf8 = new TextDecoder("utf-8", { fatal: true });

function invalid() {
  throw new Error("Invalid Windows update manifest");
}

function exactKeys(value, keys) {
  return value !== null && typeof value === "object" && !Array.isArray(value)
    && Object.keys(value).length === keys.length
    && keys.every((key) => Object.hasOwn(value, key));
}

function validVersion(value) {
  return typeof value === "string" && value.length <= 40 && versionPattern.test(value);
}

function decodeBase64(value, maximumBytes) {
  if (typeof value !== "string" || !value.length || value.length > Math.ceil(maximumBytes / 3) * 4
    || !base64Pattern.test(value)) invalid();
  const bytes = Buffer.from(value, "base64");
  if (bytes.length > maximumBytes || bytes.toString("base64") !== value) invalid();
  return bytes;
}

export function parseDesktopRelease(value) {
  if (!exactKeys(value, ["schema", "productId", "platform", "arch", "version", "size", "sha256", "notes"])
    || value.schema !== 1 || value.productId !== DESKTOP_PRODUCT_ID || value.platform !== "win32" || value.arch !== "x64"
    || !validVersion(value.version)
    || !Number.isSafeInteger(value.size) || value.size < 1 || value.size > MAX_DESKTOP_INSTALLER_BYTES
    || typeof value.sha256 !== "string" || !DESKTOP_SHA256_PATTERN.test(value.sha256)
    || !exactKeys(value.notes, ["zh-CN", "en-US"])
    || ["zh-CN", "en-US"].some((locale) => typeof value.notes[locale] !== "string"
      || !value.notes[locale].trim() || value.notes[locale].length > 4000
      || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/.test(value.notes[locale]))) invalid();
  return {
    schema: 1, productId: DESKTOP_PRODUCT_ID, platform: "win32", arch: "x64", version: value.version,
    size: value.size, sha256: value.sha256,
    notes: { "zh-CN": value.notes["zh-CN"], "en-US": value.notes["en-US"] },
  };
}

export function parseDesktopEnvelope(raw) {
  let value = raw;
  if (raw instanceof Uint8Array || typeof raw === "string") {
    const bytes = typeof raw === "string" ? Buffer.from(raw, "utf8") : raw;
    if (!bytes.length || bytes.length > MAX_DESKTOP_MANIFEST_BYTES) invalid();
    value = JSON.parse(utf8.decode(bytes));
  }
  if (!exactKeys(value, ["payload", "signature"])) invalid();
  decodeBase64(value.payload, maximumPayloadBytes);
  if (decodeBase64(value.signature, 64).length !== 64) invalid();
  const envelope = { payload: value.payload, signature: value.signature };
  if (Buffer.byteLength(JSON.stringify(envelope), "utf8") > MAX_DESKTOP_MANIFEST_BYTES) invalid();
  return envelope;
}

export function verifyDesktopManifest(raw, publicKey) {
  const envelope = parseDesktopEnvelope(raw);
  const key = publicKey instanceof KeyObject && publicKey.type === "public" ? publicKey : createPublicKey(publicKey);
  if (key.asymmetricKeyType !== "ed25519") invalid();
  const bytes = decodeBase64(envelope.payload, maximumPayloadBytes);
  if (!verify(null, bytes, key, decodeBase64(envelope.signature, 64))) invalid();
  return parseDesktopRelease(JSON.parse(utf8.decode(bytes)));
}

export function createDesktopManifest(release, privateKey) {
  const value = parseDesktopRelease(release);
  const key = privateKey instanceof KeyObject ? privateKey : createPrivateKey(privateKey);
  if (key.type !== "private" || key.asymmetricKeyType !== "ed25519") invalid();
  const bytes = Buffer.from(JSON.stringify(value), "utf8");
  if (bytes.length > maximumPayloadBytes) invalid();
  return parseDesktopEnvelope({ payload: bytes.toString("base64"), signature: sign(null, bytes, key).toString("base64") });
}

export function compareDesktopVersions(a, b) {
  if (!validVersion(a) || !validVersion(b)) invalid();
  const first = a.split(".").map(BigInt);
  const second = b.split(".").map(BigInt);
  for (let index = 0; index < 3; index += 1) {
    if (first[index] !== second[index]) return first[index] > second[index] ? 1 : -1;
  }
  return 0;
}
