export function formatAppVersion(version: string | undefined) {
  const normalizedVersion = version?.trim() || "0.0.0";

  return `v${normalizedVersion}`;
}
