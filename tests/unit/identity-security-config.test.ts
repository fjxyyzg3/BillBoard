import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import getNextConfig from "../../next.config";

const names = ["APP_PUBLIC_ORIGIN", "SMTP_HOST", "SMTP_PORT", "SMTP_SECURE", "SMTP_USER", "SMTP_PASSWORD", "SMTP_FROM_EMAIL"];
const read = (file: string) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");

describe("identity deployment boundary", () => {
  it("injects account email settings at runtime into web and local OPS, without giving them to the AI agent or build", () => {
    const compose = read("compose.yml");
    const web = compose.split("  web:\n")[1].split("  import-agent:")[0];
    const agent = compose.split("  import-agent:\n")[1].split("  bootstrap:")[0];
    const script = read("ops/windows/start-production.ps1");
    const ops = script.split("function Start-OpsAdmin")[1].split("\ntry {")[0];
    const redactions = script.split("function Set-LogRedactions")[1].split("function Assert-RequiredProductionSecret")[0];
    for (const name of names) {
      expect(web).toContain(`${name}: \${${name}:-}`);
      expect(agent).not.toContain(name);
      expect(read("Containerfile")).not.toContain(name);
      expect(ops).toContain(`"${name}"`);
      expect(redactions).toContain(`"${name}"`);
      expect(read(".env.example")).toMatch(new RegExp(`^${name}=`, "m"));
    }
    expect(ops).not.toMatch(/SMTP_PASSWORD=\$/);
  });

  it("prevents account links from becoming cached documents or referrer data", async () => {
    const config = await getNextConfig("phase-development-server");
    const rules = await (typeof config.headers === "function" ? config.headers() : []);
    for (const path of ["/account-link", "/forgot-password", "/account/:path*"]) {
      const headers = rules.find((rule) => rule.source === path)?.headers;
      expect(headers).toEqual(expect.arrayContaining([
        { key: "Referrer-Policy", value: "no-referrer" },
        { key: "Cache-Control", value: "no-store" },
        { key: "X-Robots-Tag", value: "noindex, nofollow" },
      ]));
    }
  });
});
