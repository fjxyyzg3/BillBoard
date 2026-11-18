import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { parseEnv } from "node:util";
import { androidEnvironment, privateConfigPath, runAndroidTool } from "./environment.mjs";

try {
  const environment = androidEnvironment({ signing: false });
  const config = parseEnv(readFileSync(privateConfigPath, "utf8"));
  const keystore = config.BILLBOARD_ANDROID_KEYSTORE;
  if (!keystore || /[<>\r\n]/.test(keystore)) throw new Error("Set a private BILLBOARD_ANDROID_KEYSTORE path first");
  if (existsSync(keystore)) throw new Error("Keystore already exists; reuse its signing configuration instead of replacing it");
  const password = randomBytes(32).toString("base64url");
  const alias = config.BILLBOARD_ANDROID_KEY_ALIAS || "billboard-release";
  mkdirSync(dirname(keystore), { recursive: true, mode: 0o700 });
  Object.assign(config, {
    BILLBOARD_ANDROID_KEY_ALIAS: alias,
    BILLBOARD_ANDROID_STORE_PASSWORD: password,
    BILLBOARD_ANDROID_KEY_PASSWORD: password,
  });
  const content = Object.entries(config).map(([key, value]) => {
    if (!/^[A-Z_][A-Z0-9_]*$/.test(key) || /["\r\n]/.test(value)) throw new Error("Invalid private configuration entry");
    return `${key}="${value}"`;
  }).join("\n") + "\n";
  // Persist recovery material before generating the key. A failed keytool run can be retried safely.
  writeFileSync(privateConfigPath, content, { mode: 0o600 });
  chmodSync(privateConfigPath, 0o600);
  const signer = {
    ...environment,
    config: { ...environment.config, ...config },
    env: { ...environment.env, ...config },
  };
  const protect = (path) => {
    if (process.platform === "win32") {
      runAndroidTool("icacls.exe", [path, "/inheritance:r", "/grant:r",
        `${process.env.USERDOMAIN}\\${process.env.USERNAME}:(F)`, "*S-1-5-18:(F)"], signer, { showOutput: false });
    } else chmodSync(path, 0o600);
  };
  protect(privateConfigPath);
  runAndroidTool(join(config.JAVA_HOME, "bin", process.platform === "win32" ? "keytool.exe" : "keytool"), [
    "-genkeypair", "-keystore", keystore, "-storetype", "PKCS12", "-alias", alias,
    "-storepass:env", "BILLBOARD_ANDROID_STORE_PASSWORD", "-keypass:env", "BILLBOARD_ANDROID_KEY_PASSWORD",
    "-keyalg", "RSA", "-keysize", "3072", "-sigalg", "SHA256withRSA", "-validity", "10000",
    "-dname", "CN=BillBoard, O=Household", "-noprompt",
  ], signer, { showOutput: false });
  protect(keystore);
  process.stdout.write("Persistent release keystore created. Back up it and .env.android.local privately before distributing the APK.\n");
} catch (error) {
  process.stderr.write(`${error.message}\n`);
  process.exitCode = 1;
}
