import { createRequire } from "node:module";
import { describe, expect, it } from "vitest";
import {
  IMPORT_AGENT_SCHEMA_VERSION,
  MAX_AGENT_GROUPS,
  importAgentResponseSchema,
} from "../../src/lib/imports/agent-protocol";
import {
  MAX_NATURAL_LANGUAGE_TRANSACTIONS,
  NATURAL_LANGUAGE_SCHEMA_VERSION,
  naturalLanguageResponseSchema,
} from "../../src/lib/transactions/natural-language-protocol";

const requireFromTypeScript = createRequire(import.meta.resolve("@typescript-eslint/typescript-estree"));
const minimatch = requireFromTypeScript("minimatch") as {
  minimatch(file: string, pattern: string, options: { dot: boolean }): boolean;
  Minimatch: new (pattern: string, options: { optimizationLevel: number; braceExpandMax: number }) => {
    globParts: string[][];
  };
};

describe("TypeScript glob dependency", () => {
  it("bounds glob preprocessing without changing the named matching API", () => {
    const pattern = `${Array(7).fill("**/../a").join("/")}/file.ts`;
    const matcher = new minimatch.Minimatch(pattern, { optimizationLevel: 2, braceExpandMax: 8 });

    expect(matcher.globParts.length).toBeLessThanOrEqual(8);
    expect(minimatch.minimatch("src/.fixtures/sample.ts", "**/*.ts", { dot: true })).toBe(true);
    expect(minimatch.minimatch("src/.fixtures/sample.js", "**/*.ts", { dot: true })).toBe(false);
  });
});

describe("bounded schema validation", () => {
  it("rejects an oversized import suggestion collection before validating every element", () => {
    const result = importAgentResponseSchema.safeParse({
      schemaVersion: IMPORT_AGENT_SCHEMA_VERSION,
      suggestions: Array(MAX_AGENT_GROUPS + 1).fill(null),
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected an oversized collection to be rejected");
    expect(result.error.issues).toEqual([
      expect.objectContaining({ code: "too_big", path: ["suggestions"], maximum: MAX_AGENT_GROUPS }),
    ]);
  });

  it("rejects an oversized natural-language collection before validating every element", () => {
    const result = naturalLanguageResponseSchema.safeParse({
      schemaVersion: NATURAL_LANGUAGE_SCHEMA_VERSION,
      outcome: "success",
      transactions: Array(MAX_NATURAL_LANGUAGE_TRANSACTIONS + 1).fill(null),
    });

    expect(result.success).toBe(false);
    if (result.success) throw new Error("Expected an oversized collection to be rejected");
    expect(result.error.issues).toEqual([
      expect.objectContaining({ code: "too_big", path: ["transactions"], maximum: MAX_NATURAL_LANGUAGE_TRANSACTIONS }),
    ]);
  });
});
