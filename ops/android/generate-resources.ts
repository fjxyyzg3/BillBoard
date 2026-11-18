import { mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { messages } from "../../src/lib/i18n";
import { repoRoot } from "./environment.mjs";

function xml(value: string) {
  return value.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;")
    .replaceAll("'", "\\'").replaceAll('"', '\\"');
}

for (const [locale, folder] of [["zh-CN", "values"], ["en-US", "values-en"]] as const) {
  const directory = join(repoRoot, "android/app/build/generated/billboard-res", folder);
  mkdirSync(directory, { recursive: true });
  const entries = Object.entries(messages[locale].android).map(([key, value]) => {
    if (!/^[a-z][a-z0-9_]*$/.test(key) || typeof value !== "string") throw new Error("Invalid Android translation entry");
    return `    <string name="${key}" formatted="false">${xml(value)}</string>`;
  });
  writeFileSync(join(directory, "strings.xml"), `<?xml version="1.0" encoding="utf-8"?>\n<resources>\n${entries.join("\n")}\n</resources>\n`);
}
