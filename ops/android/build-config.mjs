export function validateAndroidOrigin(value) {
  try {
    if (typeof value !== "string" || /[\s\\<>]/.test(value)) throw new Error();
    const url = new URL(value);
    if (url.protocol !== "https:" || !url.hostname || url.username || url.password
      || url.pathname !== "/" || url.search || url.hash || /[?#]/.test(value)) throw new Error();
    return url.origin;
  } catch {
    throw new Error("Android origin must be an HTTPS root URL without credentials, query or fragment");
  }
}

export function androidVersionCode(version) {
  const match = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.exec(version);
  const [major, minor, patch] = match ? match.slice(1).map(Number) : [NaN, NaN, NaN];
  const code = major * 1_000_000 + minor * 1_000 + patch;
  if (!Number.isSafeInteger(code) || code < 1 || code > 2_100_000_000 || minor > 999 || patch > 999) {
    throw new Error("Project version cannot be represented as an Android versionCode");
  }
  return code;
}

export function redactBuildOutput(value, privateValues) {
  const values = new Set(privateValues.filter((item) => typeof item === "string" && item.length >= 4));
  for (const item of values) {
    try { values.add(new URL(item).hostname); } catch { /* Most signing values are not URLs. */ }
  }
  let output = String(value);
  for (const item of [...values].filter(Boolean).sort((a, b) => b.length - a.length)) {
    output = output.replaceAll(item, "<redacted>");
  }
  return output;
}
