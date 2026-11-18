import {
  canonicalJson, decodeBase64Url, encodeBase64Url, encodeUtf8, EncryptionError,
  frame, invalidData, parseCanonicalJson, record, unframe, type Bytes,
} from "./codec";

export { EncryptionError } from "./codec";

export type HouseholdCode = {
  v: 1;
  householdId: string;
  generation: string;
  keyVersion: number;
  secret: string;
};

export type KeyRing = {
  v: 1;
  householdId: string;
  generation: string;
  currentKeyVersion: number;
  keys: Array<{ generation: string; keyVersion: number; secret: string }>;
};

export type EntityContext = {
  householdId: string;
  model: string;
  id: string;
  ledgerId?: string | null;
  actorMemberId?: string | null;
  createdByMemberId?: string | null;
  revision?: string;
};

export const MAX_ENTITY_JSON_BYTES = 32 * 1024 * 1024;
const MAX_ENTITY_ENVELOPE_BYTES = 48 * 1024 * 1024;
const MAX_KEY_RING_BYTES = 1024 * 1024;
const MAX_KEY_RING_ENVELOPE_BYTES = 2 * 1024 * 1024;
const MAX_CODE_BYTES = 2048;
const DOMAIN = "billboard-household-encryption:v1";
const CODE_FIELDS = ["v", "householdId", "generation", "keyVersion", "secret"];
const RING_FIELDS = ["v", "householdId", "generation", "currentKeyVersion", "keys"];
const CONTEXT_FIELDS = ["householdId", "model", "id", "ledgerId", "actorMemberId", "createdByMemberId", "revision"];
const KEY_ENVELOPE_FIELDS = ["v", "purpose", "householdId", "generation", "keyVersion", "salt", "nonce", "ciphertext"];
const ENTITY_ENVELOPE_FIELDS = ["v", "purpose", "householdId", "generation", "keyVersion", "revision", "salt", "nonce", "keyNonce", "wrappedKey", "ciphertext"];

function checked<T>(work: () => T): T {
  try {
    return work();
  } catch {
    throw new EncryptionError();
  }
}

async function guarded<T>(work: () => Promise<T>): Promise<T> {
  try {
    return await work();
  } catch {
    throw new EncryptionError();
  }
}

function identifier(value: unknown): string {
  if (typeof value !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:-]{0,127}$/.test(value)) invalidData();
  return value;
}

function version(value: unknown): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 1) invalidData();
  return value;
}

function secret(value: unknown): string {
  const bytes = decodeBase64Url(value, 32, 32);
  try {
    if (bytes.every((byte) => byte === bytes[0])) invalidData();
    return value as string;
  } finally {
    bytes.fill(0);
  }
}

function random(size: number): Bytes {
  return globalThis.crypto.getRandomValues(new Uint8Array(size));
}

function randomSecret(): string {
  const bytes = random(32);
  try {
    return encodeBase64Url(bytes);
  } finally {
    bytes.fill(0);
  }
}

function validatedCode(value: unknown): HouseholdCode {
  const input = record(value, CODE_FIELDS);
  if (input.v !== 1) invalidData();
  return { v: 1, householdId: identifier(input.householdId), generation: identifier(input.generation), keyVersion: version(input.keyVersion), secret: secret(input.secret) };
}

function validatedRing(value: unknown, code?: HouseholdCode): KeyRing {
  const input = record(value, RING_FIELDS);
  if (input.v !== 1 || !Array.isArray(input.keys) || input.keys.length < 1 || input.keys.length > 4096) invalidData();
  const householdId = identifier(input.householdId);
  const generation = identifier(input.generation);
  const currentKeyVersion = version(input.currentKeyVersion);
  const seen = new Set<string>();
  const seenSecrets = new Set<string>();
  const keys = input.keys.map((value) => {
    const entry = record(value, ["generation", "keyVersion", "secret"]);
    const key = { generation: identifier(entry.generation), keyVersion: version(entry.keyVersion), secret: secret(entry.secret) };
    const identity = `${key.generation}:${key.keyVersion}`;
    if (seen.has(identity) || seenSecrets.has(key.secret) || key.secret === code?.secret) invalidData();
    seen.add(identity);
    seenSecrets.add(key.secret);
    return key;
  });
  if (!keys.some((key) => key.generation === generation && key.keyVersion === currentKeyVersion)) invalidData();
  if (code && (householdId !== code.householdId || generation !== code.generation || currentKeyVersion !== code.keyVersion)) invalidData();
  return { v: 1, householdId, generation, currentKeyVersion, keys };
}

function revisionId(value: unknown): string {
  if (typeof value !== "string" || !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(value)) invalidData();
  return value;
}

function validatedContext(value: EntityContext): Required<Omit<EntityContext, "revision">> & Pick<EntityContext, "revision"> {
  const input = record(value, CONTEXT_FIELDS);
  const optional = (value: unknown) => value === undefined || value === null ? null : identifier(value);
  return {
    householdId: identifier(input.householdId), model: identifier(input.model), id: identifier(input.id),
    ledgerId: optional(input.ledgerId), actorMemberId: optional(input.actorMemberId), createdByMemberId: optional(input.createdByMemberId),
    ...(input.revision === undefined ? {} : { revision: revisionId(input.revision) }),
  };
}

function aad(value: unknown): Bytes {
  return encodeUtf8(canonicalJson({ domain: DOMAIN, ...value as Record<string, unknown> }, 16384));
}

async function deriveKey(encodedSecret: string, salt: Bytes, purpose: string, binding: unknown, algorithm: "AES-GCM" | "HMAC"): Promise<CryptoKey> {
  const bytes = decodeBase64Url(encodedSecret, 32, 32);
  try {
    const key = await globalThis.crypto.subtle.importKey("raw", bytes, "HKDF", false, ["deriveKey"]);
    return await globalThis.crypto.subtle.deriveKey(
      { name: "HKDF", hash: "SHA-256", salt, info: aad({ purpose, binding }) }, key,
      algorithm === "AES-GCM" ? { name: "AES-GCM", length: 256 } : { name: "HMAC", hash: "SHA-256", length: 256 },
      false, algorithm === "AES-GCM" ? ["encrypt", "decrypt"] : ["sign"],
    );
  } finally {
    bytes.fill(0);
  }
}

async function encrypt(key: CryptoKey, nonce: Bytes, additionalData: Bytes, plaintext: Bytes): Promise<Bytes> {
  return new Uint8Array(await globalThis.crypto.subtle.encrypt({ name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 }, key, plaintext));
}

async function decrypt(key: CryptoKey, nonce: Bytes, additionalData: Bytes, ciphertext: Bytes): Promise<Bytes> {
  return new Uint8Array(await globalThis.crypto.subtle.decrypt({ name: "AES-GCM", iv: nonce, additionalData, tagLength: 128 }, key, ciphertext));
}

export function createHouseholdCode(householdId: string, generation: string = globalThis.crypto.randomUUID(), keyVersion = 1): HouseholdCode {
  return checked(() => ({ v: 1, householdId: identifier(householdId), generation: identifier(generation), keyVersion: version(keyVersion), secret: randomSecret() }));
}

export function encodeHouseholdCode(code: HouseholdCode): string {
  return checked(() => frame("BBK1", validatedCode(code), MAX_CODE_BYTES));
}

export function parseHouseholdCode(text: string): HouseholdCode {
  return checked(() => validatedCode(unframe("BBK1", text, MAX_CODE_BYTES)));
}

export function createKeyRing(code: HouseholdCode, previous?: KeyRing): KeyRing {
  return checked(() => {
    const current = validatedCode(code);
    const prior = previous ? validatedRing(previous) : undefined;
    if (prior && (prior.householdId !== current.householdId
      || (prior.generation === current.generation && current.keyVersion <= prior.currentKeyVersion)
      || (prior.generation !== current.generation && prior.keys.some((key) => key.generation === current.generation)))) invalidData();
    const keys = [...prior?.keys ?? [], { generation: current.generation, keyVersion: current.keyVersion, secret: randomSecret() }];
    return validatedRing({ v: 1, householdId: current.householdId, generation: current.generation, currentKeyVersion: current.keyVersion, keys }, current);
  });
}

async function sealRing(inputCode: HouseholdCode, inputRing: KeyRing, purpose: "key-ring" | "recovery"): Promise<string> {
  const code = validatedCode(inputCode);
  const ring = validatedRing(inputRing, code);
  const salt = random(32);
  const nonce = random(12);
  const header = { v: 1, purpose, householdId: code.householdId, generation: code.generation, keyVersion: code.keyVersion, salt: encodeBase64Url(salt), nonce: encodeBase64Url(nonce) };
  const plaintext = encodeUtf8(canonicalJson(ring, MAX_KEY_RING_BYTES));
  try {
    const key = await deriveKey(code.secret, salt, purpose, { householdId: code.householdId, generation: code.generation, keyVersion: code.keyVersion }, "AES-GCM");
    const ciphertext = await encrypt(key, nonce, aad(header), plaintext);
    return frame(purpose === "key-ring" ? "BBR1" : "BBP1", { ...header, ciphertext: encodeBase64Url(ciphertext) }, MAX_KEY_RING_ENVELOPE_BYTES);
  } finally {
    plaintext.fill(0);
  }
}

function keyEnvelope(sealed: string, purpose: "key-ring" | "recovery") {
  const input = record(unframe(purpose === "key-ring" ? "BBR1" : "BBP1", sealed, MAX_KEY_RING_ENVELOPE_BYTES), KEY_ENVELOPE_FIELDS);
  if (input.v !== 1 || input.purpose !== purpose) invalidData();
  const householdId = identifier(input.householdId), generation = identifier(input.generation), keyVersion = version(input.keyVersion);
  const salt = decodeBase64Url(input.salt, 32, 32);
  const nonce = decodeBase64Url(input.nonce, 12, 12);
  const ciphertext = decodeBase64Url(input.ciphertext, MAX_KEY_RING_BYTES + 16);
  if (ciphertext.length < 16) invalidData();
  return { input, householdId, generation, keyVersion, salt, nonce, ciphertext };
}

export function describeKeyRing(sealed: string): { householdId: string; generation: string; keyVersion: number } {
  return checked(() => {
    const { householdId, generation, keyVersion } = keyEnvelope(sealed, "key-ring");
    return { householdId, generation, keyVersion };
  });
}

async function openRing(inputCode: HouseholdCode, sealed: string, purpose: "key-ring" | "recovery"): Promise<KeyRing> {
  const code = validatedCode(inputCode);
  const { input, householdId, generation, keyVersion, salt, nonce, ciphertext } = keyEnvelope(sealed, purpose);
  if (householdId !== code.householdId || generation !== code.generation || keyVersion !== code.keyVersion) invalidData();
  const { ciphertext: omitted, ...header } = input;
  void omitted;
  const key = await deriveKey(code.secret, salt, purpose, { householdId: code.householdId, generation: code.generation, keyVersion: code.keyVersion }, "AES-GCM");
  const plaintext = await decrypt(key, nonce, aad(header), ciphertext);
  try {
    return validatedRing(parseCanonicalJson(plaintext, MAX_KEY_RING_BYTES), code);
  } finally {
    plaintext.fill(0);
  }
}

export function sealKeyRing(code: HouseholdCode, ring: KeyRing): Promise<string> {
  return guarded(() => sealRing(code, ring, "key-ring"));
}

export function openKeyRing(code: HouseholdCode, sealed: string): Promise<KeyRing> {
  return guarded(() => openRing(code, sealed, "key-ring"));
}

export function exportRecoveryPackage(code: HouseholdCode, ring: KeyRing): Promise<string> {
  return guarded(() => sealRing(code, ring, "recovery"));
}

export function openRecoveryPackage(code: HouseholdCode, sealed: string): Promise<KeyRing> {
  return guarded(() => openRing(code, sealed, "recovery"));
}

export function sealEntity(inputRing: KeyRing, inputContext: EntityContext, payload: unknown): Promise<string> {
  return guarded(async () => {
    const ring = validatedRing(inputRing);
    const context = validatedContext(inputContext);
    if (ring.householdId !== context.householdId) invalidData();
    const wrapping = ring.keys.find((key) => key.generation === ring.generation && key.keyVersion === ring.currentKeyVersion)!;
    const contentKey = random(32);
    let plaintext: Bytes | undefined;
    try {
      plaintext = encodeUtf8(canonicalJson(payload, MAX_ENTITY_JSON_BYTES));
      const salt = random(32);
      const nonce = random(12);
      const keyNonce = random(12);
      const header = {
        v: 1, purpose: "entity", householdId: context.householdId, generation: ring.generation, keyVersion: ring.currentKeyVersion,
        revision: context.revision ?? globalThis.crypto.randomUUID(), salt: encodeBase64Url(salt), nonce: encodeBase64Url(nonce), keyNonce: encodeBase64Url(keyNonce),
      };
      const wrappingKey = await deriveKey(wrapping.secret, salt, "entity-key", { context, header }, "AES-GCM");
      const wrappedKey = encodeBase64Url(await encrypt(wrappingKey, keyNonce, aad({ purpose: "entity-key", context, header }), contentKey));
      const key = await globalThis.crypto.subtle.importKey("raw", contentKey, { name: "AES-GCM" }, false, ["encrypt"]);
      const ciphertext = await encrypt(key, nonce, aad({ purpose: "entity-content", context, header, wrappedKey }), plaintext);
      return frame("BBE1", { ...header, wrappedKey, ciphertext: encodeBase64Url(ciphertext) }, MAX_ENTITY_ENVELOPE_BYTES);
    } finally {
      contentKey.fill(0);
      plaintext?.fill(0);
    }
  });
}

export function openEntity(inputRing: KeyRing, inputContext: EntityContext, sealed: string): Promise<unknown> {
  return guarded(async () => {
    const ring = validatedRing(inputRing);
    const context = validatedContext(inputContext);
    const input = record(unframe("BBE1", sealed, MAX_ENTITY_ENVELOPE_BYTES), ENTITY_ENVELOPE_FIELDS);
    if (input.v !== 1 || input.purpose !== "entity" || input.householdId !== ring.householdId || input.householdId !== context.householdId) invalidData();
    const generation = identifier(input.generation);
    const keyVersion = version(input.keyVersion);
    const revision = revisionId(input.revision);
    if (context.revision !== undefined && context.revision !== revision) invalidData();
    const wrapping = ring.keys.find((key) => key.generation === generation && key.keyVersion === keyVersion);
    if (!wrapping) invalidData();
    const salt = decodeBase64Url(input.salt, 32, 32);
    const nonce = decodeBase64Url(input.nonce, 12, 12);
    const keyNonce = decodeBase64Url(input.keyNonce, 12, 12);
    const wrappedKeyBytes = decodeBase64Url(input.wrappedKey, 48, 48);
    const ciphertext = decodeBase64Url(input.ciphertext, MAX_ENTITY_JSON_BYTES + 16);
    if (ciphertext.length < 16) invalidData();
    const { wrappedKey, ciphertext: omitted, ...header } = input;
    void omitted;
    const wrappingKey = await deriveKey(wrapping.secret, salt, "entity-key", { context, header }, "AES-GCM");
    const contentKey = await decrypt(wrappingKey, keyNonce, aad({ purpose: "entity-key", context, header }), wrappedKeyBytes);
    try {
      if (contentKey.length !== 32) invalidData();
      const key = await globalThis.crypto.subtle.importKey("raw", contentKey, { name: "AES-GCM" }, false, ["decrypt"]);
      const plaintext = await decrypt(key, nonce, aad({ purpose: "entity-content", context, header, wrappedKey }), ciphertext);
      try {
        return parseCanonicalJson(plaintext, MAX_ENTITY_JSON_BYTES);
      } finally {
        plaintext.fill(0);
      }
    } finally {
      contentKey.fill(0);
    }
  });
}

async function indexFor(ring: KeyRing, wrapping: KeyRing["keys"][number], purpose: string, plaintext: Bytes): Promise<string> {
  const binding = { householdId: ring.householdId, generation: wrapping.generation, keyVersion: wrapping.keyVersion };
  const key = await deriveKey(wrapping.secret, aad(binding), `index:${purpose}`, binding, "HMAC");
  return `BBI1.${encodeBase64Url(new Uint8Array(await globalThis.crypto.subtle.sign("HMAC", key, plaintext)))}`;
}

function validatedPurpose(purpose: string): string {
  if (typeof purpose !== "string" || !/^[A-Za-z0-9][A-Za-z0-9_.:/-]{0,127}$/.test(purpose)) invalidData();
  return purpose;
}

export function opaqueIndex(inputRing: KeyRing, purpose: string, value: unknown): Promise<string> {
  return guarded(async () => {
    const ring = validatedRing(inputRing);
    const selectedPurpose = validatedPurpose(purpose);
    const plaintext = encodeUtf8(canonicalJson(value, MAX_ENTITY_JSON_BYTES));
    try {
      return await indexFor(ring, ring.keys.find((key) => key.generation === ring.generation && key.keyVersion === ring.currentKeyVersion)!, selectedPurpose, plaintext);
    } finally {
      plaintext.fill(0);
    }
  });
}

export function opaqueIndexes(inputRing: KeyRing, purpose: string, value: unknown): Promise<string[]> {
  return guarded(async () => {
    const ring = validatedRing(inputRing);
    const selectedPurpose = validatedPurpose(purpose);
    const plaintext = encodeUtf8(canonicalJson(value, MAX_ENTITY_JSON_BYTES));
    try {
      const current = ring.keys.find((key) => key.generation === ring.generation && key.keyVersion === ring.currentKeyVersion)!;
      const ordered = [current, ...ring.keys.filter((key) => key !== current)];
      const indexes: string[] = [];
      for (const key of ordered) indexes.push(await indexFor(ring, key, selectedPurpose, plaintext));
      return [...new Set(indexes)];
    } finally {
      plaintext.fill(0);
    }
  });
}
