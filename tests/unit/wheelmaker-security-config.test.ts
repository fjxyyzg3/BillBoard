import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const read = (file: string) => readFileSync(file, "utf8").replaceAll("\r\n", "\n");

describe("WheelMaker runtime isolation", () => {
  it("gives the external endpoint and key only to the Agent at runtime", () => {
    const compose = read("compose.yml");
    const web = compose.split("  web:\n")[1].split("  import-agent:\n")[0];
    const agent = compose.split("  import-agent:\n")[1].split("  bootstrap:\n")[0];
    const build = read("Containerfile");
    for (const name of ["WHEELMAKER_BASE_URL", "WHEELMAKER_API_KEY"]) {
      expect(agent).toContain(`${name}: \${${name}:?${name} is required}`);
      expect(web).not.toContain(name);
      expect(compose.match(new RegExp(`^\\s+${name}:`, "gm"))).toHaveLength(1);
      expect(build).not.toContain(name);
      expect(read(".env.example")).toMatch(new RegExp(`^${name}=$`, "m"));
    }
    expect(agent).not.toContain("DATABASE_URL");
    expect(agent).not.toContain("AUTH_SECRET");
    expect(agent).not.toMatch(/^    (ports|volumes):/m);
    expect(agent).not.toContain("      - default");
    expect(agent).toContain("      - agent-egress");
    expect(agent).toContain("      - agent-backend");
    expect(compose).toContain("  agent-backend:\n    internal: true");
    expect(agent).toContain("    read_only: true");
    expect(agent).toContain("    cap_drop:\n      - ALL");
    expect(build.split("FROM deps AS agent")[1].split("FROM deps AS builder")[0]).toContain("USER node");
  });

  it("has no installed CLI or retired backend configuration", () => {
    const pkg = JSON.parse(read("package.json"));
    expect(Object.keys(pkg.dependencies)).not.toContain("@agentclientprotocol/codex-acp");
    expect(Object.keys(pkg.dependencies)).not.toContain("@agentclientprotocol/sdk");
    for (const file of ["compose.yml", "Containerfile", ".env.example", "agent/provider.ts"]) {
      expect(read(file)).not.toMatch(/DEEPSEEK_|IMPORT_AGENT_PROVIDER|import-agent-auth|CODEX_HOME|codex-acp/);
    }
  });

  it("redacts both private endpoint and key from startup logs", () => {
    const script = read("ops/windows/start-production.ps1");
    const redactions = script.split("function Set-LogRedactions")[1].split("function Assert-RequiredProductionSecret")[0];
    for (const name of ["WHEELMAKER_BASE_URL", "WHEELMAKER_API_KEY"]) expect(redactions).toContain(`"${name}"`);
    expect(script).toContain('Assert-RequiredProductionSecret -Name "WHEELMAKER_API_KEY"');
  });
});
