import { describe, expect, it } from "vitest";
import { createDecipheriv, hkdfSync } from "node:crypto";
import * as encryption from "@/lib/encryption/crypto";
import type { KeyRing } from "@/lib/encryption/crypto";

async function loadEncryption() {
  return encryption;
}

function unpack(sealed: string): Record<string, unknown> {
  return JSON.parse(Buffer.from(sealed.slice(sealed.indexOf(".") + 1), "base64url").toString("utf8"));
}

function repack(sealed: string, payload: Record<string, unknown>): string {
  const sorted = Object.fromEntries(Object.entries(payload).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0));
  return `${sealed.split(".")[0]}.${Buffer.from(JSON.stringify(sorted)).toString("base64url")}`;
}

function flip(encoded: unknown): string {
  const bytes = Buffer.from(String(encoded), "base64url");
  bytes[0] ^= 1;
  return bytes.toString("base64url");
}

const context = {
  householdId: "household-1",
  model: "Transaction",
  id: "record-1",
  ledgerId: "ledger-1",
  actorMemberId: "member-1",
  createdByMemberId: "member-2",
};

function referenceJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(referenceJson).join(",")}]`;
  if (value !== null && typeof value === "object") {
    return `{${Object.entries(value).sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([key, item]) => `${JSON.stringify(key)}:${referenceJson(item)}`).join(",")}}`;
  }
  return JSON.stringify(value);
}

function referenceDecrypt(key: Buffer, nonce: unknown, aad: unknown, sealed: unknown): Buffer {
  const ciphertext = Buffer.from(String(sealed), "base64url");
  const decipher = createDecipheriv("aes-256-gcm", key, Buffer.from(String(nonce), "base64url"));
  decipher.setAAD(Buffer.from(referenceJson(aad)));
  decipher.setAuthTag(ciphertext.subarray(-16));
  return Buffer.concat([decipher.update(ciphertext.subarray(0, -16)), decipher.final()]);
}

function referenceContentKey(ring: KeyRing, envelope: Record<string, unknown>): Buffer {
  const { ciphertext, wrappedKey, ...header } = envelope;
  void ciphertext;
  const wrapping = ring.keys.find((key) => key.generation === header.generation && key.keyVersion === header.keyVersion)!;
  const domain = "billboard-household-encryption:v1";
  const info = { domain, purpose: "entity-key", binding: { context, header } };
  const wrappingKey = Buffer.from(hkdfSync("sha256", Buffer.from(wrapping.secret, "base64url"),
    Buffer.from(String(header.salt), "base64url"), Buffer.from(referenceJson(info)), 32));
  return referenceDecrypt(wrappingKey, header.keyNonce, { domain, purpose: "entity-key", context, header }, wrappedKey);
}

describe("household cryptography", () => {
  it("describes only public key-ring metadata and rejects malformed or wrong-purpose envelopes", async () => {
    const code = encryption.createHouseholdCode("household-1"), ring = encryption.createKeyRing(code);
    const sealed = await encryption.sealKeyRing(code, ring);
    expect(encryption.describeKeyRing(sealed)).toEqual({ householdId: code.householdId, generation: code.generation, keyVersion: code.keyVersion });
    expect(JSON.stringify(encryption.describeKeyRing(sealed))).not.toContain(code.secret);
    expect(() => encryption.describeKeyRing(encryption.encodeHouseholdCode(code))).toThrow(encryption.EncryptionError);
    const recovery = await encryption.exportRecoveryPackage(code, ring);
    expect(() => encryption.describeKeyRing(recovery)).toThrow(encryption.EncryptionError);
    const envelope = unpack(sealed);
    for (const mutation of [{ ...envelope, nonce: "short" }, { ...envelope, keyVersion: 0 }, { ...envelope, purpose: "recovery" }, { ...envelope, secret: code.secret }, { ...envelope, ciphertext: "AA" }]) {
      expect(() => encryption.describeKeyRing(repack(sealed, mutation))).toThrow(encryption.EncryptionError);
    }
  });

  it("protects a financial payload and restores it with the household code", async () => {
    const encryption = await loadEncryption();
    const code = encryption.createHouseholdCode("household-1");
    const ring = encryption.createKeyRing(code);
    const payload = { amountFen: 12345, date: "2026-10-22", note: "私人账务", nested: [true, null, { categoryId: "food" }] };
    const sealed = await encryption.sealEntity(ring, context, payload);
    const restoredRing = await encryption.openKeyRing(code, await encryption.sealKeyRing(code, ring));

    expect(await encryption.openEntity(restoredRing, context, sealed)).toEqual(payload);
    expect(sealed).not.toContain(payload.note);
    expect(sealed).not.toContain("12345");
  });

  it("creates distinct 256-bit random codes with a canonical portable representation", async () => {
    const encryption = await loadEncryption();
    const code = encryption.createHouseholdCode("household-1");
    const second = encryption.createHouseholdCode("household-1");
    const encoded = encryption.encodeHouseholdCode(code);
    expect(Buffer.from(code.secret, "base64url")).toHaveLength(32);
    expect(second.secret).not.toBe(code.secret);
    expect(second.generation).not.toBe(code.generation);
    expect(encoded).toMatch(/^BBK1\.[A-Za-z0-9_-]+$/);
    expect(encryption.parseHouseholdCode(encoded)).toEqual(code);
    expect(encryption.encodeHouseholdCode(encryption.parseHouseholdCode(encoded))).toBe(encoded);
  });

  it("rejects weak, malformed, oversized and noncanonical codes without echoing their input", async () => {
    const encryption = await loadEncryption();
    const code = encryption.createHouseholdCode("household-1");
    const valid = encryption.encodeHouseholdCode(code);
    const malformed = [
      "password123", `${valid}=`, `${valid}\n`, valid.replace("BBK1", "BBK2"),
      repack(valid, { ...code, secret: "weak-secret" }),
      repack(valid, { ...code, secret: Buffer.alloc(32).toString("base64url") }),
      repack(valid, { ...code, secret: Buffer.alloc(32, 7).toString("base64url") }),
      repack(valid, { ...code, v: 2 }), repack(valid, { ...code, keyVersion: 0 }),
      repack(valid, { ...code, keyVersion: 1.5 }), repack(valid, { ...code, unknown: true }),
      `BBK1.${Buffer.from(JSON.stringify(code, null, 2)).toString("base64url")}`,
      `BBK1.${"A".repeat(8192)}`,
    ];
    for (const text of malformed) {
      let failure: unknown;
      try {
        encryption.parseHouseholdCode(text);
      } catch (error) {
        failure = error;
      }
      expect(failure).toBeInstanceOf(Error);
      expect((failure as Error).message).not.toContain(code.secret);
      expect((failure as Error).message).not.toContain("weak-secret");
      expect((failure as Error).message).not.toContain("password123");
    }
    expect(() => encryption.createHouseholdCode("", "generation", 1)).toThrow();
    expect(() => encryption.createHouseholdCode("household-1", "generation", Number.MAX_SAFE_INTEGER + 1)).toThrow();
  });

  it("rejects duplicate JSON fields, invalid UTF-8 and invalid base64 trailing bits", async () => {
    const code = encryption.createHouseholdCode("household-1");
    const duplicate = `{"generation":${JSON.stringify(code.generation)},"householdId":"household-2","householdId":"household-1","keyVersion":1,"secret":${JSON.stringify(code.secret)},"v":1}`;
    expect(() => encryption.parseHouseholdCode(`BBK1.${Buffer.from(duplicate).toString("base64url")}`)).toThrow();
    expect(() => encryption.parseHouseholdCode(`BBK1.${Buffer.from([0xff, 0xfe]).toString("base64url")}`)).toThrow();
    expect(() => encryption.parseHouseholdCode("BBK1.Zh")).toThrow();
  });

  it("keeps wrapping keys independent of master codes and retains history after rotation", async () => {
    const encryption = await loadEncryption();
    const oldCode = encryption.createHouseholdCode("household-1", "first-cycle", 1);
    const oldRing = encryption.createKeyRing(oldCode);
    const oldEntity = await encryption.sealEntity(oldRing, context, { amountFen: 109 });
    const newCode = encryption.createHouseholdCode("household-1", "first-cycle", 2);
    const newRing = encryption.createKeyRing(newCode, oldRing);
    expect(newRing.keys).toHaveLength(2);
    expect(newRing.keys[0]).toEqual(oldRing.keys[0]);
    expect(oldRing.keys).toHaveLength(1);
    expect(newRing.keys.map((key: { secret: string }) => key.secret)).not.toContain(oldCode.secret);
    expect(newRing.keys.map((key: { secret: string }) => key.secret)).not.toContain(newCode.secret);
    expect(newRing.keys[0].secret).not.toBe(newRing.keys[1].secret);
    expect(JSON.stringify(newRing)).not.toContain(oldCode.secret);
    const newPackage = await encryption.sealKeyRing(newCode, newRing);
    await expect(encryption.openKeyRing(oldCode, newPackage)).rejects.toThrow();
    const opened = await encryption.openKeyRing(newCode, newPackage);
    expect(await encryption.openEntity(opened, context, oldEntity)).toEqual({ amountFen: 109 });
    const latest = await encryption.sealEntity(opened, context, { amountFen: 110 });
    await expect(encryption.openEntity(oldRing, context, latest)).rejects.toThrow();
    expect(unpack(latest).keyVersion).toBe(2);
  });

  it("uses a fresh generation on re-enable while preserving historical recovery keys", async () => {
    const encryption = await loadEncryption();
    const oldCode = encryption.createHouseholdCode("household-1", "old-cycle", 7);
    const oldRing = encryption.createKeyRing(oldCode);
    const oldEntity = await encryption.sealEntity(oldRing, context, { amountFen: 1 });
    const code = encryption.createHouseholdCode("household-1", "new-cycle", 1);
    const ring = encryption.createKeyRing(code, oldRing);
    const recovery = await encryption.exportRecoveryPackage(code, ring);
    const recovered = await encryption.openRecoveryPackage(code, recovery);
    expect(await encryption.openEntity(recovered, context, oldEntity)).toEqual({ amountFen: 1 });
    expect(recovered.generation).toBe("new-cycle");
    expect(recovered.currentKeyVersion).toBe(1);
    expect(recovered.keys).toHaveLength(2);
    expect(recovery).not.toContain(oldCode.secret);
    await expect(encryption.openRecoveryPackage(oldCode, recovery)).rejects.toThrow();
  });

  it("rejects keyring and recovery purpose substitution even when relabeled", async () => {
    const encryption = await loadEncryption();
    const code = encryption.createHouseholdCode("household-1");
    const ring = encryption.createKeyRing(code);
    const keyRing = await encryption.sealKeyRing(code, ring);
    const recovery = await encryption.exportRecoveryPackage(code, ring);
    await expect(encryption.openKeyRing(code, recovery)).rejects.toThrow();
    await expect(encryption.openRecoveryPackage(code, keyRing)).rejects.toThrow();
    const relabeled = repack(recovery.replace("BBP1", "BBR1"), { ...unpack(recovery), purpose: "key-ring" });
    await expect(encryption.openKeyRing(code, relabeled)).rejects.toThrow();
    await expect(encryption.openKeyRing({ ...code, householdId: "household-2" }, keyRing)).rejects.toThrow();
    await expect(encryption.openKeyRing({ ...code, generation: "changed-cycle" }, keyRing)).rejects.toThrow();
    await expect(encryption.openKeyRing(encryption.createHouseholdCode("household-1", code.generation), keyRing)).rejects.toThrow();
  });

  it.each(["householdId", "model", "id", "ledgerId", "actorMemberId", "createdByMemberId"])("authenticates the entity %s", async (field) => {
    const encryption = await loadEncryption();
    const ring = encryption.createKeyRing(encryption.createHouseholdCode("household-1"));
    const sealed = await encryption.sealEntity(ring, context, { amountFen: 99 });
    await expect(encryption.openEntity(ring, { ...context, [field]: "substituted" }, sealed)).rejects.toThrow();
    await expect(encryption.sealEntity(ring, { ...context, householdId: "household-2" }, {})).rejects.toThrow();
  });

  it("authenticates a caller-supplied entity revision without accepting old ciphertext", async () => {
    const ring = encryption.createKeyRing(encryption.createHouseholdCode("household-1"));
    const bound = { ...context, revision: crypto.randomUUID() };
    const sealed = await encryption.sealEntity(ring, bound, { amountFen: 99 }).catch(() => null);
    expect(sealed, "The adapter revision must be accepted and authenticated").not.toBeNull();
    expect(unpack(sealed!).revision).toBe(bound.revision);
    expect(await encryption.openEntity(ring, bound, sealed!)).toEqual({ amountFen: 99 });
    const changed = { ...bound, revision: crypto.randomUUID() };
    await expect(encryption.openEntity(ring, changed, sealed!)).rejects.toThrow();
    await expect(encryption.openEntity(ring, changed, repack(sealed!, { ...unpack(sealed!), revision: changed.revision }))).rejects.toThrow();
  });

  it.each(["nonce", "keyNonce", "salt", "wrappedKey", "ciphertext"])("rejects tampered entity %s", async (field) => {
    const encryption = await loadEncryption();
    const ring = encryption.createKeyRing(encryption.createHouseholdCode("household-1"));
    const sealed = await encryption.sealEntity(ring, context, { amountFen: 99 });
    const envelope = unpack(sealed);
    await expect(encryption.openEntity(ring, context, repack(sealed, { ...envelope, [field]: flip(envelope[field]) }))).rejects.toThrow();
  });

  it.each(["v", "generation", "keyVersion", "revision"])("rejects tampered entity %s metadata", async (field) => {
    const encryption = await loadEncryption();
    const ring = encryption.createKeyRing(encryption.createHouseholdCode("household-1"));
    const sealed = await encryption.sealEntity(ring, context, { amountFen: 99 });
    const changed = field === "v" || field === "keyVersion" ? 2 : crypto.randomUUID();
    await expect(encryption.openEntity(ring, context, repack(sealed, { ...unpack(sealed), [field]: changed }))).rejects.toThrow();
  });

  it("rejects stripped tags, invalid nonces and extra envelope fields", async () => {
    const encryption = await loadEncryption();
    const ring = encryption.createKeyRing(encryption.createHouseholdCode("household-1"));
    const sealed = await encryption.sealEntity(ring, context, { amountFen: 99 });
    const envelope = unpack(sealed);
    const ciphertext = Buffer.from(String(envelope.ciphertext), "base64url");
    const changedTag = Buffer.from(ciphertext);
    changedTag[changedTag.length - 1] ^= 1;
    for (const changed of [
      { ...envelope, nonce: "AA" }, { ...envelope, wrappedKey: "AA" },
      { ...envelope, ciphertext: ciphertext.subarray(0, -16).toString("base64url") },
      { ...envelope, ciphertext: changedTag.toString("base64url") },
      { ...envelope, extra: "untrusted" }, { ...envelope, ciphertext: `${envelope.ciphertext}=` },
    ]) {
      await expect(encryption.openEntity(ring, context, repack(sealed, changed))).rejects.toThrow();
    }
  });

  it("does not allow content keys or bodies to be spliced between revisions", async () => {
    const encryption = await loadEncryption();
    const ring = encryption.createKeyRing(encryption.createHouseholdCode("household-1"));
    const first = await encryption.sealEntity(ring, context, { amountFen: 1 });
    const second = unpack(await encryption.sealEntity(ring, context, { amountFen: 2 }));
    for (const field of ["ciphertext", "wrappedKey"]) {
      await expect(encryption.openEntity(ring, context, repack(first, { ...unpack(first), [field]: second[field] }))).rejects.toThrow();
    }
  });

  it.each(["nonce", "salt", "ciphertext"])("authenticates the keyring %s", async (field) => {
    const encryption = await loadEncryption();
    const code = encryption.createHouseholdCode("household-1");
    const sealed = await encryption.sealKeyRing(code, encryption.createKeyRing(code));
    const envelope = unpack(sealed);
    await expect(encryption.openKeyRing(code, repack(sealed, { ...envelope, [field]: flip(envelope[field]) }))).rejects.toThrow();
  });

  it("uses fresh data keys, nonces and revisions for repeated writes", async () => {
    const encryption = await loadEncryption();
    const ring = encryption.createKeyRing(encryption.createHouseholdCode("household-1"));
    const first = unpack(await encryption.sealEntity(ring, context, { amountFen: 99 }));
    const second = unpack(await encryption.sealEntity(ring, context, { amountFen: 99 }));
    expect(first.revision).not.toBe(second.revision);
    expect(first.nonce).not.toBe(second.nonce);
    expect(first.keyNonce).not.toBe(second.keyNonce);
    expect(first.wrappedKey).not.toBe(second.wrappedKey);
    expect(first.ciphertext).not.toBe(second.ciphertext);
    const firstKey = referenceContentKey(ring, first);
    const secondKey = referenceContentKey(ring, second);
    expect(firstKey).toHaveLength(32);
    expect(secondKey).toHaveLength(32);
    expect(firstKey.equals(secondKey)).toBe(false);
    const { ciphertext, wrappedKey, ...header } = first;
    const plaintext = referenceDecrypt(firstKey, header.nonce,
      { domain: "billboard-household-encryption:v1", purpose: "entity-content", context, header, wrappedKey }, ciphertext);
    expect(JSON.parse(plaintext.toString("utf8"))).toEqual({ amountFen: 99 });
    firstKey.fill(0);
    secondKey.fill(0);
    plaintext.fill(0);
  });

  it("normalizes omitted optional associations to null and preserves JSON primitives", async () => {
    const encryption = await loadEncryption();
    const ring = encryption.createKeyRing(encryption.createHouseholdCode("household-1"));
    const base = { householdId: "household-1", model: "ImportDraft", id: "draft-1" };
    for (const payload of [null, false, 103, "text", [1, null, "汉字"], { "__proto__": null, value: "x" }]) {
      const sealed = await encryption.sealEntity(ring, base, payload);
      expect(await encryption.openEntity(ring, { ...base, ledgerId: null, actorMemberId: null, createdByMemberId: null }, sealed)).toEqual(payload);
    }
  });

  it("rejects values which JSON would silently lose or convert", async () => {
    const encryption = await loadEncryption();
    const ring = encryption.createKeyRing(encryption.createHouseholdCode("household-1"));
    const circular: Record<string, unknown> = {};
    circular.self = circular;
    for (const payload of [undefined, Number.NaN, Infinity, { invalid: undefined }, [undefined], BigInt(1), new Date(), circular]) {
      await expect(encryption.sealEntity(ring, context, payload)).rejects.toThrow();
    }
  });

  it("bounds escaped UTF-8 and nesting before encryption", async () => {
    const ring = encryption.createKeyRing(encryption.createHouseholdCode("household-1"));
    await expect(encryption.sealEntity(ring, context, "\0".repeat(6 * 1024 * 1024))).rejects.toThrow();
    let nested: unknown = null;
    for (let index = 0; index < 66; index++) nested = [nested];
    await expect(encryption.sealEntity(ring, context, nested)).rejects.toThrow();
  });

  it("rejects cross-family, duplicate, reused and malformed keyrings", async () => {
    const encryption = await loadEncryption();
    const code = encryption.createHouseholdCode("household-1", "cycle", 1);
    const ring = encryption.createKeyRing(code);
    expect(() => encryption.createKeyRing(code, ring)).toThrow();
    expect(() => encryption.createKeyRing(encryption.createHouseholdCode("household-2"), ring)).toThrow();
    for (const invalid of [
      { ...ring, keys: [] }, { ...ring, keys: [ring.keys[0], ring.keys[0]] },
      { ...ring, keys: [{ ...ring.keys[0], secret: code.secret }] },
      { ...ring, householdId: "household-2" }, { ...ring, currentKeyVersion: 7 },
    ]) {
      await expect(encryption.sealKeyRing(code, invalid)).rejects.toThrow();
    }
  });

  it("isolates opaque equality indexes by purpose, household, generation and version", async () => {
    const encryption = await loadEncryption();
    const code = encryption.createHouseholdCode("household-1", "cycle", 1);
    const ring = encryption.createKeyRing(code);
    const first = await encryption.opaqueIndex(ring, "import-fingerprint", "same-sensitive-source");
    expect(await encryption.opaqueIndex(ring, "import-fingerprint", "same-sensitive-source")).toBe(first);
    expect(await encryption.opaqueIndex(ring, "input-summary", "same-sensitive-source")).not.toBe(first);
    expect(await encryption.opaqueIndex(ring, "import-fingerprint", "different-source")).not.toBe(first);
    const rotated = encryption.createKeyRing(encryption.createHouseholdCode("household-1", "cycle", 2), ring);
    expect(await encryption.opaqueIndex(rotated, "import-fingerprint", "same-sensitive-source")).not.toBe(first);
    const other = encryption.createKeyRing(encryption.createHouseholdCode("household-2"));
    expect(await encryption.opaqueIndex(other, "import-fingerprint", "same-sensitive-source")).not.toBe(first);
    expect(first).not.toContain("same-sensitive-source");
    expect(await encryption.opaqueIndexes(rotated, "import-fingerprint", "same-sensitive-source"))
      .toEqual([await encryption.opaqueIndex(rotated, "import-fingerprint", "same-sensitive-source"), first]);
    expect(await encryption.opaqueIndexes(ring, "import-fingerprint", "same-sensitive-source")).toEqual([first]);
  });

  it("accepts a payload above the existing 20 MiB input boundary and rejects above 32 MiB", async () => {
    const encryption = await loadEncryption();
    const ring = encryption.createKeyRing(encryption.createHouseholdCode("household-1"));
    const payload = "x".repeat(20 * 1024 * 1024 + 1);
    const sealed = await encryption.sealEntity(ring, context, payload);
    expect(await encryption.openEntity(ring, context, sealed)).toBe(payload);
    await expect(encryption.sealEntity(ring, context, "x".repeat(32 * 1024 * 1024 + 1))).rejects.toThrow();
  }, 20000);
});
