import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { processingServices } from "@/lib/processing/preferences";

beforeEach(() => {
  vi.stubEnv("VOLCENGINE_ASR_API_KEY", "");
});
afterEach(() => { vi.unstubAllEnvs(); });

describe("public processing service metadata", () => {
  it("describes WheelMaker without disclosing provider credentials or addresses", () => {
    vi.stubEnv("IMPORT_AGENT_TOKEN", "synthetic-agent-credential");
    vi.stubEnv("WHEELMAKER_API_KEY", "synthetic-wheelmaker-credential");
    vi.stubEnv("VOLCENGINE_ASR_API_KEY", "synthetic-speech-credential");
    vi.stubEnv("IMPORT_AGENT_URL", "https://agent.example.com/private");
    vi.stubEnv("WHEELMAKER_BASE_URL", "https://wheelmaker.example.com/private");
    vi.stubEnv("APP_PUBLIC_ORIGIN", "https://app.example.com");
    const services = processingServices();
    expect(services).toEqual({ primary: "wheelmaker", speechConfigured: true });
    expect(Object.keys(services).sort()).toEqual(["primary", "speechConfigured"]);
    expect(JSON.stringify(services)).not.toMatch(/credential|example\.com|API_KEY|TOKEN/);
  });

  it("describes the text service independently of speech configuration", () => {
    expect(processingServices()).toEqual({ primary: "wheelmaker", speechConfigured: false });
  });

  it.each(["codex", "deepseek", " DEEPSEEK ", "unknown-provider", ""])("ignores the removed provider selection %j and fallback settings", (provider) => {
    vi.stubEnv("IMPORT_AGENT_PROVIDER", provider);
    vi.stubEnv("PROCESSING_DEEPSEEK_ENABLED", "true");
    vi.stubEnv("DEEPSEEK_API_KEY", "synthetic-deepseek-credential");
    expect(processingServices()).toEqual({ primary: "wheelmaker", speechConfigured: false });
  });

  it.each(["", " ", "\n\t"])("reports whitespace speech configuration as unavailable", (value) => {
    vi.stubEnv("VOLCENGINE_ASR_API_KEY", value);
    expect(processingServices().speechConfigured).toBe(false);
  });
});
