import { describe, expect, test } from "vitest";
import { androidVersionCode, validateAndroidOrigin, redactBuildOutput } from "../../ops/android/build-config.mjs";

describe("Android release configuration", () => {
  test("accepts a canonical HTTPS root without carrying credentials or URL state", () => {
    expect(validateAndroidOrigin("https://billboard.example/")).toBe("https://billboard.example");
    expect(validateAndroidOrigin("https://billboard.example:8443")).toBe("https://billboard.example:8443");
  });

  test.each([
    "http://billboard.example", "https://user:password@billboard.example", "https://billboard.example/app",
    "https://billboard.example/?token=private", "https://billboard.example/#fragment", "javascript:alert(1)",
    "https://billboard.example\\@evil.example", "https://billboard.example\n", "https://<private-host>",
  ])("rejects unsafe or non-root release origins without echoing them", (origin) => {
    expect(() => validateAndroidOrigin(origin)).toThrow("Android origin must be an HTTPS root URL without credentials, query or fragment");
  });

  test("keeps Android version codes ordered across patch and feature releases", () => {
    expect(androidVersionCode("1.46.0")).toBe(1_046_000);
    expect(androidVersionCode("1.46.0")).toBeGreaterThan(androidVersionCode("1.45.999"));
    expect(androidVersionCode("2.0.0")).toBeGreaterThan(androidVersionCode("1.999.999"));
  });

  test.each(["v1.2.3", "1.1000.0", "1.2.-1", "1.2.3-beta", "2148.0.0"])("rejects unrepresentable versions: %s", (version) => {
    expect(() => androidVersionCode(version)).toThrow("Project version cannot be represented as an Android versionCode");
  });

  test("redacts both an origin and its hostname plus signing secrets from build failures", () => {
    const output = "https://private.example/login private.example password-123 signing-file.p12";
    expect(redactBuildOutput(output, ["https://private.example", "password-123", "signing-file.p12"]))
      .toBe("<redacted>/login <redacted> <redacted> <redacted>");
  });
});
