import { createPublicKey } from "node:crypto";

const productId = "com.billboard.desktop";
const validationId = /^com\.billboard\.desktop\.validation\.[a-z0-9]+$/;

function parseHttps(value) {
  if (typeof value !== "string" || !value || value.length > 4096 || /[\u0000-\u0020\u007f\\]/.test(value)) return null;
  try {
    const url = new URL(value);
    return url.protocol === "https:" && url.hostname && !url.username && !url.password && url.port !== "0" ? url : null;
  } catch { return null; }
}

export function validateOrigin(value) {
  const url = parseHttps(value);
  if (!url || url.pathname !== "/" || url.search || url.hash) throw new Error("Invalid private HTTPS origin");
  return url.origin;
}

export function isTrustedUrl(value, origin) {
  return parseHttps(value)?.origin === origin;
}

export function isExternalHttps(value, origin) {
  const url = parseHttps(value);
  return Boolean(url && url.origin !== origin);
}

export function isTrustedSender(event, contents, origin) {
  try {
    return Boolean(contents && !contents.isDestroyed() && event.sender === contents
      && event.senderFrame === contents.mainFrame && isTrustedUrl(event.senderFrame.url, origin)
      && isTrustedUrl(contents.getURL(), origin));
  } catch { return false; }
}

export function allowedPermission(permission, details, origin) {
  if (details?.isMainFrame !== true || !isTrustedUrl(details.requestingUrl, origin)) return false;
  if (permission === "clipboard-sanitized-write") return true;
  return permission === "media" && Array.isArray(details.mediaTypes) && details.mediaTypes.length > 0
    && details.mediaTypes.every(type => type === "audio" || type === "video");
}

export function validateRuntimeConfig(value) {
  const keys = ["origin", "publicKey", "productId", "version", "appId"];
  if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length !== keys.length
    || !keys.every(key => Object.hasOwn(value, key)) || value.productId !== productId
    || typeof value.version !== "string" || value.version.length > 40 || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value.version)
    || typeof value.publicKey !== "string" || value.publicKey.length > 4096 || !value.publicKey.startsWith("-----BEGIN PUBLIC KEY-----")
    || (value.appId !== productId && !validationId.test(value.appId))) throw new Error("Invalid private desktop configuration");
  const origin = validateOrigin(value.origin);
  const key = createPublicKey(value.publicKey);
  if (key.asymmetricKeyType !== "ed25519") throw new Error("Invalid update verification key");
  const hostname = new URL(origin).hostname;
  if (value.appId !== productId && !["localhost", "127.0.0.1", "[::1]"].includes(hostname)
    && !hostname.endsWith(".test") && !hostname.endsWith(".example")) throw new Error("Validation builds require a synthetic origin");
  return { ...value, origin };
}

export function safeDownloadName(value) {
  if (typeof value !== "string" || !value || value.length > 200 || /[\u0000-\u001f\u007f<>:"/\\|?*]/.test(value)
    || value !== value.trim() || /[. ]$/.test(value) || /^(?:CON|PRN|AUX|NUL|COM[0-9]|LPT[0-9])(?:\.|$)/i.test(value)
    || !/\.(?:xlsx|json|txt)$/i.test(value)) return null;
  return value;
}
