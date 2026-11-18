import { createHash, randomUUID } from "node:crypto";
import { expect, it } from "vitest";
import { canonicalJson } from "@/lib/encryption/codec";
import { verifyFinancialSnapshot } from "@/lib/encryption/recovery";

const legacyModels = ["transaction", "ledger", "importDraft", "importDraftRow", "importCategoryMapping", "importMemberMapping", "naturalLanguageRequest", "voiceProcessingAdmission", "appEvent"];
const hash = (value: unknown) => createHash("sha256").update(canonicalJson(value, 4 * 1024 * 1024)).digest("hex");
function legacyBundle() {
  const tables = Object.fromEntries(legacyModels.map((model) => [model, []]));
  const source = { mode: "UNENCRYPTED", revision: 0, generation: null, keyVersion: 0 };
  const snapshot = { v: 1, id: randomUUID(), householdId: randomUUID(), capturedAt: new Date().toISOString(), source, tables };
  const base = { v: 1, snapshotId: snapshot.id, householdId: snapshot.householdId, source, snapshotDigest: hash(snapshot), counts: Object.fromEntries(legacyModels.map((model) => [model, 0])), requiredKeys: [] };
  const proof = { v: 1, baseDigest: hash(base), contentDigest: hash(tables), groupsDigest: hash([]), groupCount: 0 };
  const manifest = { ...base, proof: { kind: "PLAINTEXT", payload: proof } };
  return { snapshot, manifest, manifestDigest: hash(manifest) };
}

it("verifies the original v1 proof before adding empty analysis entities internally", async () => {
  const bundle = legacyBundle();
  const encoded = JSON.stringify(bundle);
  expect(await verifyFinancialSnapshot(bundle, { expectedManifestDigest: bundle.manifestDigest })).toMatchObject({ verified: true, groupCount: 0 });
  expect(JSON.stringify(bundle)).toBe(encoded);
  bundle.snapshot.capturedAt = new Date(Date.parse(bundle.snapshot.capturedAt) + 1).toISOString();
  await expect(verifyFinancialSnapshot(bundle, { expectedManifestDigest: bundle.manifestDigest })).rejects.toMatchObject({ code: "RECOVERY_MISMATCH" });
});

it("cannot reinterpret a v2 package with its analysis tables removed as v1", async () => {
  const bundle = legacyBundle();
  bundle.snapshot.v = 2;
  bundle.manifest.v = 2;
  await expect(verifyFinancialSnapshot(bundle, { expectedManifestDigest: bundle.manifestDigest })).rejects.toMatchObject({ code: "RECOVERY_INVALID" });
});
