export type IdentityResult<T = undefined> = { ok: true; data: T } | { ok: false; code: string };
export type IdentityFormResult = IdentityResult<{ reauthenticate?: boolean; message?: "accepted" | "sent" | "saved" }>;

export type IdentityAccount = {
  email: string;
  displayName: string;
  emailVerifiedAt: string | null;
  hasHousehold: boolean;
};

export type IdentityInvitation = {
  id: string;
  purpose: "PLATFORM" | "HOUSEHOLD";
  email: string;
  expiresAt: string;
  sentAt: string | null;
  consumedAt: string | null;
  revokedAt: string | null;
};
