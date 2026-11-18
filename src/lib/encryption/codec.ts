export class EncryptionError extends Error {
  constructor() {
    super("Invalid household encryption data");
    this.name = "EncryptionError";
  }
}

export function invalidData(): never {
  throw new EncryptionError();
}

export type Bytes = Uint8Array<ArrayBuffer>;

export function encodeBase64Url(bytes: Uint8Array): string {
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) {
    chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  }
  return btoa(chunks.join("")).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

export function decodeBase64Url(text: unknown, maxBytes: number, exactBytes?: number): Bytes {
  if (typeof text !== "string" || text.length === 0 || text.length > Math.ceil(maxBytes * 4 / 3)
    || text.length % 4 === 1 || !/^[A-Za-z0-9_-]+$/.test(text)) invalidData();
  let binary: string;
  try {
    binary = atob(text.replace(/-/g, "+").replace(/_/g, "/"));
  } catch {
    return invalidData();
  }
  if (binary.length > maxBytes || (exactBytes !== undefined && binary.length !== exactBytes)) invalidData();
  const bytes = new Uint8Array(binary.length);
  for (let index = 0; index < binary.length; index++) bytes[index] = binary.charCodeAt(index);
  if (encodeBase64Url(bytes) !== text) {
    bytes.fill(0);
    invalidData();
  }
  return bytes;
}

export function encodeUtf8(text: string): Bytes {
  return new TextEncoder().encode(text);
}

function jsonStringBytes(value: string, remaining: number): number {
  let bytes = 2;
  if (value.length + bytes > remaining) invalidData();
  for (let index = 0; index < value.length; index++) {
    const code = value.charCodeAt(index);
    if (code === 34 || code === 92 || code === 8 || code === 9 || code === 10 || code === 12 || code === 13) {
      bytes += 2;
    } else if (code < 32) {
      bytes += 6;
    } else if (code < 128) {
      bytes++;
    } else if (code < 2048) {
      bytes += 2;
    } else if (code >= 0xd800 && code <= 0xdbff) {
      const next = value.charCodeAt(index + 1);
      if (next >= 0xdc00 && next <= 0xdfff) {
        bytes += 4;
        index++;
      } else {
        bytes += 6;
      }
    } else {
      bytes += code >= 0xdc00 && code <= 0xdfff ? 6 : 3;
    }
    if (bytes > remaining) invalidData();
  }
  return bytes;
}

// Only lossless JSON values are accepted. Bound the encoded size before allocating it.
export function canonicalJson(value: unknown, maxBytes: number): string {
  const parts: string[] = [];
  const parents = new Set<object>();
  let remaining = maxBytes;
  function append(text: string, byteLength = text.length) {
    remaining -= byteLength;
    if (remaining < 0) invalidData();
    parts.push(text);
  }
  function appendString(text: string) {
    const byteLength = jsonStringBytes(text, remaining);
    append(JSON.stringify(text), byteLength);
  }
  function visit(current: unknown, depth: number) {
    if (depth > 64) invalidData();
    if (current === null || typeof current === "boolean") {
      append(String(current));
    } else if (typeof current === "string") {
      appendString(current);
    } else if (typeof current === "number") {
      if (!Number.isFinite(current)) invalidData();
      append(JSON.stringify(current));
    } else if (typeof current === "object") {
      if (parents.has(current) || Object.getOwnPropertySymbols(current).length > 0) invalidData();
      parents.add(current);
      if (Array.isArray(current)) {
        if (current.length > remaining) invalidData();
        if (Object.keys(current).length !== current.length) invalidData();
        append("[");
        for (let index = 0; index < current.length; index++) {
          if (index > 0) append(",");
          const descriptor = Object.getOwnPropertyDescriptor(current, String(index));
          if (!descriptor || !("value" in descriptor)) invalidData();
          visit(descriptor.value, depth + 1);
        }
        append("]");
      } else {
        const prototype = Object.getPrototypeOf(current);
        if (prototype !== Object.prototype && prototype !== null) invalidData();
        append("{");
        const keys = Object.keys(current).sort();
        for (let index = 0; index < keys.length; index++) {
          if (index > 0) append(",");
          appendString(keys[index]);
          append(":");
          const descriptor = Object.getOwnPropertyDescriptor(current, keys[index]);
          if (!descriptor || !("value" in descriptor)) invalidData();
          visit(descriptor.value, depth + 1);
        }
        append("}");
      }
      parents.delete(current);
    } else {
      invalidData();
    }
  }
  visit(value, 0);
  return parts.join("");
}

export function parseCanonicalJson(bytes: Bytes, maxBytes: number): unknown {
  try {
    if (bytes.length > maxBytes) invalidData();
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    const parsed: unknown = JSON.parse(text);
    if (canonicalJson(parsed, maxBytes) !== text) invalidData();
    return parsed;
  } catch {
    return invalidData();
  }
}

export function frame(prefix: string, value: unknown, maxBytes: number): string {
  const bytes = encodeUtf8(canonicalJson(value, maxBytes));
  try {
    return `${prefix}.${encodeBase64Url(bytes)}`;
  } finally {
    bytes.fill(0);
  }
}

export function unframe(prefix: string, value: unknown, maxBytes: number): unknown {
  if (typeof value !== "string" || !value.startsWith(`${prefix}.`)
    || value.length > prefix.length + 1 + Math.ceil(maxBytes * 4 / 3)) invalidData();
  const bytes = decodeBase64Url(value.slice(prefix.length + 1), maxBytes);
  try {
    return parseCanonicalJson(bytes, maxBytes);
  } finally {
    bytes.fill(0);
  }
}

export function record(value: unknown, fields: readonly string[]): Record<string, unknown> {
  if (typeof value !== "object" || value === null || Array.isArray(value)
    || Object.getOwnPropertySymbols(value).length > 0) invalidData();
  const prototype = Object.getPrototypeOf(value);
  if (prototype !== Object.prototype && prototype !== null) invalidData();
  if (Object.keys(value).some((key) => !fields.includes(key))) invalidData();
  for (const descriptor of Object.values(Object.getOwnPropertyDescriptors(value))) {
    if (!("value" in descriptor)) invalidData();
  }
  return value as Record<string, unknown>;
}
