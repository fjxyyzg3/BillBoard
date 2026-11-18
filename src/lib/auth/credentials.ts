export const dummyPasswordHash =
  "$argon2id$v=19$m=65536,t=3,p=4$ZAURAOZbICbWQLrybVA7ig$eul4mcFQf6KYdUotMEJgbI3kGr4dZnJ55XR2Si00Hr4";

const maxEmailLength = 254;
const credentialEmailPattern = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export function normalizeCredentialEmail(input: unknown): string | null {
  const email = String(input ?? "")
    .trim()
    .toLowerCase();

  if (email.length === 0 || email.length > maxEmailLength || !credentialEmailPattern.test(email)) {
    return null;
  }

  return email;
}
