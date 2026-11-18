import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalJson } from "@/lib/encryption/codec";
import { protectedModels } from "@/lib/encryption/protected-models";
import { verifyFinancialSnapshot } from "@/lib/encryption/recovery";

const originalModels = ["transaction", "ledger", "importDraft", "importDraftRow", "importCategoryMapping", "importMemberMapping", "naturalLanguageRequest", "voiceProcessingAdmission", "appEvent"];
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value, 4 * 1024 * 1024)).digest("hex");
function bundle(version: 1 | 2 | 3) {
  const models = [...originalModels, ...(version >= 2 ? ["billAnalysisReport", "billAnalysisRequest"] : []), ...(version === 3 ? ["billReconciliationApplication"] : [])];
  const tables = Object.fromEntries(models.map((model) => [model, []]));
  const source = { mode: "UNENCRYPTED", revision: 0, generation: null, keyVersion: 0 };
  const snapshot = { v: version, id: randomUUID(), householdId: randomUUID(), capturedAt: new Date().toISOString(), source, tables };
  const base = { v: version, snapshotId: snapshot.id, householdId: snapshot.householdId, source, snapshotDigest: hash(snapshot), counts: Object.fromEntries(models.map((model) => [model, 0])), requiredKeys: [] };
  const proof = { v: 1, baseDigest: hash(base), contentDigest: hash(tables), groupsDigest: hash([]), groupCount: 0 };
  const manifest = { ...base, proof: { kind: "PLAINTEXT", payload: proof } };
  return { snapshot, manifest, manifestDigest: hash(manifest) };
}

it("protects reconciliation receipt payloads with the financial entity set", () => {
  expect(protectedModels).toContain("billReconciliationApplication");
});

it("verifies v3 receipts and only upgrades older fixed entity sets after their original proof", async () => {
  for (const version of [1, 2, 3] as const) {
    const original = bundle(version), encoded = JSON.stringify(original);
    expect(await verifyFinancialSnapshot(original, { expectedManifestDigest: original.manifestDigest })).toMatchObject({ verified: true });
    expect(JSON.stringify(original)).toBe(encoded);
    original.snapshot.capturedAt = new Date(Date.parse(original.snapshot.capturedAt) + 1).toISOString();
    await expect(verifyFinancialSnapshot(original, { expectedManifestDigest: original.manifestDigest })).rejects.toMatchObject({ code: "RECOVERY_MISMATCH" });
  }
});

it("rejects a v3 package missing its receipt entity instead of interpreting it as legacy", async () => {
  const input = bundle(3);
  delete input.snapshot.tables.billReconciliationApplication;
  await expect(verifyFinancialSnapshot(input, { expectedManifestDigest: input.manifestDigest })).rejects.toMatchObject({ code: "RECOVERY_INVALID" });
});
