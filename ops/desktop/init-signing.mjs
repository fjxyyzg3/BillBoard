import { initializeDesktopSigning } from "./build-config.mjs";
import { desktopConfiguration, repositoryRoots, reportDesktopFailure } from "./environment.mjs";

try {
  const config = desktopConfiguration();
  const key = initializeDesktopSigning(config.BILLBOARD_DESKTOP_UPDATE_PRIVATE_KEY_FILE, { repositoryRoots: repositoryRoots() });
  process.stdout.write(`Persistent Ed25519 update key created. Back up the key and .env.desktop.local privately before first distribution.\nPublic key SHA-256: ${key.publicKeyFingerprint}\n`);
} catch (error) {
  reportDesktopFailure(error, "Desktop signing initialization failed; inspect the private configuration and Windows ACL");
}
