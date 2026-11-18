import { createCipheriv, createDecipheriv, randomBytes } from "node:crypto";
import { RecordExportError } from "./input";
const MAGIC = Buffer.from("BBEF1\n");
export const ENCRYPTED_EXPORT_OVERHEAD = MAGIC.length + 12 + 16;
export function exportCipher(key: Buffer) {
  if (key.length !== 32) throw new RecordExportError("unavailable");
  const nonce = randomBytes(12), cipher = createCipheriv("aes-256-gcm", key, nonce);
  cipher.setAAD(MAGIC);
  return { cipher, header: Buffer.concat([MAGIC, nonce]) };
}
export function decryptExportFile(bytes: Buffer, key: Buffer) {
  try {
    if (key.length !== 32 || bytes.length < ENCRYPTED_EXPORT_OVERHEAD || !bytes.subarray(0, MAGIC.length).equals(MAGIC)) throw new Error("Invalid encrypted export");
    const cipher = createDecipheriv("aes-256-gcm", key, bytes.subarray(MAGIC.length, MAGIC.length + 12));
    cipher.setAAD(MAGIC); cipher.setAuthTag(bytes.subarray(-16));
    return Buffer.concat([cipher.update(bytes.subarray(MAGIC.length + 12, -16)), cipher.final()]);
  } catch { throw new RecordExportError("unavailable"); }
}
