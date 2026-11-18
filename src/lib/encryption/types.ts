export type EncryptionMode = "UNENCRYPTED" | "ENABLING" | "ENCRYPTED" | "DISABLING";
export type EncryptionInput = { code: string; revision: number };
export type EncryptionStatus = {
  mode: EncryptionMode;
  revision: number;
  generation: string | null;
  keyVersion: number;
  isOwner: boolean;
  operation: { id: string; kind: string; status: string; expiresAt: string } | null;
};

export class EncryptionRequestError extends Error {
  constructor(readonly code: "ENCRYPTION_REQUIRED" | "ENCRYPTION_CHANGED" | "ENCRYPTION_BUSY" | "ENCRYPTION_EXPIRED" | "ENCRYPTION_BUDGET" | "ENCRYPTION_INVALID") {
    super(code);
    this.name = "EncryptionRequestError";
  }
}
