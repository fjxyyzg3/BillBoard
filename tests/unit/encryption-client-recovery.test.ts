import { describe, expect, it } from "vitest";
import { createHouseholdCode, createKeyRing, encodeHouseholdCode, parseHouseholdCode } from "@/lib/encryption/crypto";
import { createEncryptionCandidate, matchesEncryptionReceipt, readRecoveryFile, restoreEncryptionCandidate } from "@/lib/encryption/client-recovery";
import { decodeViewData, encodeViewData } from "@/lib/encryption/view-data";

const identity = { accountId: "account-1", householdId: "household-1", memberId: "member-1" };

describe("client encryption recovery", () => {
  it("keeps current and candidate codes out of the independently saved encrypted files", async () => {
    const old = createHouseholdCode(identity.householdId);
    const oldCode = encodeHouseholdCode(old);
    const ring = createKeyRing(old);
    const candidate = await createEncryptionCandidate(identity, "ROTATE", 3, oldCode, ring);
    for (const text of [candidate.operationFile, candidate.recoveryFile]) {
      expect(text).not.toContain(oldCode); expect(text).not.toContain(candidate.code);
      expect(text).not.toContain(old.secret);
    }
    expect(await restoreEncryptionCandidate(identity, candidate.code, candidate.operationFile)).toEqual(candidate);
    const recovered = await readRecoveryFile(candidate.code, candidate.recoveryFile);
    expect(recovered.keys).toHaveLength(2);
    expect(recovered.keys[0]).toEqual(ring.keys[0]);
  });

  it("rejects wrong codes, altered files and another original member identity", async () => {
    const candidate = await createEncryptionCandidate(identity, "ENABLE", 0, null);
    const otherCode = encodeHouseholdCode(createHouseholdCode(identity.householdId));
    await expect(restoreEncryptionCandidate(identity, otherCode, candidate.operationFile)).rejects.toThrow();
    await expect(restoreEncryptionCandidate({ ...identity, memberId: "member-new" }, candidate.code, candidate.operationFile)).rejects.toThrow();
    const packet = JSON.parse(candidate.recoveryFile); packet.recoveryDigest = "0".repeat(64);
    await expect(readRecoveryFile(candidate.code, JSON.stringify(packet))).rejects.toThrow();
  });

  it("keeps historical wrapping keys when enabling a fresh encryption cycle", async () => {
    const first = await createEncryptionCandidate(identity, "ENABLE", 0, null);
    const history = await readRecoveryFile(first.code, first.recoveryFile);
    const second = await createEncryptionCandidate(identity, "ENABLE", 5, first.code, history);
    expect(parseGeneration(second.code)).not.toBe(parseGeneration(first.code));
    const recovered = await readRecoveryFile(second.code, second.recoveryFile);
    expect(recovered.keys[0]).toEqual(history.keys[0]);
  });

  it("requires the original candidate metadata before accepting a committed receipt", async () => {
    const candidate = await createEncryptionCandidate(identity, "ENABLE", 3, null);
    const code = parseHouseholdCode(candidate.code);
    const receipt = { id: candidate.id, kind: candidate.kind, status: "COMMITTED", expiresAt: new Date().toISOString(), candidateGeneration: code.generation, candidateKeyVersion: code.keyVersion, recoveryDigest: candidate.recoveryDigest, sourceRevision: 3, barrierRevision: 4 };
    expect(matchesEncryptionReceipt(candidate, receipt)).toBe(true);
    for (const patch of [
      { id: crypto.randomUUID() }, { kind: "ROTATE" }, { candidateGeneration: "another-generation" }, { candidateKeyVersion: 9 },
      { recoveryDigest: "0".repeat(64) }, { sourceRevision: 2 }, { barrierRevision: 3 }, { candidateGeneration: null, candidateKeyVersion: null },
    ]) expect(matchesEncryptionReceipt(candidate, { ...receipt, ...patch })).toBe(false);
    expect(matchesEncryptionReceipt(candidate, { ...receipt, status: "PREPARED", candidateGeneration: null, candidateKeyVersion: null })).toBe(true);
    expect(matchesEncryptionReceipt(candidate, { ...receipt, status: "ABORTED", kind: "CANCELLED", candidateGeneration: null, candidateKeyVersion: null, recoveryDigest: null })).toBe(true);
    expect(matchesEncryptionReceipt(candidate, { ...receipt, status: "ABORTED", recoveryDigest: null })).toBe(false);
  });
});

function parseGeneration(code: string) { return JSON.parse(Buffer.from(code.split(".")[1], "base64url").toString()).generation; }

describe("household view transport", () => {
  it("preserves dates and URL parameters without serializing functions or credential objects", () => {
    const value = { date: new Date("2026-10-22T00:00:00.000Z"), params: new URLSearchParams("ledger=all&member=one"), absent: undefined, amountFen: 123 };
    expect(decodeViewData(JSON.parse(JSON.stringify(encodeViewData(value))))).toEqual(value);
    expect(() => encodeViewData({ format: () => "private" })).toThrow("INVALID_VIEW_DATA");
    for (const key of ["code", "secret", "ring", "passwordHash", "appSessionId", "email"]) expect(() => encodeViewData({ nested: { [key]: "private" } })).toThrow("PRIVATE_VIEW_DATA");
  });
});
